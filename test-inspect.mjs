#!/usr/bin/env node
import { Builder, By, Key } from 'selenium-webdriver'
import firefox from 'selenium-webdriver/firefox.js'
import { writeFileSync, unlinkSync } from 'node:fs'

const BASE = 'http://localhost:3099'

async function main() {
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(new firefox.Options()).build()
  try {
    // Load app
    await driver.get(BASE); await driver.sleep(3000)
    console.log('Page loaded')

    // Click Connect
    await driver.findElement(By.id('btnConnect')).click(); await driver.sleep(3000)
    
    // Get approval URL
    const au = await driver.executeScript('return document.getElementById("approvalUrl").value')
    console.log('Approval URL:', au)

    // Open approval page in new window
    await driver.switchTo().newWindow('window')
    await driver.get(au)
    await driver.sleep(3000)

    // DUMP THE FULL HTML to understand the page structure
    const html = await driver.executeScript('return document.body.innerHTML')
    writeFileSync('/tmp/approval-page.html', html)
    console.log('\nWrote /tmp/approval-page.html (' + html.length + ' bytes)')

    // Find ALL inputs and buttons
    const inputs = await driver.findElements(By.css('input, textarea'))
    console.log('\nInputs found:', inputs.length)
    for (const inp of inputs) {
      const tag = await inp.getTagName()
      const type = await inp.getAttribute('type').catch(() => '?')
      const name = await inp.getAttribute('name').catch(() => '?')
      const id = await inp.getAttribute('id').catch(() => '?')
      const placeholder = await inp.getAttribute('placeholder').catch(() => '?')
      console.log(`  <${tag}> type=${type} name=${name} id=${id} placeholder="${placeholder}"`)
    }

    const buttons = await driver.findElements(By.css('button, input[type="submit"], input[type="button"]'))
    console.log('\nButtons found:', buttons.length)
    for (const b of buttons) {
      const text = await b.getText().catch(() => '')
      const value = await b.getAttribute('value').catch(() => '')
      const id = await b.getAttribute('id').catch(() => '')
      const cls = await b.getAttribute('class').catch(() => '')
      console.log(`  button: text="${text}" value="${value}" id="${id}" class="${cls}"`)
    }

    // Also dump visible text
    const visible = await driver.executeScript('return document.body.innerText')
    console.log('\nVisible text:\n' + visible.substring(0, 500))

  } finally {
    await driver.quit()
  }
}
main()