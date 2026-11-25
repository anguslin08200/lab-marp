// Read a supplied real deck without saving it; verify large image decks keep live slide nodes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer-core');
const file=process.argv[2],base=`http://127.0.0.1:${process.env.LAB_SLIDES_PORT||8771}`;
if(!file)throw new Error('Usage: node scripts/check-large-preview.cjs <absolute Markdown path>');
(async()=>{
  const before=fs.readFileSync(file),chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&fs.existsSync(p));
  const browser=await puppeteer.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();await page.setViewport({width:1600,height:1000});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setRequestInterception(true);page.on('request',request=>request.url().includes('/api/codex/')?request.respond({status:200,contentType:'application/json',body:'{"available":false,"loggedIn":false}'}):request.continue());
    await page.goto(base,{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('#page-count').textContent);
    await page.evaluate(async file=>{
      const doc=await api('open',{path:file});
      await new Promise(resolve=>{const done=event=>{if(event.detail.text===doc.text){document.removeEventListener('lab-preview',done);resolve();}};document.addEventListener('lab-preview',done);applyDocument(doc);});
    },path.resolve(file));
    await page.evaluate(()=>{
      document.querySelector('#sync-scroll').checked=false;window.largeOldSvg=slideNodes().at(-1);window.largeOldImage=window.largeOldSvg.querySelector('img');window.largePreviewEvents=0;document.querySelector('#preview').contentWindow.largeMarker=true;
      document.addEventListener('lab-preview',()=>window.largePreviewEvents++);jumpSlide(5,false);window.largeOldScroll=document.querySelector('#preview').contentWindow.scrollY;
      const editor=document.querySelector('#editor');editor.value+='\n<!-- incremental QA -->';editor.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await page.waitForFunction(()=>window.largePreviewEvents>0,{timeout:60000});
    const state=await page.evaluate(()=>({pages:slideNodes().length,marker:document.querySelector('#preview').contentWindow.largeMarker,sameSvg:window.largeOldSvg===slideNodes().at(-1),sameImage:window.largeOldImage===slideNodes().at(-1).querySelector('img'),scrollDelta:document.querySelector('#preview').contentWindow.scrollY-window.largeOldScroll}));
    assert(state.marker);assert(state.sameSvg);assert(state.sameImage);assert(Math.abs(state.scrollDelta)<2,JSON.stringify(state));assert.deepEqual(errors,[]);
    await page.click('#toggle-thumbnails');await page.screenshot({path:'output/large-preview-check.png'});
    assert.deepEqual(fs.readFileSync(file),before);console.log(JSON.stringify({...state,originalUntouched:true,errors}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
