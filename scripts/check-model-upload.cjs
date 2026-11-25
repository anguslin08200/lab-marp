// Test actual browser uploads and two CLI models, including native image input and portable embedding.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const puppeteer=require('puppeteer-core');
(async()=>{
  const fixture=path.resolve('output/model-upload-qa');fs.mkdirSync(fixture,{recursive:true});
  const textFile=path.join(fixture,'測試資料.txt'),imageFile=path.join(fixture,'測試圖.png');
  fs.writeFileSync(textFile,'此為驗證附件功能的合成測試資料。測試代號：CAT-4729。');
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const image=await browser.newPage();await image.setViewport({width:600,height:350});
    await image.setContent('<body style="margin:0;background:white"><svg width="600" height="350"><text x="40" y="100" font-size="64">LAB42</text><circle cx="300" cy="220" r="70" fill="blue"/></svg></body>');
    await image.screenshot({path:imageFile});await image.close();
    const page=await browser.newPage();await page.setViewport({width:1600,height:1000});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:8766/',{waitUntil:'networkidle0'});
    await page.waitForFunction(()=>document.querySelector('#codex-model').options.length>1&&!document.querySelector('#codex-send').disabled);
    const models=await page.$eval('#codex-model',el=>[...el.options].map(o=>o.value).filter(Boolean));
    const first=models.find(m=>m==='gpt-6-luna')||models[0];const second=models.find(m=>m==='gpt-5.6-luna')||models.find(m=>m!==first);assert(second);
    await page.select('#codex-model',first);
    await page.$eval('#editor',el=>{el.value='---\nmarp: true\nsize: 16:9\n---\n# 附件測試\n\n保持此段說明。';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.select('#format','original');
    await(await page.$('#codex-files')).uploadFile(textFile,imageFile);
    await page.waitForFunction(()=>document.querySelectorAll('.attachment-chip').length===2&&!document.querySelector('#codex-upload').disabled,{timeout:60000});
    await page.type('#codex-input','只回答，不修改 Markdown：讀取附件，回答 TXT 的測試代號，以及圖片中的文字、形狀與顏色。');await page.click('#codex-send');
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled,{timeout:180000});
    const reply=await page.$eval('#codex-messages',el=>el.textContent);assert.match(reply,/CAT-4729/);assert.match(reply,/LAB42/);assert.match(reply,/藍|blue/i);assert.match(reply,/圓|circle/i);
    assert((await page.$eval('#codex-connection',el=>el.textContent)).includes(first));
    await page.select('#codex-model',second);
    await page.type('#codex-input','把第一頁標題改成「模型與附件完成」，保留原有說明，並在第一頁加入已上傳的測試圖，圖片高度約 250px。');await page.click('#codex-send');
    await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled,{timeout:180000});
    const markdown=await page.$eval('#editor',el=>el.value);assert(markdown.includes('模型與附件完成'));assert(markdown.includes('保持此段說明'));assert(markdown.includes('data:image/png;base64,'));
    assert((await page.$eval('#codex-connection',el=>el.textContent)).includes(second));
    await page.waitForFunction(()=>document.querySelector('#preview').contentDocument.querySelector('h1')?.textContent==='模型與附件完成');
    await page.waitForFunction(()=>[...document.querySelector('#preview').contentDocument.images].some(i=>i.complete&&i.naturalWidth>0));
    await page.screenshot({path:'output/model-upload-workbench.png'});
    await page.click('.attachment-chip button');assert.equal(await page.$$eval('.attachment-chip',els=>els.length),1);
    await page.click('#codex-reset');await page.waitForFunction(()=>document.querySelectorAll('.attachment-chip').length===0);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({models:[first,second],realTextReading:true,realImageReading:true,sameConversationModelSwitch:true,portableImageEmbedding:true,preview:true,remove:true,reset:true,errors}));
  }finally{await browser.close();for(const file of [textFile,imageFile])if(fs.existsSync(file))fs.unlinkSync(file);}
})().catch(e=>{console.error(e);process.exitCode=1;});
