// Test source/preview correspondence in an isolated server without saving or touching user drafts.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const puppeteer=require('puppeteer-core');
const port=18766,url=`http://127.0.0.1:${port}/`;
const fixture='---\r\nmarp: true\r\nsize: 16:9\r\n---\r\n# First\r\n\r\n### Symbols and Data Flow\r\n\r\n- Remember **important** content.\r\n  - Child detail.\r\n\r\n<div class="tables">\r\n\r\n| Symbol | Meaning |\r\n|---|---|\r\n| $x_t$ | Current input |\r\n| $h_t$ | Previous state |\r\n\r\n</div>\r\n\r\n$$h_t=Ax_t$$\r\n\r\n```text\r\n---\r\n```\r\n\r\n---\r\n\r\n# Second\r\n\r\n### Symbols and Data Flow\r\n\r\nRepeat repeat repeat.\r\n\r\n<!-- hidden note -->\r\n';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const server=spawn(process.execPath,['server.cjs'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LAB_SLIDES_PORT:String(port)},windowsHide:true,stdio:'pipe'});
  let browser;let log='';server.stdout.on('data',data=>{log+=data;});server.stderr.on('data',data=>{log+=data;});
  try{
    for(let n=0;n<80;n++){try{if((await fetch(url)).ok)break;}catch{}await pause(100);if(n===79)throw new Error(log);}
    browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const page=await browser.newPage();await page.setViewport({width:1700,height:1000});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url,{waitUntil:'networkidle0'});
    await page.waitForFunction(()=>document.querySelector('#preview').contentDocument.querySelector('section'));
    await page.evaluate(text=>{
      document.addEventListener('lab-preview',event=>{window.qaMap=event.detail;});
      const editor=document.querySelector('#editor');editor.value=text;editor.dispatchEvent(new Event('input',{bubbles:true}));
    },fixture);
    await page.waitForFunction(()=>window.qaMap?.text.includes('# Second'));
    const sourceSelect=async(text,last=false)=>{
      await page.evaluate(({text,last})=>{
        const editor=document.querySelector('#editor'),start=last?editor.value.lastIndexOf(text):editor.value.indexOf(text);
        editor.focus();editor.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));editor.setSelectionRange(start,start+text.length);editor.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
      },{text,last});await pause(150);
    };
    const previewSelect=async(selector,needle,occurrence=0)=>{
      await page.frames().find(frame=>frame!==page.mainFrame()).click(selector);
      await page.evaluate(({selector,needle,occurrence})=>{
        const doc=document.querySelector('#preview').contentDocument,element=doc.querySelector(selector);
        element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
        const walker=doc.createTreeWalker(element,4);let node;while((node=walker.nextNode()))if(node.textContent.includes(needle))break;
        if(!node)throw new Error('Missing test text');let start=node.textContent.indexOf(needle);
        for(let n=0;n<occurrence;n++)start=node.textContent.indexOf(needle,start+needle.length);
        const range=doc.createRange();range.setStart(node,start);range.setEnd(node,start+needle.length);
        const selection=doc.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);element.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
      },{selector,needle,occurrence});await pause(150);
    };
    const state=()=>page.evaluate(()=>{
      const editor=document.querySelector('#editor'),win=document.querySelector('#preview').contentWindow,doc=win.document;
      return {selected:editor.value.slice(editor.selectionStart,editor.selectionEnd),start:editor.selectionStart,
        marked:[...doc.querySelectorAll('.lab-source-match')].map(el=>({tag:el.tagName,text:el.textContent,page:el.closest('section').id})),
        highlights:[...(win.CSS.highlights.get('lab-source-selection')||[])].map(range=>range.toString()),mirror:document.querySelector('#source-selection-text mark')?.textContent,
        previewSelected:win.getSelection().toString(),editorFocused:document.activeElement===editor};
    });
    await sourceSelect('Symbols and Data Flow');let result=await state();
    assert.equal(result.marked.length,1);assert.equal(result.marked[0].page,'1');assert.deepEqual(result.highlights,['Symbols and Data Flow']);assert(result.editorFocused);
    await sourceSelect('Symbols and Data Flow',true);result=await state();assert.equal(result.marked[0].page,'2');
    await previewSelect('section[id="1"] h3','Symbols and Data Flow');result=await state();assert.equal(result.selected,'Symbols and Data Flow');assert.equal(result.mirror,result.selected);assert(!result.editorFocused);
    // Table cells remain precise, even when their neighbors contain rendered LaTeX.
    await sourceSelect('Current input');result=await state();assert.equal(result.marked[0].tag,'TD');assert.equal(result.marked.length,1);
    await previewSelect('tbody tr:nth-child(2) td:nth-child(2)','Previous state');assert.equal((await state()).selected,'Previous state');
    await previewSelect('section[id="2"] p','repeat',1);result=await state();assert.equal(result.start,fixture.replace(/\r\n/g,'\n').lastIndexOf('repeat'));
    await sourceSelect('Child detail.');result=await state();assert.equal(result.marked.length,1);assert(!result.marked[0].text.includes('Remember'));
    await sourceSelect('h_t=Ax_t');result=await state();assert.equal(result.marked.length,1);assert.equal(result.marked[0].tag,'P');
    await sourceSelect('hidden note');assert.equal((await state()).marked.length,0);
    // Switching themes changes YAML length; maps must still reference the unmodified draft.
    await page.select('#format','minimal');await page.waitForFunction(()=>window.qaMap?.selectionBlocks?.length&&document.querySelector('#preview').srcdoc.includes('Research Meeting'));await pause(150);
    await sourceSelect('Symbols and Data Flow',true);result=await state();assert.equal(result.marked[0].page,'2');
    await previewSelect('section[id="1"] h3','Symbols and Data Flow');assert.equal((await state()).selected,'Symbols and Data Flow');
    // An edit invalidates old offsets immediately, then fresh rendering restores matching.
    await page.evaluate(()=>{const editor=document.querySelector('#editor');editor.value+='\n';editor.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal((await state()).marked.length,0);await page.waitForFunction(()=>window.qaMap.text===document.querySelector('#editor').value);
    await sourceSelect('Current input');assert.equal((await state()).marked[0].tag,'TD');
    await page.click('#sync-selection');await sourceSelect('Symbols and Data Flow');assert.equal((await state()).marked.length,0);
    assert.equal(await page.$eval('#sync-scroll',el=>el.checked),true);
    await page.click('#sync-selection');await sourceSelect('Symbols and Data Flow');
    await page.screenshot({path:'output/selection-sync-check.png'});assert.deepEqual(errors,[]);
    console.log(JSON.stringify({bothDirections:true,duplicateHeadings:true,tableCells:true,nestedLists:true,math:true,hiddenNotes:true,themes:true,rerender:true,optOut:true,focusPreserved:true,errors}));
  }finally{if(browser)await browser.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
