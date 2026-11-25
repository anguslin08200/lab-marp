// Verify recent-file restoration using real local Markdown files and an isolated browser profile.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const puppeteer=require('puppeteer-core');
(async()=>{
 const dir=path.resolve('output/recent-file-fixture');fs.mkdirSync(dir,{recursive:true});const a=path.join(dir,'first.md'),b=path.join(dir,'second.md');fs.writeFileSync(a,'# First fixture');fs.writeFileSync(b,'# Second fixture');
 const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage();await page.setViewport({width:1400,height:900});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8766/',{waitUntil:'networkidle0'});
 const open=async file=>{await page.click('#open');await page.$eval('#open-path',(el,v)=>el.value=v,file);await page.click('#open-submit');await page.waitForFunction(p=>document.querySelector('#filename').textContent===p,{},file);};
 await open(a);await open(b);await open(a);assert.deepEqual(await page.evaluate(()=>recentDocuments().map(e=>e.path)),[a,b]);
 await page.reload({waitUntil:'networkidle0'});assert.equal(await page.$eval('#filename',el=>el.textContent),a);assert.equal(await page.$eval('#editor',el=>el.value),'# First fixture');
 await page.click('#open');await page.click('#recent-files .recent-file:nth-child(2) .recent-open');await page.waitForFunction(p=>document.querySelector('#filename').textContent===p,{},b);
 // Creating an unsaved template must not replace the last real file.
 await page.click('#new');await page.click('#template-options button');assert.equal(await page.evaluate(()=>recentDocuments()[0].path),b);
 await page.evaluate(()=>markDirty(false));await page.reload({waitUntil:'networkidle0'});assert.equal(await page.$eval('#filename',el=>el.textContent),b);
 await page.click('#open');await page.screenshot({path:'output/recent-documents-preview.png'});await page.click('#open-cancel');
 // Missing files produce a usable picker and retain history so moved files can be recovered manually.
 fs.unlinkSync(b);await page.reload({waitUntil:'networkidle0'});assert(await page.$eval('#open-dialog',el=>el.open));assert.match(await page.$eval('#open-message',el=>el.textContent),/無法載入/);
 await page.click('#recent-files .recent-file:nth-child(2) .recent-open');await page.waitForFunction(p=>document.querySelector('#filename').textContent===p,{},a);
 await page.click('#open');await page.click('#recent-files .recent-file:nth-child(2) button.quiet');assert.deepEqual(await page.evaluate(()=>recentDocuments().map(e=>e.path)),[a]);
 await page.click('#recent-clear');assert.equal(await page.evaluate(()=>recentDocuments().length),0);
 await page.evaluate(()=>{localStorage.setItem('lab-recent-documents','broken JSON');});await page.click('#open-cancel');await page.reload({waitUntil:'networkidle0'});assert.equal(await page.evaluate(()=>recentDocuments().length),0);
 await page.evaluate(()=>{for(let i=0;i<25;i++)rememberDocument('C:\\history\\'+i+'.md');rememberDocument('c:/history/24.md');});const entries=await page.evaluate(()=>recentDocuments());assert.equal(entries.length,20);assert.equal(entries.filter(e=>e.path.replaceAll('/','\\').toLowerCase()==='c:\\history\\24.md').length,1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({restoresLastFile:true,recentOrdering:true,clickToOpen:true,unsavedTemplateExcluded:true,missingFileFallback:true,removeAndClear:true,corruptStorageFallback:true,uniqueLimit:entries.length,errors}));
 }finally{await browser.close();fs.writeFileSync(b,'# Second fixture');}
})().catch(e=>{console.error(e);process.exitCode=1;});
