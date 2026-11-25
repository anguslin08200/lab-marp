// Exercise the local workbench against disposable files; never modify a user document.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const puppeteer = require('puppeteer-core');

const base = `http://127.0.0.1:${Number(process.env.LAB_SLIDES_PORT || 8771)}`;
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  assert(chrome, 'Set CHROME_PATH to a Chrome or Edge executable.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-marp-ux-'));
  const file = path.join(directory, '驗收 fixture.md');
  const fixture = '---\nmarp: true\nsize: 16:9\n---\n# First slide\n\n---\n\n# Second slide\n\n<style scoped>h1{color:#174f78;animation:pulse 0s}@keyframes pulse{from{opacity:1}to{opacity:1}}</style>\n\n---\n\n# Third slide\n\n![width:200px](image.jpg)\n';
  fs.writeFileSync(file, fixture, 'utf8');
  fs.copyFileSync(path.join(root, 'slides/assets/circuit.jpg'), path.join(directory, 'image.jpg'));
  fs.copyFileSync(path.join(root, 'slides/assets/circuit.jpg'), path.join(directory, 'image(1).jpg'));
  fs.mkdirSync(path.join(directory, 'folder'));
  let browser, page, phase = 'API checks';
  try {
    const infoResponse = await fetch(`${base}/api/info`);
    assert.equal(infoResponse.status, 200);
    const {token} = await infoResponse.json();
    async function post(route, body, binary = false) {
      const response = await fetch(`${base}/api/${route}`, {method:'POST', headers:{'Content-Type':'application/json', 'X-Lab-Token':token}, body:JSON.stringify(body)});
      assert.equal(response.status, 200, `${route}: ${response.status} ${response.ok ? '' : await response.text()}`);
      return binary ? {response, bytes:Buffer.from(await response.arrayBuffer())} : response.json();
    }
    const doc = await post('open', {path:file});
    assert.equal(doc.text, fixture); assert(Number.isFinite(doc.mtimeMs));
    const themed = await post('render', {id:doc.id, text:fixture, format:'dark'});
    assert.match(themed.source, /^style: \|[+-]?\s*$/m);
    const meta = yaml.load(themed.source.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert(meta.style.includes('#132334'));
    assert(!meta.style.includes('\r')); assert(!/[ \t]+$/m.test(meta.style));
    const reopened = await post('render', {id:doc.id, text:themed.source, format:'original'});
    assert(reopened.html.includes('#132334'));
    const catlab=await post('render',{id:doc.id,text:fixture,format:'catlab'});
    assert.match(catlab.source,/^style: \|[+-]?\s*$/m);
    const catlabMeta=yaml.load(catlab.source.match(/^---\n([\s\S]*?)\n---/)[1]);assert(catlabMeta.style.includes('--catlab-navy'));assert(!catlabMeta.style.includes('\r'));
    // Older quoted YAML styles remain readable alongside the new literal representation.
    const oldSource = '---\nmarp: true\nstyle: "section {\\n  color: red;\\n}"\n---\n# Legacy\n';
    const legacy = await post('render', {id:doc.id, text:oldSource, format:'original'});
    assert(legacy.html.includes('color: red'));
    const listing = await post('browse', {dir:directory, id:doc.id});
    assert.equal(path.resolve(listing.dir), path.resolve(directory));
    assert(listing.entries.some(e => e.name === 'folder' && e.directory));
    assert(listing.entries.some(e => e.name === path.basename(file) && !e.directory));
    assert(!listing.entries.some(e => e.name === 'image.jpg'));
    assert.equal(path.resolve(listing.parent), path.resolve(path.dirname(directory)));
    assert(Array.isArray(listing.drives) && listing.drives.length);
    const draft = await post('draft', {text:'# Untitled draft', name:'draft.md'});
    assert(draft.id && draft.untitled && draft.text === '# Untitled draft');
    assert.equal(draft.path, '未命名草稿.md');
    // Theme registration, balanced image paths and ordinary links must survive portable export.
    const exportFixture=fixture.replace('marp: true','marp: true\ntheme: lab').replace('(image.jpg)','(image(1).jpg)')+'\nLiteral image(1).jpg\n\n[Email](mailto:qa@example.com) [Notes](notes.md)\n';
    for (const format of ['html','pptx']) {
      const {response, bytes} = await post('export', {id:doc.id, text:exportFixture, format:'original', exportFormat:format}, true);
      assert(bytes.length > 100, `${format} export is empty`);
      assert.match(response.headers.get('content-disposition') || '', new RegExp(`\\.${format}`, 'i'));
      if (format === 'pptx') {
        assert.match(response.headers.get('content-type') || '', /presentationml/i);
        assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
      } else {
        assert.match(response.headers.get('content-type') || '', /text\/html/i);
        assert.match(bytes.toString('utf8'), /<!doctype html>/i);
        assert.match(bytes.toString('utf8'), /data:image\/jpeg;base64,/i);
        assert(bytes.toString('utf8').includes('Literal image(1).jpg'));
        assert(bytes.toString('utf8').includes('mailto:qa@example.com'));
        assert(bytes.toString('utf8').includes('href="notes.md"'));
      }
    }

    browser = await puppeteer.launch({executablePath:chrome, headless:true});
    page = await browser.newPage();
    await page.setViewport({width:1600, height:1000});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // Keep the acceptance test offline from Codex and prevent incidental CLI startup.
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/codex/status') return request.respond({status:200, contentType:'application/json', body:JSON.stringify({available:false, loggedIn:false})});
      if (pathname === '/api/codex/models') return request.respond({status:200, contentType:'application/json', body:JSON.stringify({models:[]})});
      if (pathname === '/api/codex/chat') return request.abort();
      return request.continue();
    });
    phase = 'initial load';
    await page.goto(base, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.querySelector('#page-count').textContent.trim() && document.querySelector('#preview').contentDocument?.querySelector('.marpit > svg'));
    await page.evaluate(doc => applyDocument(doc, 'original'), doc);
    await page.waitForFunction(() => document.querySelector('#page-count').textContent === '3 頁' && document.querySelector('#preview').contentDocument?.querySelectorAll('.marpit > svg').length === 3);
    await page.waitForFunction(() => [...document.querySelector('#preview').contentDocument.images].every(image => image.complete && image.naturalWidth > 0));
    // System dark mode changes only the workbench chrome, leaving the authored slides intact.
    const slideBackground=await page.evaluate(()=>getComputedStyle(document.querySelector('#preview').contentDocument.querySelector('section')).backgroundColor);
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'dark'}]);
    assert.equal(await page.$eval('.toolbar',element=>getComputedStyle(element).backgroundColor),'rgb(23, 38, 56)');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#preview').contentDocument.querySelector('section')).backgroundColor),slideBackground);
    await page.screenshot({path:path.join(root,'output/workbench-dark.png')});
    await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'light'}]);
    // Wrapped text and its selection mirror share geometry; line numbers return when wrapping is off.
    assert(await page.$eval('#wrap-editor', input => input.checked));
    let geometry = await page.evaluate(() => ({wrapped:document.querySelector('.editor-frame').classList.contains('wrapped'), whiteSpace:getComputedStyle(document.querySelector('#source-selection-text')).whiteSpace, gutter:document.querySelector('#line-numbers').getBoundingClientRect().width}));
    assert(geometry.wrapped); assert.equal(geometry.whiteSpace, 'pre-wrap'); assert.equal(geometry.gutter, 0);
    await page.click('#wrap-editor');
    geometry = await page.evaluate(() => ({wrapped:document.querySelector('.editor-frame').classList.contains('wrapped'), gutter:document.querySelector('#line-numbers').getBoundingClientRect().width}));
    assert(!geometry.wrapped); assert(geometry.gutter > 0);
    await page.click('#wrap-editor');
    phase = 'incremental preview';
    // A body-only edit keeps the iframe and unchanged slide/image nodes alive.
    await page.evaluate(() => {
      const frame = document.querySelector('#preview');
      frame.contentWindow.qaMarker = 'preserved';
      window.qaThirdSlide = frame.contentDocument.querySelectorAll('.marpit > svg')[2];
      window.qaImage = frame.contentDocument.querySelector('img');
      document.addEventListener('lab-preview', event => { window.qaLastPreview = event.detail.text; });
      const editor = document.querySelector('#editor'); editor.value = editor.value.replace('First slide', 'Edited slide'); editor.dispatchEvent(new Event('input', {bubbles:true}));
    });
    await page.waitForFunction(() => window.qaLastPreview?.includes('Edited slide') && document.querySelector('#preview').contentDocument.querySelector('h1')?.textContent === 'Edited slide');
    assert.equal(await page.evaluate(() => document.querySelector('#preview').contentWindow.qaMarker), 'preserved');
    assert(await page.evaluate(() => window.qaThirdSlide === document.querySelector('#preview').contentDocument.querySelectorAll('.marpit > svg')[2]), 'unchanged third slide should retain identity');
    assert(await page.evaluate(() => window.qaImage && window.qaImage === document.querySelector('#preview').contentDocument.querySelector('img')), 'unchanged image should retain identity');
    // Incremental rendering must also add and remove pages without replacing the iframe.
    await page.evaluate(()=>{const editor=document.querySelector('#editor');window.qaEditedText=editor.value;editor.value+='\n---\n\n# Fourth slide';editor.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector('#page-count').textContent==='4 頁'&&slideNodes().length===4);
    assert.equal(await page.evaluate(()=>document.querySelector('#preview').contentWindow.qaMarker),'preserved');
    await page.evaluate(()=>{const editor=document.querySelector('#editor');editor.value=window.qaEditedText;editor.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector('#page-count').textContent==='3 頁'&&slideNodes().length===3);
    await page.$eval('#sync-scroll', input => { if (input.checked) input.click(); });
    await page.click('#next-slide');
    await page.waitForFunction(() => /第\s*2\s*\//.test(document.querySelector('#current-page').textContent));
    await page.click('#previous-slide');
    await page.waitForFunction(() => /第\s*1\s*\//.test(document.querySelector('#current-page').textContent));
    await page.click('#toggle-thumbnails');
    await page.waitForFunction(() => document.querySelector('#thumbnails').getBoundingClientRect().height > 0);
    await page.waitForFunction(() => [...document.querySelector('#thumbnails').children].flatMap(button => [...button.firstElementChild.shadowRoot.querySelectorAll('img')]).every(image => image.complete && image.naturalWidth > 0));
    await page.click('#thumbnails button:nth-child(3)');
    await page.waitForFunction(()=>/第\s*3\s*\//.test(document.querySelector('#current-page').textContent));
    assert.equal(await page.$eval('#editor',editor=>editor.value.slice(0,editor.selectionStart).split('\n').length-1),await page.evaluate(()=>previewMap[2]));
    await page.click('#thumbnails button:first-child');
    await page.screenshot({path:path.join(root,'output/workbench-ux.png')});
    phase = 'open presentation';
    await page.click('#present');
    await page.waitForFunction(() => document.querySelector('#presentation').getBoundingClientRect().height > 0 && document.querySelector('#presentation-preview').contentDocument?.querySelector('.marpit > svg'));
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => /2\s*\//.test(document.querySelector('#presentation-count').textContent));
    phase = 'first presentation escape';
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#presentation').getBoundingClientRect().height === 0);
    phase = 'F5 presentation reopen';
    await page.keyboard.press('F5');
    await page.waitForFunction(() => document.querySelector('#presentation').getBoundingClientRect().height > 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#presentation').getBoundingClientRect().height === 0);

    phase = 'draft recovery';
    // Backups are generated by a real edit and restored through the visible recovery banner.
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('lab-draft:') && localStorage.getItem(key).includes('Edited slide')), {timeout:10000});
    await page.evaluate(doc => applyDocument(doc, 'original'), doc);
    await page.waitForFunction(() => document.querySelector('#draft-recovery').getBoundingClientRect().height > 0);
    await page.click('#draft-restore');
    await page.waitForFunction(() => document.querySelector('#editor').value.includes('Edited slide'));
    assert.deepEqual(errors, []);
    assert.equal(fs.readFileSync(file, 'utf8'), fixture);
    // Saving a disposable fixture clears its backup; independently dropped drafts keep separate copies.
    phase = 'save cleanup and unnamed recovery';
    await page.click('#save');
    await page.waitForFunction(() => !dirty && !localStorage.getItem(currentDraftKey()));
    assert(fs.readFileSync(file,'utf8').includes('Edited slide'));
    for(const name of ['A','B']){
      await page.evaluate(name=>{const data=new DataTransfer();data.items.add(new File(['# Dropped '+name],name+'.md',{type:'text/markdown'}));document.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));},name);
      await page.waitForFunction(name=>current?.untitled&&document.querySelector('#editor').value==='# Dropped '+name,{},name);
      await page.waitForFunction(name=>untitledBackups().some(item=>item.text==='# Dropped '+name),{},name);
      if(name==='A')page.once('dialog',dialog=>dialog.accept());
    }
    assert.equal(await page.evaluate(()=>untitledBackups().length),2);
    await page.click('#open');
    await page.waitForFunction(()=>document.querySelectorAll('#untitled-drafts button').length===2);
    page.once('dialog',dialog=>dialog.accept());await page.click('#untitled-drafts button:last-child');
    await page.waitForFunction(()=>document.querySelector('#editor').value==='# Dropped A');
    console.log(JSON.stringify({yaml:true, legacyYaml:true, browse:true, draft:true, exports:true, incrementalPreview:true, addRemoveSlides:true, wrapAndGutter:true, navigation:true, thumbnailImages:true, presentation:true, recovery:true, saveClearsBackup:true, multipleUnnamedDrafts:true, relativeImage:true}));
  } catch (error) {
    console.error('UX check failed during:', phase);
    if (page && !page.isClosed()) {
      try {
        console.error('browser state:', await page.evaluate(() => ({fullscreen:document.fullscreenElement?.id || null, active:document.activeElement?.id || document.activeElement?.tagName, hidden:document.querySelector('#presentation')?.hidden, count:document.querySelector('#presentation-count')?.textContent, focus:document.hasFocus(), url:location.href})));
        fs.mkdirSync(path.join(root, 'output'), {recursive:true});
        await page.screenshot({path:path.join(root, 'output/ux-check-failure.png')});
      } catch (diagnosticError) { console.error('Could not capture browser state:', diagnosticError.message); }
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    // The only recursively removed path is the unique directory created above.
    fs.rmSync(directory, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
