// Browser half of the Packet 1 recovery E2E (e2e_recovery.py).
//
// Drives the REAL built Tessera Web app in a real Chromium: a fresh profile
// (a "cleared browser" on a second machine) with only the moneyd session
// cookie, then "I already have an account" -> enter the seed phrase ->
// recovery -> files. It asserts the account's own file is listed and that
// the recovery approval step (indexd's "App password" page) never appears.
//
// Secrets (the phrase, the session cookie) are read from files/env and are
// never written to stdout, the capture log, or the result file.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const shotsDir = process.env.SHOTS_DIR || ''

const pw = await import(pathToFileURL(process.env.PW_CORE).href)
const chromium = pw.chromium || pw.default?.chromium
const frontUrl = process.env.FRONT_URL
const sessionCookie = process.env.SESSION_COOKIE
const phrase = readFileSync(process.env.PHRASE_FILE, 'utf8').trim()
const expectFile = process.env.EXPECT_FILE
const outFile = process.env.OUT_FILE

const result = { ok: false, sawApprovalStep: false, filesText: '', error: '' }
const log = (line) => process.stderr.write('[browser] ' + line + '\n')

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const logs = []
let page = null
try {
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: 'tessera_session',
      value: sessionCookie,
      domain: new URL(frontUrl).hostname,
      path: '/',
      httpOnly: true,
      secure: false,
    },
  ])
  page = await context.newPage()
  // Packet 3: optional screenshots at each key screen (visual proof runs).
  const shot = async (name) => {
    if (!shotsDir) return
    mkdirSync(shotsDir, { recursive: true })
    await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage: true })
    log('shot ' + name)
  }
  page.on('pageerror', (e) => { logs.push('pageerror: ' + e.message); log('pageerror: ' + e.message) })
  page.on('console', (m) => {
    logs.push(m.type() + ': ' + m.text())
    if (m.type() === 'error') log('console.error: ' + m.text())
  })
  if (phrase && phrase.length) {
    page.on('console', (m) => {
      if (m.text().includes(phrase)) throw new Error('phrase leaked to console')
    })
  }

  await page.goto(frontUrl + '/web/', { waitUntil: 'domcontentloaded' })

  // Welcome -> "I already have an account".
  await page.waitForSelector('#welcomeScreen:not(.hidden)', { timeout: 30000 })
  await page.waitForTimeout(300)
  await shot('welcome')
  await page.click('#btnHaveWords')
  await page.waitForSelector('#recoverScreen:not(.hidden)', { timeout: 30000 })
  await page.waitForTimeout(300)
  await shot('recover')

  await page.fill('#recoverPhraseInput', phrase)
  await page.click('#btnRecoverContinue')

  // Wait for the outcome: success (set a password) or the approval step.
  const outcome = await Promise.race([
    page
      .waitForSelector('#setPasswordScreen:not(.hidden)', { timeout: 90000 })
      .then(() => 'password'),
    page
      .waitForSelector('#recoverApprovalStep:not(.hidden)', { timeout: 90000 })
      .then(() => 'approval'),
  ])
  result.sawApprovalStep = outcome === 'approval' || (await page
    .locator('#recoverApprovalStep')
    .evaluate((el) => !el.classList.contains('hidden'))
    .catch(() => false))

  if (outcome === 'approval') {
    result.error = 'recovery fell back to the indexd approval page (App password)'
    throw new Error(result.error)
  }

  // Set a browser password, then land on files.
  await page.waitForTimeout(300)
  await shot('setpassword')
  await page.fill('#newPassword', 'e2e-throwaway-password')
  await page.fill('#newPasswordConfirm', 'e2e-throwaway-password')
  await page.click('#btnSetPassword')

  await page.waitForSelector('#filesScreen:not(.hidden)', { timeout: 60000 })
  await page.waitForFunction(
    (name) => {
      const el = document.querySelector('#fileList')
      return el && el.textContent.includes(name)
    },
    expectFile,
    { timeout: 120000 },
  )
  result.filesText = (await page.textContent('#fileList')) || ''
  await shot('files')
  // Packet 3: the signed-in shell (header + actions) and the account screen.
  const bill = await page.$('#btnBilling:not(.hidden)')
  if (bill) {
    await page.click('#btnBilling')
    await page.waitForTimeout(1200)
    await shot('account')
  }
  result.ok = true
} catch (e) {
  result.error = String(e.message || e)
  try {
    if (!page) throw new Error('no page')
    result.diag = await page.evaluate(() => ({
      desktop: !!(window.tesseraDesktop && window.tesseraDesktop.isDesktop),
      visiblePanels: Array.from(document.querySelectorAll('.panel'))
        .filter((el) => !el.classList.contains('hidden'))
        .map((el) => el.id),
      recoverStatus: (document.getElementById('recoverStatus') || {}).textContent || '',
      recoverPhraseStep: (document.getElementById('recoverPhraseStep') || {}).className || '',
      approvalStepClass: (document.getElementById('recoverApprovalStep') || {}).className || '',
      approvalUrl: (document.getElementById('recoverApprovalUrl') || {}).value || '',
      interceptorInstalled: !!window.___tfi___,
    }))
  } catch (_) {}
  result.logs = logs.slice(-25)
} finally {
  writeFileSync(outFile, JSON.stringify(result))
  await browser.close()
}
if (!result.ok) {
  log('FAILED: ' + result.error)
  process.exit(1)
}
log('ok: file visible after seed-only recovery')
