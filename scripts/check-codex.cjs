// Exercise real CLI conversation, then deterministic UI races without extra model calls.
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const {partialReply,protectAssets,CodexBridge}=require('../codex-bridge.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  assert.equal(partialReply('{"reply":"測試\\n\\u4e2d'),'測試\n中');
  const asset='data:image/png;base64,YWJj';const protectedText=protectAssets(asset);
  assert.equal(protectedText.restore(protectedText.source),asset);
  assert.throws(()=>protectedText.restore('__LAB_ASSET_123__'));
  // A cancelled turn must never return a proposal, even when completion races interrupt.
  const bridge=new CodexBridge(process.cwd());let rejected=false;
  bridge.sessions.set('x',{threadId:'t',active:{cancelled:true,finish:e=>{rejected=Boolean(e);}}});
  bridge.handle({method:'turn/completed',params:{threadId:'t',turn:{status:'completed',items:[]}}});assert(rejected);
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();await page.setViewport({width:1600,height:1000});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8766/',{waitUntil:'networkidle0'});
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled);
    await page.evaluate(()=>{document.querySelector('#editor').value='---\nmarp: true\n---\n# 測試簡報\n\n只保留此段內容。';document.querySelector('#editor').dispatchEvent(new Event('input',{bubbles:true}));});
    await page.select('#format','original');
    const before=await page.$eval('#editor',el=>el.value);
    await page.type('#codex-input','請將第一頁標題改為「Codex 即時編輯成功」，保留其他內容。');await page.click('#codex-send');
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled,{timeout:180000});
    const after=await page.$eval('#editor',el=>el.value);assert(after.includes('Codex 即時編輯成功'));assert(after.includes('只保留此段內容'));
    await page.waitForFunction(()=>document.querySelector('#preview').contentDocument.querySelector('h1')?.textContent==='Codex 即時編輯成功');
    await page.type('#codex-input','剛才你把標題改成什麼？只回答，不修改 Markdown。');await page.click('#codex-send');
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled,{timeout:180000});
    assert.equal(await page.$eval('#editor',el=>el.value),after);
    assert((await page.$eval('#codex-messages',el=>el.textContent)).includes('Codex 即時編輯成功'));
    await page.screenshot({path:'output/codex-workbench.png'});
    await page.click('#codex-undo');assert.equal(await page.$eval('#editor',el=>el.value),before);
    // Mock only the model stream to force manual-edit and Stop timing precisely.
    await page.setRequestInterception(true);
    page.on('request',async request=>{
      if(!request.url().endsWith('/api/codex/chat'))return request.continue();
      const body=JSON.parse(request.postData());await delay(600);
      const result={reply:'模擬修改',markdown:'# AI 建議',format:'original',changed:true,baseId:body.id};
      try{await request.respond({status:200,contentType:'text/event-stream',body:'event: complete\ndata: '+JSON.stringify(result)+'\n\n'});}catch{}
    });
    await page.type('#codex-input','測試並行修改');await page.click('#codex-send');
    await page.$eval('#editor',el=>{el.value='# 手動修改';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>!document.querySelector('#codex-apply').hidden);
    page.once('dialog',dialog=>dialog.dismiss());await page.click('#codex-apply');assert.equal(await page.$eval('#editor',el=>el.value),'# 手動修改');
    page.once('dialog',dialog=>dialog.accept());await page.click('#codex-apply');assert.equal(await page.$eval('#editor',el=>el.value),'# AI 建議');
    await page.type('#codex-input','測試停止');await page.click('#codex-send');await page.click('#codex-stop');
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled);await delay(800);
    assert.equal(await page.$eval('#editor',el=>el.value),'# AI 建議');assert.deepEqual(errors,[]);
    console.log(JSON.stringify({realCliEdit:true,multiTurn:true,preview:true,undo:true,manualEditProtection:true,stop:true,errors}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
