// Verify both scroll directions with unequal source lengths and real Marp slide geometry.
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();await page.setViewport({width:1600,height:1000});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:8766/',{waitUntil:'networkidle0'});
    await page.waitForFunction(()=>document.querySelector('#preview').contentDocument.querySelectorAll('.marpit > svg').length===4);
    await page.evaluate(()=>{
      document.addEventListener('lab-preview',e=>{window.qaMap=e.detail;});
      const note=n=>Array.from({length:n},(_,i)=>'<!-- source note '+i+' -->').join('\n');
      const draft='---\nmarp: true\nsize: 16:9\nstyle: |\n  /* --- belongs to YAML, not a slide */\n---\n# Sync first\n\n```text\n---\n```\n'+note(25)+'\n\n---\n\n# Sync second\n'+note(90)+'\n\n---\n\n# Sync third\n'+note(60)+'\n\n---\n\n# Sync fourth\n'+note(85);
      const el=document.querySelector('#editor');el.value=draft;el.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await page.waitForFunction(()=>window.qaMap?.text.includes('# Sync first'));
    assert.equal(await page.evaluate(()=>window.qaMap.slideLines.length),4);
    const metrics=()=>page.evaluate(()=>{
      const editor=document.querySelector('#editor'),win=document.querySelector('#preview').contentWindow;
      const doc=win.document,padding=parseFloat(win.getComputedStyle(doc.querySelector('.marpit')).paddingTop);
      return {source:editor.scrollTop,preview:win.scrollY,sourceMax:editor.scrollHeight-editor.clientHeight,previewMax:doc.scrollingElement.scrollHeight-win.innerHeight,
        sourceAnchors:window.qaMap.slideLines.map(line=>line*parseFloat(getComputedStyle(editor).lineHeight)),
        previewAnchors:[...doc.querySelectorAll('.marpit > svg')].map(svg=>svg.getBoundingClientRect().top+win.scrollY-padding)};
    });
    const start=await metrics();assert(start.sourceMax>start.sourceAnchors[2]);assert(start.previewMax>start.previewAnchors[2]);
    await page.$eval('#editor',(el,y)=>{el.scrollTop=y;},start.sourceAnchors[2]);await pause(300);
    let state=await metrics();assert(Math.abs(state.preview-state.previewAnchors[2])<3,JSON.stringify(state));
    await pause(300);assert(Math.abs((await metrics()).source-state.source)<1);
    await page.evaluate(y=>document.querySelector('#preview').contentWindow.scrollTo(0,y),start.previewAnchors[1]);await pause(300);
    state=await metrics();assert(Math.abs(state.source-state.sourceAnchors[1])<3,JSON.stringify(state));
    // Resizing also preserves the page when the preview was the most recent scroll driver.
    await page.$eval('#zoom',el=>{el.value='125';el.dispatchEvent(new Event('input',{bubbles:true}));});await pause(300);
    state=await metrics();assert(Math.abs(state.preview-state.previewAnchors[1])<3,JSON.stringify(state));
    // Re-rendering after an edit retains the editor's corresponding slide.
    await page.$eval('#editor',el=>{el.value+='\n<!-- appended -->';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>window.qaMap?.text.endsWith('<!-- appended -->'));await pause(300);
    state=await metrics();assert(Math.abs(state.preview-state.previewAnchors[1])<3);
    await page.$eval('#zoom',el=>{el.value='150';el.dispatchEvent(new Event('input',{bubbles:true}));});await pause(300);
    state=await metrics();assert(Math.abs(state.preview-state.previewAnchors[1])<3,JSON.stringify(state));
    const box=await(await page.$('#divider')).boundingBox();await page.mouse.move(box.x+4,box.y+80);await page.mouse.down();await page.mouse.move(box.x-130,box.y+80,{steps:8});await page.mouse.up();await pause(300);
    state=await metrics();assert(Math.abs(state.preview-state.previewAnchors[1])<3,JSON.stringify(state));
    // Endpoints, opt-out, and persistence must not create feedback scroll loops.
    await page.$eval('#editor',el=>{el.scrollTop=el.scrollHeight;});await pause(300);
    state=await metrics();assert(Math.abs(state.preview-state.previewMax)<3);
    await page.click('#sync-scroll');const independent=await metrics();
    await page.$eval('#editor',el=>{el.scrollTop=0;});await pause(300);assert.equal((await metrics()).preview,independent.preview);
    // The edited fixture correctly prompts on unload; approve leaving only this test draft.
    page.once('dialog',dialog=>dialog.accept());
    await page.reload({waitUntil:'networkidle0'});assert.equal(await page.$eval('#sync-scroll',el=>el.checked),false);
    await page.click('#sync-scroll');assert.deepEqual(errors,[]);
    console.log(JSON.stringify({bothDirections:true,slideMapping:true,yamlAndFence:true,rerender:true,zoom:true,drag:true,bottom:true,optOut:true,persistence:true,errors}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
