// Exercise MinerU integration with deterministic local fixtures; never start Codex or MinerU.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const {AttachmentStore, limitedMarkdown} = require('../attachments.cjs');
const {protectAssets, prepareAttachments} = require('../codex-bridge.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-mineru-check-'));
const pdf = fs.readFileSync(path.join(__dirname, '..', 'output', 'catlab-sample.pdf'));
const jpeg = Buffer.from('ffd8ffe0ffd9', 'hex');
const data = bytes => bytes.toString('base64');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = {available:true, kit:'fixture-kit', home:'fixture-home', reason:''};

async function waitFor(store, id, states) {
  for (let i = 0; i < 200; i++) {
    const item = store.status([id])[0];
    if (states.includes(item.mineru?.state)) return item;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${states.join('/')} for ${id}`);
}
async function fixtureZip() {
  // Include an unexpected ZIP path to verify that extraction stays within the cache.
  const zip = new JSZip();
  zip.file('markdown.md', '# Paper\n\n$$x^2 + y^2$$\n\n![plot](images/page_2_chart_1.jpg)\n');
  zip.file('images/page_2_chart_1.jpg', jpeg);
  zip.file('../escaped.txt', 'must not be extracted');
  return zip.generateAsync({type:'nodebuffer'});
}

(async () => {
  try {
    const archive = await fixtureZip();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const store = new AttachmentStore(root, {mineru:config, runMineru:async ({zip, tier}) => {
      calls++;
      assert.equal(tier, 'standard');
      await gate;
      fs.writeFileSync(zip, archive);
    }});
    const first = await store.add({name:'paper.pdf', data:data(pdf), mineru:true});
    assert.ok(['queued','parsing'].includes(first.mineru.state));
    const started = await waitFor(store, first.id, ['parsing']);
    assert.ok(started.mineru.startedAt);
    assert.ok(store.resolve([first.id], {fastText:true})[0].text.length);
    release();
    const finished = await waitFor(store, first.id, ['complete','failed']);
    assert.equal(finished.mineru.state, 'complete', finished.mineru.error);
    assert.equal(finished.mineru.figures, 1);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);

    const paper = store.resolve([first.id])[0];
    assert.match(paper.text, /\$\$x\^2 \+ y\^2\$\$/);
    assert.equal(paper.figures.length, 1);
    assert.ok(paper.text.includes(paper.figures[0].reference));
    assert.match(paper.figures[0].dataURI, /^data:image\/jpeg;base64,/);
    assert.equal(store.figures(first.id)[0].page, 2);
    assert.equal(store.resolve([first.id], {fastText:true})[0].figures, undefined);
    const second = await store.add({name:'again.pdf', data:data(pdf), mineru:true});
    assert.equal(second.mineru.state, 'complete');
    assert.equal(second.mineru.cacheHit, true);
    assert.equal(calls, 1);

    const protectedSource = protectAssets('');
    const prepared = prepareAttachments(protectedSource, [paper], true);
    assert.equal(prepared.images.length, 1);
    assert.equal(prepared.images[0].path, paper.figures[0].path);
    assert.equal(protectedSource.restore(paper.figures[0].reference), paper.figures[0].dataURI);
    const textOnly = prepareAttachments(protectAssets(''), [paper], false);
    assert.equal(textOnly.images.length, 0);
    const manyFigures = Array.from({length:14}, (_, i) => ({...paper.figures[0], reference:`__LAB_ASSET_${String(i).padStart(32,'0')}__`, path:`figure-${i}`}));
    const limited = prepareAttachments(protectAssets(''), [{...paper, figures:manyFigures}], true);
    assert.equal(limited.images.length, 12);
    assert.deepEqual(limited.images.map(image => image.path), manyFigures.slice(0, 12).map(figure => figure.path));

    const file = paper.figures[0].file;
    assert.match(store.insertFigure(first.id, file, {}).markdown, /data:image\/jpeg;base64,/);
    const docDir = path.join(root, 'slides');
    fs.mkdirSync(docDir);
    const document = {directory:docDir, path:path.join(docDir, 'deck.md')};
    const inserted = store.insertFigure(first.id, file, document).markdown;
    assert.match(inserted, /assets\/paper\/page_2_chart_1\.jpg/);
    const original = path.join(docDir, 'assets', 'paper', file);
    fs.writeFileSync(original, 'different');
    const collision = store.insertFigure(first.id, file, document).markdown;
    assert.notEqual(collision, inserted);
    assert.equal(fs.readFileSync(original, 'utf8'), 'different');
    assert.throws(() => store.insertFigure(first.id, '../evil.jpg', document));

    const short = limitedMarkdown('Body\n\n# References\n' + 'r'.repeat(210000));
    assert.equal(short.text.trim(), 'Body');
    const long = limitedMarkdown('a'.repeat(210000));
    assert.ok(long.truncated && long.text.length <= 200000);

    // Unavailable or failed parsing must retain the ordinary PDF text fallback.
    const unavailableRoot = fs.mkdtempSync(path.join(root, 'unavailable-'));
    const unavailable = new AttachmentStore(unavailableRoot, {mineru:{...config,available:false,reason:'offline'}});
    const fallback = await unavailable.add({name:'offline.pdf',data:data(pdf),mineru:true});
    assert.equal(fallback.mineru.state, 'disabled');
    assert.ok(unavailable.resolve([fallback.id])[0].text.length);
    const failureRoot = fs.mkdtempSync(path.join(root, 'failure-'));
    const failing = new AttachmentStore(failureRoot, {mineru:config,runMineru:async () => {throw new Error('fixture failure');}});
    const failedUpload = await failing.add({name:'failed.pdf',data:data(pdf),mineru:true});
    const failed = await waitFor(failing, failedUpload.id, ['failed']);
    assert.match(failed.mineru.error, /fixture failure/);
    assert.ok(failing.resolve([failedUpload.id])[0].text.length);
    // Cached results survive reopening and deleting an upload does not remove its shared cache.
    const reopened=new AttachmentStore(root,{mineru:config});
    assert.equal(reopened.resolve([first.id])[0].figures[0].reference,paper.figures[0].reference);
    const cachedSha=require('node:crypto').createHash('sha256').update(pdf).digest('hex');
    assert.equal(store.remove(second.id),true);
    assert.ok(fs.existsSync(path.join(store.cacheDirectory,cachedSha,'cache.json')));

    // A tight budget evicts the oldest complete paper while keeping the newer one.
    const evictRoot=fs.mkdtempSync(path.join(root,'evict-'));
    const md='# Paper\n\n$$x^2 + y^2$$\n\n![plot](images/page_2_chart_1.jpg)\n';
    const eviction=new AttachmentStore(evictRoot,{mineru:config,cacheLimitBytes:Buffer.byteLength(md)+jpeg.length+180,runMineru:async ({zip})=>fs.writeFileSync(zip,archive)});
    const oldBytes=Buffer.concat([pdf,Buffer.from('\n% old')]), newBytes=Buffer.concat([pdf,Buffer.from('\n% new')]);
    const old=await eviction.add({name:'old.pdf',data:data(oldBytes),mineru:true});
    assert.equal((await waitFor(eviction,old.id,['complete','failed'])).mineru.state,'complete');
    const newer=await eviction.add({name:'new.pdf',data:data(newBytes),mineru:true});
    assert.equal((await waitFor(eviction,newer.id,['complete','failed'])).mineru.state,'complete');
    const shaOf=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    assert.equal(fs.existsSync(path.join(eviction.cacheDirectory,shaOf(oldBytes))),false);
    assert.ok(fs.existsSync(path.join(eviction.cacheDirectory,shaOf(newBytes),'cache.json')));
    // Shared FIFO prevents GPU work from overlapping across independent stores.
    let active=0, maxActive=0, callsFifo=0;
    const runner=async ({zip}) => {callsFifo++; active++; maxActive=Math.max(maxActive,active); await delay(100); fs.writeFileSync(zip,archive); active--;};
    const left=new AttachmentStore(fs.mkdtempSync(path.join(root,'fifo-a-')),{mineru:config,runMineru:runner});
    const right=new AttachmentStore(fs.mkdtempSync(path.join(root,'fifo-b-')),{mineru:config,runMineru:runner});
    const one=await left.add({name:'a.pdf',data:pdf.toString('base64'),mineru:true});
    const two=await right.add({name:'b.pdf',data:pdf.toString('base64'),mineru:true});
    assert.equal((await waitFor(left,one.id,['complete','failed'])).mineru.state,'complete');
    assert.equal((await waitFor(right,two.id,['complete','failed'])).mineru.state,'complete');
    assert.equal(callsFifo,2); assert.equal(maxActive,1);

    // Equation image fallbacks from MinerU should remain usable alongside textual math.
    const equationZip=new JSZip();
    equationZip.file('markdown.md','$$x$$\n![equation](images/page_3_equation_1.jpg)');
    equationZip.file('images/page_3_equation_1.jpg',jpeg);
    const equationBytes=await equationZip.generateAsync({type:'nodebuffer'});
    const equationStore=new AttachmentStore(fs.mkdtempSync(path.join(root,'equation-')),{mineru:config,runMineru:async ({zip}) => fs.writeFileSync(zip,equationBytes)});
    const eq=await equationStore.add({name:'equation.pdf',data:pdf.toString('base64'),mineru:true});
    const eqDone=await waitFor(equationStore,eq.id,['complete','failed']);
    assert.equal(eqDone.mineru.state,'complete',eqDone.mineru.error);
    assert.equal(eqDone.mineru.figures,1);
    const eqPaper=equationStore.resolve([eq.id])[0];
    assert.match(eqPaper.text,/\$\$x\$\$/);
    assert.ok(eqPaper.text.includes(eqPaper.figures[0].reference));
    // Real output exercises the parser's archive format without using the GPU.
    const realZip=process.env.LAB_MINERU_TEST_ZIP || 'C:/Users/e2411/AppData/Local/Temp/claude/db99adfb87830261/768eef10-d3f3-4fc2-bd5d-d261a4e9fb2a/scratchpad/mineru-test/out.zip';
    const realPdf=process.env.LAB_MINERU_TEST_PDF || 'C:/Users/e2411/Documents/NCKUEE/CAT/論文/Mamba.pdf';
    if (fs.existsSync(realZip) && fs.existsSync(realPdf)) {
      let realCalls=0;
      const real=new AttachmentStore(fs.mkdtempSync(path.join(root,'real-')),{mineru:config,runMineru:async ({zip}) => {realCalls++; fs.copyFileSync(realZip,zip);}});
      const input=fs.readFileSync(realPdf).toString('base64');
      const uploaded=await real.add({name:'Mamba.pdf',data:input,mineru:true});
      const done=await waitFor(real,uploaded.id,['complete','failed']);
      assert.equal(done.mineru.state,'complete',done.mineru.error);
      const archiveEntries=await JSZip.loadAsync(fs.readFileSync(realZip));
      const imageFiles=Object.keys(archiveEntries.files).filter(name => name.startsWith('images/') && name.toLowerCase().endsWith('.jpg'));
      assert.ok(imageFiles.length); assert.equal(done.mineru.figures,imageFiles.length);
      const extracted=real.resolve([uploaded.id])[0];
      assert.match(extracted.text,/\$\$/); assert.ok(extracted.figures.some(figure => extracted.text.includes(figure.reference)));
      assert.equal((await real.add({name:'copy.pdf',data:input,mineru:true})).mineru.cacheHit,true);
      assert.equal(realCalls,1);
      console.log('Real MinerU archive verified: '+done.mineru.figures+' figures');
    } else console.log('Real MinerU archive fixture unavailable; skipping real archive check');

    // The server uses only a unique seeded cache; remove this test's upload and cache on exit.
    const crypto=require('node:crypto'), {spawn}=require('node:child_process');
    const appRoot=path.resolve(__dirname,'..');
    const uniquePdf=Buffer.concat([pdf,Buffer.from('\n% test-'+crypto.randomBytes(12).toString('hex'))]);
    const sha=crypto.createHash('sha256').update(uniquePdf).digest('hex');
    const cache=path.join(appRoot,'.codex-work','mineru-cache',sha);
    let server, uploadId, token, browser;
    try {
      fs.mkdirSync(path.join(cache,'images'),{recursive:true});
      fs.writeFileSync(path.join(cache,'markdown.md'),'# HTTP paper\n![plot](images/page_2_chart_1.jpg)');
      fs.writeFileSync(path.join(cache,'images','page_2_chart_1.jpg'),jpeg);
      fs.writeFileSync(path.join(cache,'cache.json'),JSON.stringify({sha,files:['page_2_chart_1.jpg'],createdAt:Date.now()}));
      server=spawn(process.execPath,[path.join(appRoot,'server.cjs')],{cwd:appRoot,windowsHide:true,env:{...process.env,LAB_SLIDES_PORT:'8783',LAB_MINERU_KIT:path.join(root,'missing')}});
      let errors=''; server.stderr.on('data',chunk => {errors+=chunk;});
      await new Promise((resolve,reject) => {
        const timer=setTimeout(() => reject(new Error('Server startup timed out: '+errors)),15000);
        server.stdout.on('data',chunk => {if(String(chunk).includes('Lab Slides ready:')) {clearTimeout(timer);resolve();}});
        server.once('exit',code => {clearTimeout(timer);reject(new Error('Server exited '+code+': '+errors));});
      });
      const base='http://127.0.0.1:8783', info=await (await fetch(base+'/api/info')).json();
      token=info.token; assert.equal(typeof info.mineru.available,'boolean');
      const post=async (route,body,auth=true) => {
        const response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-lab-token':token}:{})},body:JSON.stringify(body)});
        return {status:response.status,body:await response.json()};
      };
      assert.equal((await post('/api/codex/upload-status',{ids:[]},false)).status,403);
      const uploaded=await post('/api/codex/upload',{name:'http-test.pdf',data:uniquePdf.toString('base64'),mineru:true});
      assert.equal(uploaded.status,200); uploadId=uploaded.body.id;
      assert.equal(uploaded.body.mineru.state,'complete'); assert.equal(uploaded.body.mineru.cacheHit,true);
      assert.equal((await post('/api/codex/upload-status',{ids:[uploadId]})).body.attachments[0].mineru.state,'complete');
      const gallery=await post('/api/codex/figures',{id:uploadId});
      assert.equal(gallery.body.figures.length,1); assert.match(gallery.body.figures[0].dataURI,/^data:image\/jpeg;base64,/);
      const draft=await post('/api/draft',{text:'# Draft'});
      const inline=await post('/api/codex/insert-figure',{id:uploadId,file:'page_2_chart_1.jpg',documentId:draft.body.id});
      assert.match(inline.body.markdown,/data:image\/jpeg;base64,/);
      const slide=path.join(root,'http-deck.md'); fs.writeFileSync(slide,'# Deck');
      const opened=await post('/api/open',{path:slide});
      const saved=await post('/api/codex/insert-figure',{id:uploadId,file:'page_2_chart_1.jpg',documentId:opened.body.id});
      assert.match(saved.body.markdown,/assets\/http-test\/page_2_chart_1\.jpg/);
      assert.notEqual((await post('/api/codex/insert-figure',{id:uploadId,file:'../bad.jpg',documentId:opened.body.id})).status,200);
      // Intercept every AI request before navigation; all behavior below stays local.
      const puppeteer=require('puppeteer-core');
      const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file=>file&&fs.existsSync(file));
      assert.ok(chrome,'Set CHROME_PATH to Chrome or Edge for MinerU UI checks');
      browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--disable-gpu','--no-sandbox']});
      const page=await browser.newPage();
      await page.setViewport({width:1500,height:1000});
      let capability=true, pollComplete=false, renderCount=0;
      const sent=[];
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const pathname=new URL(request.url()).pathname;
        const json=value=>request.respond({status:200,contentType:'application/json',body:JSON.stringify(value)});
        if(pathname==='/api/info') return json({...info,mineru:{available:capability,reason:capability?'':'fixture unavailable'}});
        if(pathname==='/api/codex/status') return json({available:true,loggedIn:true,mineru:{available:capability,reason:capability?'':'fixture unavailable'}});
        if(pathname==='/api/codex/models') return json({models:[],defaultModel:null});
        if(pathname==='/api/codex/upload-status') return json({attachments:[{...uploaded.body,mineru:{state:pollComplete?'complete':'parsing',figures:1,startedAt:Date.now()}}]});
        if(pathname==='/api/codex/chat') {
          sent.push(JSON.parse(request.postData()));
          return request.respond({status:200,contentType:'text/event-stream',body:'event: complete\ndata: {"reply":"fixture","changed":false}\n\n'});
        }
        if(pathname==='/api/render') renderCount++;
        return request.continue();
      });
      await page.goto(base,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>!document.querySelector('#codex-mineru').disabled);
      assert.equal(await page.$eval('#codex-mineru',el=>el.checked),true);
      await page.click('#codex-mineru');
      assert.equal(await page.evaluate(()=>localStorage.getItem('lab-codex-mineru')),'false');
      await page.reload({waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>!document.querySelector('#codex-mineru').disabled);
      assert.equal(await page.$eval('#codex-mineru',el=>el.checked),false);
      capability=false;
      await page.reload({waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.querySelector('#mineru-reason').textContent.includes('fixture unavailable'));
      assert.equal(await page.$eval('#codex-mineru',el=>el.disabled),true);
      capability=true;
      await page.reload({waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled);
      await page.evaluate(doc=>applyDocument(doc,'original'),opened.body);
      await page.evaluate(item=>{chatAttachments=[item];drawAttachments();},uploaded.body);
      assert.match(await page.$eval('.mineru-state',el=>el.textContent),/1/);
      await page.evaluate(()=>{const editor=document.querySelector('#editor'); editor.value='before AFTER'; editor.setSelectionRange(7,7);});
      const rendersBefore=renderCount;
      await page.click('.attachment-chip button');
      await page.waitForSelector('#mineru-figures-grid button');
      const previewUpdated=page.waitForResponse(response=>response.url().endsWith('/api/render'));
      await page.click('#mineru-figures-grid button');
      await page.waitForFunction(()=>!document.querySelector('#mineru-figures-dialog').open);
      assert.match(await page.$eval('#editor',el=>el.value),/^before !\[w:900\]\(assets\/http-test\/page_2_chart_1\.jpg\)AFTER$/);
      await previewUpdated;
      assert.ok(renderCount>rendersBefore,'inserting a figure refreshes preview');

      const pending=()=>page.evaluate(item=>{chatAttachments=[{...item,mineru:{state:'parsing',startedAt:Date.now()}}];drawAttachments();},uploaded.body);
      const submit=async text=>{await page.$eval('#codex-input',(el,value)=>{el.value=value;},text); await page.$eval('#codex-form',el=>el.requestSubmit()); await page.waitForFunction(()=>document.querySelector('#mineru-wait-dialog').open);};
      await pending(); await submit('fast'); await page.click('#mineru-fast');
      await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled);
      assert.equal(sent.length,1); assert.equal(sent[0].fastText,true);
      await pending(); await submit('cancel'); await page.click('#mineru-cancel');
      await delay(300); assert.equal(sent.length,1);
      await pending(); await submit('wait'); await page.click('#mineru-wait');
      await delay(300); assert.equal(sent.length,1);
      pollComplete=true;
      await page.waitForFunction(()=>!document.querySelector('#codex-send').disabled,{timeout:5000});
      assert.equal(sent.length,2); assert.equal(sent[1].fastText,false);
      console.log('MinerU browser controls verified with mocked AI requests');
      console.log('MinerU HTTP routes verified on port 8783');
    } finally {
      if(browser) await browser.close();
      if(server && uploadId && token) try {await fetch('http://127.0.0.1:8783/api/codex/remove-upload',{method:'POST',headers:{'content-type':'application/json','x-lab-token':token},body:JSON.stringify({id:uploadId})});} catch {}
      if(server) {server.kill(); await new Promise(resolve => server.exitCode!==null ? resolve() : server.once('exit',resolve));}
      fs.rmSync(cache,{recursive:true,force:true});
    }
    console.log('MinerU attachment checks passed');
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
