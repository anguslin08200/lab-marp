// Exercise the real editor, drag handle, format menu, local assets, and PDF button.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer-core');
(async()=>{
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage();await page.setViewport({width:1600,height:1000,deviceScaleFactor:1});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8766/',{waitUntil:'networkidle0'});
    await page.waitForFunction(()=>document.querySelector('#page-count').textContent==='4 頁');
    const frame=()=>page.frames().find(f=>f!==page.mainFrame());
    await page.screenshot({path:'output/workbench-preview.png'});
    assert.match(await frame().evaluate(()=>document.body.textContent),/論文標題/);
    await page.$eval('#editor',el=>{el.value=el.value.replace('[論文標題]','CATLab 預覽測試');el.dispatchEvent(new Event('input',{bubbles:true}));});
    try {await page.waitForFunction(()=>document.querySelector('#preview').contentDocument.querySelector('h1')?.textContent==='CATLab 預覽測試');}
    catch(e){console.log(await page.evaluate(()=>({status:document.querySelector('#status').textContent,srcdoc:document.querySelector('#preview').srcdoc.includes('CATLab 預覽測試'),titles:[...document.querySelector('#preview').contentDocument.querySelectorAll('h1,h2')].map(h=>h.textContent)})));await page.screenshot({path:'output/qa-failure.png'});throw e;}
    const divider=await page.$('#divider');const box=await divider.boundingBox();
    const before=await page.$eval('.editor-pane',el=>el.getBoundingClientRect().width);
    await page.mouse.move(box.x+5,box.y+100);await page.mouse.down();await page.mouse.move(480,box.y+100,{steps:8});await page.mouse.up();
    const after=await page.$eval('.editor-pane',el=>el.getBoundingClientRect().width);assert(after<before-100);
    await page.select('#format','dark');
    await page.waitForFunction(()=>document.querySelector('#preview').srcdoc.includes('#132334'));
    await page.waitForFunction(()=>{const doc=document.querySelector('#preview').contentDocument;return doc?.querySelector('section')&&doc.defaultView.getComputedStyle(doc.querySelector('section')).backgroundColor==='rgb(19, 35, 52)';},{polling:100});
    await page.select('#format','catlab');await page.waitForFunction(()=>document.querySelector('#preview').srcdoc.includes('--catlab-navy'));
    // Read the blob consumed by the export button, rather than DevTools' attachment body.
    await page.evaluate(()=>{const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{window.qaPdfBlob=blob;return create(blob);};});
    const response=page.waitForResponse(r=>r.url().endsWith('/api/export'));
    await page.click('#export');const pdfResponse=await response;assert.equal(pdfResponse.status(),200);
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('PDF 已匯出'));
    const pdf=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await window.qaPdfBlob.arrayBuffer()))));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
    // Independent fixture verifies selection outside the starter and relative-image preservation.
    const fixture=path.resolve('output/qa-fixture');fs.mkdirSync(fixture,{recursive:true});
    fs.copyFileSync('slides/assets/circuit.jpg',path.join(fixture,'image.jpg'));
    const file=path.join(fixture,'chosen.md');fs.writeFileSync(file,'---\nmarp: true\nsize: 16:9\n---\n# 自選檔案\n\n![width:400px](image.jpg)\n');
    const info=await(await fetch('http://127.0.0.1:8766/api/info')).json();
    const api=async(route,body)=>{const response=await fetch('http://127.0.0.1:8766/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':info.token},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
    const doc=await api('open',{path:file});const rendered=await api('render',{id:doc.id,text:doc.text,format:'minimal'});
    const fixturePage=await browser.newPage();await fixturePage.setJavaScriptEnabled(false);await fixturePage.setContent(rendered.html,{waitUntil:'load'});
    assert(await fixturePage.evaluate(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0)));
    const subheadings=await api('render',{id:doc.id,text:'# 標題\n\n## 次標題\n\n內文',format:'catlab'});
    await fixturePage.setContent(subheadings.html,{waitUntil:'load'});
    assert(await fixturePage.evaluate(()=>getComputedStyle(document.querySelector('h1')).position==='absolute'&&getComputedStyle(document.querySelector('h2')).position!=='absolute'));
    await fixturePage.close();
    const saved=await api('save',{id:doc.id,text:doc.text,format:'dark'});assert.match(fs.readFileSync(file,'utf8'),/style:/);const reopened=await api('render',{id:saved.id,text:saved.text,format:'original'});assert(reopened.html.includes('#132334'));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({editing:true,dragging:{before,after},themes:true,pdfBytes:pdf.length,relativeImages:true,saveAndReopen:true,errors},null,2));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
