// Verify waiting feedback and completion controls without another expensive CLI generation.
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const {CodexBridge}=require('../codex-bridge.cjs');
(async()=>{
  const events=[];const bridge=new CodexBridge(process.cwd());
  bridge.sessions.set('fixture',{threadId:'fixture-thread',active:{messages:new Map(),emit:(event,data)=>events.push({event,data})}});
  bridge.handle({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',itemId:'answer',delta:'{"reply":"正在整理","markdown":"# 草稿'}});
  assert(events.some(e=>e.event==='reply'));
  assert(events.some(e=>e.event==='status'&&e.data.text.includes('完成後才套用')));
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();await page.setRequestInterception(true);
    page.on('request',async req=>{
      if(!req.url().endsWith('/api/codex/chat'))return req.continue();
      const body=JSON.parse(req.postData());
      await new Promise(resolve=>setTimeout(resolve,2200));
      await req.respond({status:200,contentType:'text/event-stream',body:
        'event: reply\ndata: '+JSON.stringify({text:'內容整理完成'})+'\n\n'+
        'event: complete\ndata: '+JSON.stringify({reply:'內容整理完成',markdown:'# 完整草稿',format:'original',changed:true,baseId:body.id})+'\n\n'});
    });
    await page.goto('http://127.0.0.1:8766/');
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled);
    await page.type('#codex-input','測試等待與完成狀態');await page.click('#codex-send');
    await page.waitForFunction(()=>document.querySelector('#codex-progress').textContent.includes('已等待 1 秒'));
    assert(await page.$eval('#codex-send',el=>el.disabled));
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled);
    assert.equal(await page.$eval('#editor',el=>el.value),'# 完整草稿');
    assert(!await page.$eval('#codex-progress',el=>el.textContent.includes('已等待')));
    assert(await page.$eval('#codex-stop',el=>el.hidden));
    console.log('PASS: incoming output progress, waiting timer, validated application, and completion controls');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
