// Verify real DOM resizing/persistence and effort transport without spending an inference turn.
const assert=require('node:assert/strict');const puppeteer=require('puppeteer-core');const {CodexBridge}=require('../codex-bridge.cjs');
(async()=>{
 const bridge=new CodexBridge(process.cwd());
 const models=[{id:'fixture',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],inputModalities:['text']}];
 bridge.models=async()=>({models,defaultModel:'fixture',defaultEffort:'low'});
 const session={id:'fixture-session',threadId:'fixture-thread',model:'fixture',active:null};bridge.session=async()=>session;
 const sent=[];bridge.request=async(method,params)=>{if(method==='turn/start'){sent.push(params);queueMicrotask(()=>session.active.finish(null,{reply:'ok',markdown:null,format:null}));return {turn:{id:'fixture-turn'}};}throw Error(method);};
 const call=effort=>bridge.chat({sessionId:session.id,text:'test',source:'# Test',format:'original',effort,emit:()=>{},signal:new AbortController().signal});
 await call('high');await call('');assert.deepEqual(sent.map(p=>p.effort),['high','low']);await assert.rejects(call('ultra'),/不支援/);
 const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage();await page.setViewport({width:1600,height:1000});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8767/',{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('#codex-effort').options.length>1);
 const opts=await page.$eval('#codex-effort',el=>[...el.options].map(o=>o.value));assert(opts.includes('high'));
 await page.select('#codex-effort','high');
 await page.type('#codex-input','draft to preserve');
 await page.evaluate(()=>{const p=document.createElement('p');p.textContent='preserved reply';document.querySelector('#codex-messages').append(p);});
 const before=await page.$eval('#codex-pane',el=>el.getBoundingClientRect().height);const box=await(await page.$('#codex-divider')).boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+4);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y-120,{steps:8});await page.mouse.up();
 const after=await page.$eval('#codex-pane',el=>el.getBoundingClientRect().height);assert(after>before+90);
 await page.click('#codex-collapse');assert(await page.$eval('#codex-pane',el=>el.getBoundingClientRect().height)<70);assert.equal(await page.$eval('#toggle-codex',el=>el.getAttribute('aria-expanded')),'false');
 await page.click('#codex-collapse');assert.equal(await page.$eval('#codex-input',el=>el.value),'draft to preserve');assert((await page.$eval('#codex-messages',el=>el.textContent)).includes('preserved reply'));
 let request;await page.setRequestInterception(true);page.on('request',req=>{if(req.url().endsWith('/api/codex/chat')){request=JSON.parse(req.postData());req.respond({status:200,contentType:'text/event-stream',body:'event: session\ndata: {"sessionId":"fixture","model":"fixture","effort":"high"}\n\nevent: complete\ndata: {"reply":"ok","changed":false}\n\n'});}else req.continue();});
 await page.click('#codex-send');await page.waitForFunction(()=>document.querySelector('#codex-progress').textContent==='回覆完成。');assert.equal(request.effort,'high');
 await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>!document.querySelector('#codex-effort').disabled);assert.equal(await page.$eval('#codex-effort',el=>el.value),'high');assert(Math.abs(await page.$eval('#codex-pane',el=>el.getBoundingClientRect().height)-after)<3);
 await page.screenshot({path:'output/chat-controls-preview.png'});
 await page.setViewport({width:1000,height:640});await new Promise(r=>setTimeout(r,150));
 const geometry=await page.evaluate(()=>({editor:document.querySelector('#editor').getBoundingClientRect().height,form:document.querySelector('#codex-form').getBoundingClientRect().height,chat:document.querySelector('#codex-pane').getBoundingClientRect().height}));assert(geometry.editor>=79);assert(geometry.form>50);
 await page.click('#codex-collapse');await page.reload({waitUntil:'networkidle0'});assert(await page.$eval('#codex-pane',el=>el.classList.contains('collapsed')));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({effortTransport:true,defaultReset:true,rejectUnsupported:true,resize:{before,after},collapsePreservesDraft:true,persistence:true,smallViewport:geometry,errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
