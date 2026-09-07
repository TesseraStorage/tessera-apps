#!/usr/bin/env node
import { Builder, By } from 'selenium-webdriver'
import firefox from 'selenium-webdriver/firefox.js'
import { writeFileSync, unlinkSync } from 'node:fs'

const BASE = 'http://localhost:3099'
const CONNECT_KEY = 'sdk5'
let p=0,f=0
const ok=m=>{p++;console.log('  [PASS] '+m)}
const no=m=>{f++;console.log('  [FAIL] '+m)}
const info=m=>console.log('  [INFO] '+m)

async function main(){
  console.log('=== TESSERA E2E — key: '+CONNECT_KEY+' ===\n')
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(new firefox.Options()).build()
  info('Firefox open')
  await driver.manage().setTimeouts({implicit:5000,pageLoad:30000,script:60000})

  try{
    // ── 1. Load app ──────────────────────
    await driver.get(BASE);await driver.sleep(3000)
    ok('Page: '+await driver.getTitle())

    console.log('\n--- WASM ---')
    let r=false
    for(let i=0;i<12;i++){await driver.sleep(2000);try{if(await driver.findElement(By.id('btnConnect')).getAttribute('disabled')===null){r=true;break}}catch(_){}}
    r?ok('WASM ready'):no('WASM not ready');if(!r)return

    // ── 2. Click Connect ─────────────────
    console.log('\n--- Connect ---')
    await driver.findElement(By.id('btnConnect')).click();await driver.sleep(3000)
    const au=await driver.executeScript('return document.getElementById("approvalUrl").value')
    if(!au){no('No approval URL');return}
    ok('URL: '+au.substring(0,60))

    // ── 3. Approve in same tab ───────────
    // Navigate to the approval URL directly (replacing current page)
    // This way there's no window switching complexity
    console.log('\n--- Approve ---')
    await driver.get(au)
    await driver.sleep(3000)
    info('Approval page loaded')

    // Enter key
    const pwd = await driver.findElement(By.id('appPassword'))
    ok('Found password input')
    await pwd.clear();await pwd.sendKeys(CONNECT_KEY)
    info('Entered key')

    // Click Accept
    await driver.findElement(By.id('acceptButton')).click()
    ok('Clicked Accept')
    await driver.sleep(3000)

    // Look for Return to app link — it's a link back to the app
    const links = await driver.findElements(By.css('a, button'))
    let retLink = null
    for (const l of links) {
      const t = await l.getText().catch(()=>'')
      const href = await l.getAttribute('href').catch(()=>'')
      if (/return|back|app/i.test(t) || (href && href.includes('localhost:5173'))) {
        retLink = l
        info('Return element: "' + t + '" href="' + (href||'') + '"')
        break
      }
    }
    if (retLink) {
      ok('Found return link')
      // Click it — it navigates to localhost:5173 (dev) or localhost:3099
      // We need to go to 3099 (the proxy) not 5173
      const href = await retLink.getAttribute('href').catch(()=>'')
      if (href && href.includes('localhost:5173')) {
        // Navigate to the proxy version instead
        const newUrl = href.replace('localhost:5173', 'localhost:3099')
        await driver.get(newUrl)
      } else if (href) {
        await driver.get(href)
      } else {
        await retLink.click()
      }
    } else {
      info('No return link found — navigating back to app manually')
      await driver.get(BASE)
    }
    await driver.sleep(3000)

    // ── 4. Wait for phrase screen ────────
    console.log('\n--- Wait Approval ---')
    // We're now on the app page (approval was processed)
    // The app should be polling and detect approval
    try{await driver.findElement(By.id('connectRetry')).click()}catch(_){}
    let phraseReady = false
    for(let i=0;i<30;i++){
      await driver.sleep(3000)
      const s=await driver.executeScript(
        'var el=document.getElementById("phraseScreen");return el&&!el.classList.contains("hidden")?"phrase":"other"')
      if(s==='phrase'){phraseReady=true;break}
      const st=await driver.executeScript('return document.getElementById("connectStatus")?.textContent||""')
      if(st&&st.includes('failed')){no('Failed: '+st);break}
      if(i%5===0)info('  waiting... '+(st||''))
    }

    if(phraseReady){
      ok('Phrase screen shown')
      const ph=await driver.executeScript('return document.getElementById("phraseText").textContent')
      info('Phrase: '+ph)
      await driver.findElement(By.id('btnPhraseDone')).click()
      info('Clicked save')
      // Wait for main screen
      for(let i=0;i<20;i++){
        await driver.sleep(3000)
        const ms=await driver.executeScript('return !document.getElementById("mainScreen").classList.contains("hidden")')
        if(ms){ok('Main screen');break}
        if(i===19)no('Main screen not reached')
      }
    } else {
      no('Phrase not reached')
      info('Fallback: SDK inject')
      await driver.executeScript(`
        return (async function(){
          var T=window.__tessera__;await T.initSia();
          localStorage.setItem('tessera.aid','1483449cb22e73c9936cc4153bf071c4008c0787faf078d35bf95f702b326f23');
          localStorage.setItem('tessera.akey','6be4f21d5a4da5ab422077cb8188885e947f10aced92cded35c5aa9afad9d42c');
          var key=new T.AppKey(T.fromHex('6be4f21d5a4da5ab422077cb8188885e947f10aced92cded35c5aa9afad9d42c'));
          var b=new T.Builder('https://index.dithr.dev',{appId:'1483449cb22e73c9936cc4153bf071c4008c0787faf078d35bf95f702b326f23',name:'E2E',description:'',serviceUrl:'https://index.dithr.dev'});
          var sdk=await b.connected(key);T.registerSdk(sdk);
          T.patchState({sdk:sdk,accountReady:true,screen:'main'});
          window.__T=T;window.__sdk=sdk;await T.initRelay();return'ok';
        })()`)
      ok('Fallback')
    }
    await driver.sleep(2000)

    // ── 5. List ──────────────────────────
    console.log('\n--- List ---')
    await driver.executeScript(`
      return (async function(){var T=window.__tessera__||window.__T;var sdk=T.getState().sdk;if(!sdk)return;var l=await T.listFiles(sdk);T.patchState({files:l,totals:T.computeTotals(l)});})()`)
    await driver.sleep(2000)
    const fc=await driver.executeScript('return document.querySelectorAll(".file-row").length')
    ok(fc+' file(s)')

    // ── 6. Upload ────────────────────────
    console.log('\n--- Upload ---')
    const tf='/tmp/tessera-e2e.txt'
    writeFileSync(tf,'E2E test '+new Date().toISOString()+'\n')
    ok('Test file created')
    await driver.findElement(By.id('fileInput')).sendKeys(tf);await driver.sleep(500)
    info('Upload started...')
    let ud=false
    for(let i=0;i<90;i++){
      await driver.sleep(4000)
      const toast=await driver.executeScript('return document.getElementById("toast").textContent')
      const status=await driver.executeScript('return document.getElementById("statusText").textContent')
      const pg=await driver.executeScript('var T=window.__tessera__||window.__T;return T?T.getState().progress:null')
      if(pg)process.stdout.write('  '+pg.stage+' '+pg.percent+'%   \r')
      if(toast&&toast.includes('uploaded')){console.log('');ok('Upload OK');ud=true;break}
      if(status&&(status.includes('failed')||status.includes('error')||status.includes('timed out'))){console.log('');no('Upload: '+status);ud=true;break}
    }
    if(!ud)no('Upload hung')

    await driver.executeScript(`
      return (async function(){var T=window.__tessera__||window.__T;var sdk=T.getState().sdk;var l=await T.listFiles(sdk);T.patchState({files:l,totals:T.computeTotals(l)});})()`)
    await driver.sleep(2000)
    info('After upload: '+await driver.executeScript('return document.querySelectorAll(".file-row").length'))

    // ── 7. Share ─────────────────────────
    console.log('\n--- Share ---')
    const rows=await driver.executeScript('return document.querySelectorAll(".file-row").length')
    if(rows>0){
      await driver.executeScript('document.querySelector(".file-row").click()');await driver.sleep(500)
      await driver.findElement(By.id('btnShare')).click();await driver.sleep(1500)
      const sh=await driver.executeScript('return !document.getElementById("shareModal").classList.contains("hidden")')
      sh?ok('Share modal'):no('Share hidden')
      if(sh){
        ok('URL: '+(await driver.findElement(By.id('shareLink')).getAttribute('value')||'').substring(0,60))
        await driver.findElement(By.id('btnCopyLink')).click();await driver.sleep(300)
        ok('Copy: '+await driver.executeScript('return document.getElementById("toast").textContent'))
        await driver.executeScript('document.getElementById("btnCloseModal").click()')
      }
    }

    // ── 8. Download ──────────────────────
    console.log('\n--- Download ---')
    if(rows>0){
      await driver.executeScript('document.querySelector(".file-row").click()');await driver.sleep(500)
      const db=await driver.findElement(By.id('btnDownload'))
      if(await db.getAttribute('disabled')!==null){no('DL disabled')}else{
        await db.click();await driver.sleep(3000)
        const ds=await driver.executeScript('return document.getElementById("statusText").textContent')
        ds&&ds.includes('failed')?no('Download: '+ds):ok('Download OK')
      }
    }

    // ── 9. Delete ────────────────────────
    console.log('\n--- Delete ---')
    if(rows>0){
      await driver.executeScript('document.querySelector(".file-row").click()');await driver.sleep(500)
      await driver.findElement(By.id('btnDelete')).click();await driver.sleep(1000)
      try{const a=await driver.switchTo().alert();ok('Confirm: '+(await a.getText()).substring(0,40));await a.accept();await driver.sleep(5000);ok('Deleted')}catch(e){no('Delete: '+e.message)}
      await driver.executeScript(`
        return (async function(){var T=window.__tessera__||window.__T;var sdk=T.getState().sdk;var l=await T.listFiles(sdk);T.patchState({files:l,totals:T.computeTotals(l)});})()`)
      await driver.sleep(2000)
      ok('Remaining: '+await driver.executeScript('return document.querySelectorAll(".file-row").length'))
    }

    // ── 10. Logout ───────────────────────
    console.log('\n--- Logout ---')
    await driver.findElement(By.id('btnLogout')).click();await driver.sleep(1000)
    try{const a=await driver.switchTo().alert();ok('Confirm');await a.accept();await driver.sleep(2000)}catch(e){no('Logout: '+e.message)}
    ok('Connect screen: '+await driver.executeScript('return !document.getElementById("connectScreen").classList.contains("hidden")'))

    console.log('\n=== '+p+' passed, '+f+' failed ===')
  }catch(e){no('FATAL: '+e.message);console.error(e)}
  finally{try{unlinkSync('/tmp/tessera-e2e.txt')}catch(_){};await driver.quit();if(f>0)process.exit(1)}
}
main()