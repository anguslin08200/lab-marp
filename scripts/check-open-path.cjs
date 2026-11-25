// Exercise the actual path dialog and renderer; only a stalled native picker is simulated.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const puppeteer=require('puppeteer-core');
(async()=>{
  const directory=path.resolve('output/path-open-qa');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'中文 路徑.md');
  fs.writeFileSync(file,'---\nmarp: true\nsize: 16:9\n---\n# 路徑開啟成功\n\n![width:200px](image.jpg)');
  fs.copyFileSync('slides/assets/circuit.jpg',path.join(directory,'image.jpg'));
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8766/',{waitUntil:'networkidle0'});
    await page.waitForFunction(()=>document.querySelector('#page-count').textContent==='4 頁');
    await page.click('#open');assert(await page.$eval('#open-dialog',el=>el.open));
    await page.type('#open-path','"'+file+'"');await page.click('#open-submit');
    await page.waitForFunction(()=>!document.querySelector('#open-dialog').open);
    await page.waitForFunction(()=>document.querySelector('#preview').contentDocument.querySelector('h1')?.textContent==='路徑開啟成功');
    assert.equal(await page.$eval('#filename',el=>el.textContent),file);
    await page.waitForFunction(()=>[...document.querySelector('#preview').contentDocument.images].every(i=>i.complete&&i.naturalWidth>0));
    await page.click('#open');await page.type('#open-path',path.join(directory,'missing.md'));await page.click('#open-submit');
    await page.waitForFunction(()=>document.querySelector('#open-message').textContent.includes('找不到檔案'));
    assert.equal(await page.$eval('#open-submit',el=>el.disabled),false);await page.click('#open-cancel');
    // Hold the native request to test Cancel and direct-path fallback without opening desktop dialogs.
    await page.setRequestInterception(true);const held=[];
    page.on('request',request=>{
      if(request.url().endsWith('/api/open')&&request.postData()==='{}'){held.push(request);return;}
      request.continue();
    });
    await page.click('#open');await page.click('#open-browse');
    await page.waitForFunction(()=>document.querySelector('#open-browse').disabled);
    await page.click('#open-cancel');assert.equal(await page.$eval('#open',el=>el.disabled),false);
    await page.click('#open');await page.click('#open-browse');await page.type('#open-path',file);await page.click('#open-submit');
    await page.waitForFunction(()=>!document.querySelector('#open-dialog').open);
    assert.equal(await page.$eval('#filename',el=>el.textContent),file);
    for(const request of held)try{await request.abort();}catch{}
    await page.click('#open');await page.type('#open-path',file);await page.screenshot({path:'output/open-path-dialog.png'});await page.click('#open-cancel');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({quotedUnicodePath:true,preview:true,relativeImages:true,missingFileRecovery:true,cancelStalledPicker:true,pathWhileBrowsing:true,errors}));
  }finally{await browser.close();fs.unlinkSync(file);fs.unlinkSync(path.join(directory,'image.jpg'));}
})().catch(e=>{console.error(e);process.exitCode=1;});
