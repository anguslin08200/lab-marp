// Local slide workbench; explicitly submitted Codex messages use the user's CLI login.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Marp } = require('@marp-team/marp-core');
const yaml = require('js-yaml');
const puppeteer = require('puppeteer-core');
const {CodexBridge}=require('./codex-bridge.cjs');
const {AttachmentStore}=require('./attachments.cjs');
// Render-only source metadata supports selection without changing saved Markdown.
const {sourceSelection}=require('./selection-source.cjs');
const runFile = promisify(execFile);
const ROOT = __dirname;
const PORT = Number(process.env.LAB_SLIDES_PORT || 8766);
const documents = new Map();
const formats = [
  {id:'original', name:'Markdown 原有格式', description:'保留檔案內的字型與版面'},
  {id:'catlab', name:'CATLab', description:'依提供的論文簡報 PDF 整理'},
  {id:'lab', name:'研究會議', description:'藍白配色，適合進度與量測結果'},
  {id:'minimal', name:'簡潔學術', description:'白底黑字，適合論文與公式'},
  {id:'dark', name:'深色展示', description:'深藍底色，適合圖片與成果展示'}
];
const themeFiles = {catlab:'templates/catlab.css', lab:'themes/lab.css', minimal:'themes/minimal.css', dark:'themes/dark.css'};
const token = crypto.randomBytes(24).toString('hex');
let exporting = false;
const codex=new CodexBridge(ROOT);
const attachments=new AttachmentStore(ROOT);

// Releasing the HTTP request also closes its native picker, preventing abandoned hidden dialogs.
async function pickFile(req,res,args=[]){
  const controller=new AbortController();const closed=()=>controller.abort();res.on('close',closed);
  try{
    const result=await runFile('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts/pick-file.ps1'),...args],{windowsHide:true,encoding:'utf8',timeout:120000,signal:controller.signal});
    return result.stdout.trim();
  }catch(e){if(controller.signal.aborted)return '';if(e.killed)throw new Error('選檔等待逾時。請重新開啟並直接貼上 Markdown 路徑。');throw e;}
  finally{res.removeListener('close',closed);}
}

// A document handle authorizes only its selected directory and its own save target.
async function openDocument(filePath) {
  // Reject invalid paths before filesystem access and translate common errors into actionable text.
  if(typeof filePath!=='string'||!path.isAbsolute(filePath))throw new Error('請輸入 Markdown 的完整路徑，例如 C:\\Users\\<使用者>\\Documents\\report.md。');
  if(!/\.md$/i.test(filePath))throw new Error('請選擇 .md 檔案。');
  let absolute;try{absolute=await fsp.realpath(filePath);}catch(e){if(e.code==='ENOENT')throw new Error('找不到檔案，請確認 Markdown 路徑。');throw e;}
  if (!/\.md$/i.test(absolute)) throw new Error('請選擇 .md 檔案。');
  const text = await fsp.readFile(absolute, 'utf8');
  const id = crypto.randomBytes(12).toString('hex');
  documents.set(id, {path:absolute, directory:path.dirname(absolute)});
  const {mtimeMs}=await fsp.stat(absolute);
  return {id, path:absolute, text, mtimeMs};
}
function splitSource(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {meta:{}, body:text};
  const meta = yaml.load(match[1]) || {};
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Markdown 開頭的設定需為 YAML 欄位。');
  return {meta, body:text.replace(/^\uFEFF/, '').slice(match[0].length)};
}
// Bake a chosen theme into the saved Markdown so it remains portable without this app.
function styledSource(text, format) {
  if (!format || format === 'original') return text;
  if (!themeFiles[format]) throw new Error('未知的格式。');
  const {meta, body} = splitSource(text);
  const css = fs.readFileSync(path.join(ROOT, themeFiles[format]), 'utf8');
  const defaults = format === 'catlab' ? {footer:'', size:'16:9'} : {footer:'Research Meeting', size:'16:9'};
  return `---\n${yaml.dump({...meta, ...defaults, marp:true, theme:'default', paginate:true,
    // Normalize line endings and trailing spaces so js-yaml emits a readable literal block.
    style:css.replace(/@import\s+['"]default['"]\s*;/g, '').replace(/\/\*\s*@theme[\s\S]*?\*\//g, '').replace(/\r\n?/g,'\n').replace(/[ \t]+$/gm,'')}, {lineWidth:-1})}---\n\n${body}`;
}
function renderDocument(text, format, id) {
  const marp = new Marp({html:true, math:'katex'});
  for (const file of Object.values(themeFiles)) {
    if (fs.existsSync(path.join(ROOT,file))) marp.themeSet.add(fs.readFileSync(path.join(ROOT,file),'utf8'));
  }
  const source = styledSource(text, format);
  const selectionBlocks=sourceSelection(marp,text,source);
  const rendered = marp.render(source);
  // Preview and export do not execute embedded Markdown scripts.
  const html=rendered.html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'');
  const css=rendered.css;
  const boxes = [...html.matchAll(/<svg\b[^>]*data-marpit-svg[^>]*>/g)].map(m => m[0].match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number));
  const [, , width=1280, height=720] = boxes[0] || [];
  // iframe sandbox disables Markdown scripts; PDF uses this same HTML and CSS.
  const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><base href="http://127.0.0.1:${PORT}/assets/${id}/"><style>${css}</style><style>
    html,body {margin:0; padding:0; background:#e9edf2} .marpit {display:grid; gap:18px; padding:20px; box-sizing:border-box}
    .marpit>svg {display:block;width:100%;height:auto;box-shadow:0 3px 14px #13263a22}
    @page {size:${width}px ${height}px; margin:0}
    @media print {html,body{background:white}.marpit{display:block;padding:0}.marpit>svg{width:${width}px;height:${height}px;box-shadow:none;break-after:page}.marpit>svg:last-child{break-after:auto}}
    </style></head><body><div class="marpit">${html}</div></body></html>`;
  // Use Marp's own source maps so YAML, code fences and thematic breaks match the rendered pages.
  // Parse the original draft separately so chosen themes cannot shift scroll anchors or metadata.
  const slideLines=new Marp({html:true,math:'katex'}).markdown.parse(text,{}).filter(t=>t.type==='marpit_slide_open').map(t=>t.map?.[0]||0);
  return {html:documentHtml, pages:boxes.length, width, height, source, slideLines, selectionBlocks};
}
async function requestBody(req) {
  // Count raw bytes once so base64 uploads and portable image Markdown do not cause quadratic copying.
  const chunks=[];let bytes=0;
  for await (const chunk of req) {bytes+=chunk.length;if(bytes>48*1024*1024)throw new Error('請求過大，請減少圖片或附件。');chunks.push(chunk);}
  return bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function reply(res, data, status=200) {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function getDocument(id) {const doc=documents.get(id);if(!doc) throw new Error('請重新選擇 Markdown。');return doc;}
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.woff2':'font/woff2'};
async function sendFile(res, filename) {const body=await fsp.readFile(filename);res.writeHead(200, {'Content-Type':mime[path.extname(filename)]||'application/octet-stream'});res.end(body);}
function browserPath() {
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const found=candidates.find(p=>p&&fs.existsSync(p));if(!found)throw new Error('PDF 匯出需要 Chrome 或 Edge。');return found;
}
// Browse only after the local UI supplies the session token; report actual drive roots.
async function browseDirectory(body) {
  const requested=body.dir || (body.id && getDocument(body.id).directory) || os.homedir();
  if(typeof requested!=='string'||!path.isAbsolute(requested))throw new Error('請輸入資料夾的完整路徑。');
  const dir=await fsp.realpath(requested);
  const items=await fsp.readdir(dir,{withFileTypes:true});
  const entries=items.filter(item=>item.isDirectory()||(item.isFile()&&/\.md$/i.test(item.name)))
    .map(item=>({name:item.name,path:path.join(dir,item.name),directory:item.isDirectory()}))
    .sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,undefined,{numeric:true}));
  const root=path.parse(dir).root;
  const candidates=process.platform==='win32'?'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter=>`${letter}:\\`):['/'];
  const drives=(await Promise.all(candidates.map(async candidate=>{try{await fsp.access(candidate);return candidate;}catch{return null;}}))).filter(Boolean);
  const parent=dir===root?null:path.dirname(dir);
  return {dir,parent,entries,drives};
}
// Replace local image and font references with data URLs for a portable HTML download.
async function standaloneHtml(html,doc,id,source) {
  const base=`http://127.0.0.1:${PORT}/assets/${id}/`;
  const cache=new Map();
  // Resolve only resource URLs, never navigation links or arbitrary text.
  async function inline(ref){
    if(/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(ref))return ref;
    const clean=decodeURIComponent(ref.replace(/\\([ ()])/g,'$1').replace(/&amp;/g,'&').split(/[?#]/)[0]);
    if(cache.has(clean))return cache.get(clean);
    const target=await fsp.realpath(path.resolve(doc.directory,clean));
    const relative=path.relative(doc.directory,target);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('圖片需放在 Markdown 所在資料夾或子資料夾。');
    const bytes=await fsp.readFile(target);
    const type=(mime[path.extname(target).toLowerCase()]||'application/octet-stream').split(';')[0];
    const data=`data:${type};base64,${bytes.toString('base64')}`;
    cache.set(clean,data);return data;
  }
  // Apply replacements at matched syntax positions so identical prose is untouched.
  async function replaceAsync(text,pattern,replace){
    let result='',last=0;
    for(const match of text.matchAll(pattern)){result+=text.slice(last,match.index)+await replace(match);last=match.index+match[0].length;}
    return result+text.slice(last);
  }
  async function cssResources(css){
    // Marp can encode CSS quotes as HTML entities inside SVG attributes.
    return replaceAsync(css,/url\(\s*(?:(&quot;|&#39;|["'])([\s\S]*?)\1|([^"')\s]+))\s*\)/gi,async m=>`url(${m[1]||''}${await inline(m[2]??m[3])}${m[1]||''})`);
  }
  async function resources(text){
    text=await replaceAsync(text,/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,async m=>cssResources(m[0]));
    return replaceAsync(text,/<[a-z][^>]*>/gi,async tag=>{
      let value=await replaceAsync(tag[0],/\bstyle\s*=\s*(["'])(.*?)\1/gi,async m=>`style=${m[1]}${await cssResources(m[2])}${m[1]}`);
      if(/^<(?:img|image|source|video|audio)\b/i.test(value))value=await replaceAsync(value,/\b(src|href|xlink:href|poster)\s*=\s*(["'])(.*?)\2/gi,async m=>`${m[1]}=${m[2]}${await inline(m[3])}${m[2]}`);
      return value;
    });
  }
  if(source===undefined)return (await resources(html)).replace(`<base href="${base}">`,'');
  // Inline Markdown image destinations and image-reference definitions for CLI stdin.
  const front=source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(front){
    const meta=yaml.load(front[1]);
    if(meta&&typeof meta==='object'&&typeof meta.style==='string'){
      const updated=await cssResources(meta.style);
      if(updated!==meta.style){meta.style=updated;source=`---\n${yaml.dump(meta,{lineWidth:-1})}---\n`+source.slice(front[0].length);}
    }
  }
  const definitions=new Map();
  for(const m of source.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]+>|(?:\\.|[^\s])+)/gm)){
    const key=m[1].trim().replace(/\s+/g,' ').toLowerCase();
    if(!definitions.has(key))definitions.set(key,m[2].startsWith('<')?m[2].slice(1,-1):m[2]);
  }
  const markdown=new Marp().markdown;
  async function sourceResources(part){
    // Use Marp's Markdown parser to find balanced image destinations, including parentheses.
    const state=new markdown.inline.State(part,markdown,{},[]);let result='',last=0,index=0;
    while((index=part.indexOf('![',index))!==-1){
      const end=markdown.helpers.parseLinkLabel(state,index+1,false);
      if(end<0||part[end+1]!=='('){index+=2;continue;}
      let start=end+2;while(/[ \t\n]/.test(part[start]||'')&&start<part.length)start++;
      const destination=markdown.helpers.parseLinkDestination(part,start,part.length);
      if(!destination.ok){index=end+2;continue;}
      result+=part.slice(last,start)+await inline(destination.str);last=destination.pos;index=destination.pos;
    }
    part=result+part.slice(last);
    // Convert image references at their use sites; shared link definitions stay intact.
    part=await replaceAsync(part,/!\[([^\]]*)\](?:\[([^\]]*)\]|(?![\[(]))/g,async m=>{
      const key=(m[2]||m[1]).trim().replace(/\s+/g,' ').toLowerCase();
      return definitions.has(key)?`![${m[1]}](${await inline(definitions.get(key))})`:m[0];
    });
    return resources(part);
  }
  // Fenced and inline code examples must remain literal, including image syntax.
  async function prose(part){
    // Remove executable script elements while retaining literal inline-code examples.
    const codeRanges=[...part.matchAll(/(`+)([\s\S]*?)\1/g)].map(m=>[m.index,m.index+m[0].length]);
    part=await replaceAsync(part,/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,async m=>codeRanges.some(([start,end])=>m.index>=start&&m.index<end)?m[0]:'');
    let result='',last=0;
    for(const m of part.matchAll(/(`+)([\s\S]*?)\1/g)){result+=await sourceResources(part.slice(last,m.index));result+=m[0];last=m.index+m[0].length;}
    return result+await sourceResources(part.slice(last));
  }
  let output='',pending='',fence=null;
  for(const line of source.match(/[^\n]*\n|[^\n]+$/g)||[]){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(!fence&&marker){output+=await prose(pending)+line;pending='';fence=marker[1];}
    else if(fence){output+=line;if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;}
    else pending+=line;
  }
  return output+await prose(pending);
}
// Feed the current draft through the installed Marp CLI with the document directory as its base.
async function exportPptx(source,doc) {
  const temporary=await fsp.mkdtemp(path.join(os.tmpdir(),'lab-marp-export-'));
  const output=path.join(temporary,'slides.pptx');
  try {
    await new Promise((resolve,reject)=>{
      // Register the same custom themes as preview, including for original frontmatter.
      const themes=Object.values(themeFiles).map(file=>path.join(ROOT,file)).filter(file=>fs.existsSync(file)).flatMap(file=>['--theme-set',file]);
      const child=spawn(process.execPath,[path.join(ROOT,'node_modules/@marp-team/marp-cli/marp-cli.js'),'-','--pptx','--allow-local-files',...themes,'-o',output],{cwd:doc.directory,windowsHide:true,env:{...process.env,CHROME_PATH:browserPath()}});
      let errors='';child.stderr.on('data',chunk=>{errors+=chunk.toString();});
      // Avoid leaving an export and its temporary files stuck if the browser fails to start.
      const timeout=setTimeout(()=>child.kill(),60000);
      child.on('error',error=>{clearTimeout(timeout);reject(error);});child.on('close',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(`PPTX 匯出失敗：${errors.trim()||'匯出逾時或程序已結束。'}`));});
      child.stdin.on('error',()=>{});child.stdin.end(source,'utf8');
    });
    return await fsp.readFile(output);
  } finally {await fsp.rm(temporary,{recursive:true,force:true});}
}
// Reject cross-origin mutations and bind only to loopback; no remote file API is exposed.
const server = http.createServer(async (req,res) => {
  try {
    if (![ `127.0.0.1:${PORT}`, `localhost:${PORT}` ].includes(req.headers.host)) return reply(res,{error:'Invalid host'},403);
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method==='POST' && req.headers['x-lab-token']!==token) return reply(res,{error:'請重新整理啟動介面。'},403);
    if (req.method==='GET' && url.pathname==='/api/info') {
      return reply(res,{app:'lab-marp-workbench', token, formats:formats.filter(f=>f.id==='original'||fs.existsSync(path.join(ROOT,themeFiles[f.id]))), defaultPath:path.join(ROOT,'slides/index.md'),mineru:{available:attachments.mineru.available,reason:attachments.mineru.reason}});
    }
    if (req.method==='GET' && url.pathname.startsWith('/assets/')) {
      const [, , id, ...parts] = url.pathname.split('/');
      const doc=getDocument(id); const target=path.resolve(doc.directory, decodeURIComponent(parts.join('/')));
      const real=await fsp.realpath(target);
      const relative=path.relative(doc.directory,real);
      if(relative.startsWith('..')||path.isAbsolute(relative)) return reply(res,{error:'圖片需放在 Markdown 所在資料夾或子資料夾。'},403);
      return sendFile(res,real);
    }
    if (req.method==='POST') {
      const body=await requestBody(req);
      if (url.pathname==='/api/codex/status') {
        try{return reply(res,{...await codex.status(),mineru:{available:attachments.mineru.available,reason:attachments.mineru.reason}});}catch(e){return reply(res,{available:false,loggedIn:false,error:e.message,mineru:{available:attachments.mineru.available,reason:attachments.mineru.reason}});}
      }
      if (url.pathname==='/api/codex/models') {const catalog=await codex.models();return reply(res,{models:catalog.models,defaultModel:catalog.defaultModel,defaultEffort:catalog.defaultEffort});}
      // All paper routes require the same session token as uploads and derive paths from IDs.
      if (url.pathname==='/api/codex/upload-status') return reply(res,{attachments:attachments.status(body.ids)});
      if (url.pathname==='/api/codex/figures') return reply(res,{figures:attachments.figures(body.id)});
      if (url.pathname==='/api/codex/insert-figure') return reply(res,attachments.insertFigure(body.id,body.file,getDocument(body.documentId)));
      if (url.pathname==='/api/codex/upload') return reply(res,await attachments.add(body));
      if (url.pathname==='/api/codex/remove-upload') {await attachments.remove(body.id);return reply(res,{ok:true});}
      if (url.pathname==='/api/codex/cancel') {await codex.cancel(body.sessionId);return reply(res,{ok:true});}
      if (url.pathname==='/api/codex/reset') {codex.reset(body.sessionId);return reply(res,{ok:true});}
      if (url.pathname==='/api/codex/chat') {
        getDocument(body.id);
        if(typeof body.message!=='string'||!body.message.trim()||body.message.length>8000)throw new Error('請輸入 1 至 8000 字的修改要求。');
        if(typeof body.text!=='string'||body.text.length>36000000)throw new Error('Markdown 過大，請先減少內嵌資料。');
        if(body.model!==undefined&&typeof body.model!=='string')throw new Error('模型設定不正確。');
        // Reject malformed effort before opening the streaming response.
        if(body.effort!==undefined&&typeof body.effort!=='string')throw new Error('Effort 設定不正確。');
        // Only the explicit boolean choice can bypass waiting for a pending paper.
        if (body.fastText!==undefined && typeof body.fastText!=='boolean') throw new Error('快速文字設定不正確。');
        // A client must explicitly choose fast text while background parsing is pending.
        if (!body.fastText && attachments.status(body.attachmentIds||[]).some(item=>['queued','parsing'].includes(item.mineru?.state))) throw new Error('論文仍在解析，等待或改用快速文字。');
        const selectedAttachments=attachments.resolve(body.attachmentIds||[],{fastText:body.fastText===true});
        const source=styledSource(body.text,body.format);
        const abort=new AbortController();let ended=false;
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
        const emit=(event,data)=>{if(!res.destroyed&&!ended)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
        const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);
        res.on('close',()=>{if(!ended)abort.abort();});
        try {
          const result=await codex.chat({sessionId:body.sessionId||null,text:body.message.trim(),source,format:body.format,model:body.model,effort:body.effort,attachments:selectedAttachments,emit,signal:abort.signal});
          if(abort.signal.aborted)throw new Error('已停止，Markdown 未更改。');
          // Validate proposed Markdown with the same renderer before allowing UI application.
          emit('status',{text:'已收到完整 Markdown，正在檢查投影片排版…'});
          const format=result.format||(result.markdown!==null?'original':body.format);
          const candidate=result.markdown??body.text;
          const rendered=renderDocument(candidate,format,body.id);
          if(!rendered.pages)throw new Error('Codex 回傳的簡報沒有內容，尚未套用。');
          const changed=(result.markdown!==null&&result.markdown!==source)||format!==body.format;
          emit('complete',{...result,markdown:result.markdown,format,changed,baseId:body.id});
        }catch(e){emit('error',{message:e.message});}
        finally{ended=true;clearInterval(heartbeat);res.end();}
        return;
      }
      // Draft handles have a safe asset base and acquire a real path only through Save As.
      if (url.pathname==='/api/draft') {
        if(typeof body.text!=='string')throw new Error('請提供 Markdown 內容。');
        const id=crypto.randomBytes(12).toString('hex');
        documents.set(id,{path:null,directory:os.homedir(),untitled:true});
        return reply(res,{id,path:'未命名草稿.md',text:body.text,untitled:true,mtimeMs:0});
      }
      if (url.pathname==='/api/browse') return reply(res,await browseDirectory(body));
      if (url.pathname==='/api/open') {
        let selected=body.path;
        if (!selected) selected=await pickFile(req,res);
        if(res.destroyed)return;
        return selected ? reply(res,await openDocument(selected)) : reply(res,{cancelled:true});
      }
      if (url.pathname==='/api/template') {
        const selected=body.format==='catlab'?path.join(ROOT,'templates/catlab.md'):path.join(ROOT,'slides/starter.md');
        // A template is an unsaved starting point; gallery insertion must not write into templates.
        const template = await openDocument(selected);
        documents.get(template.id).template = true;
        return reply(res,{...template, template:true});
      }
      if (url.pathname==='/api/render') {getDocument(body.id);return reply(res,renderDocument(body.text,body.format,body.id));}
      if (url.pathname==='/api/reload') {const doc=getDocument(body.id);if(doc.untitled)throw new Error('草稿尚未儲存，無法重新載入。');return reply(res,{text:await fsp.readFile(doc.path,'utf8')});}
      if (url.pathname==='/api/save') {
        const doc=getDocument(body.id);
        // Templates are immutable starting points; saving them always opens Save As.
        const isTemplate=doc.untitled||path.relative(path.join(ROOT,'templates'),doc.path).startsWith('..')===false||doc.path===path.join(ROOT,'slides/starter.md');
        let destination=doc.path;
        if(body.saveAs||isTemplate) {
          destination=await pickFile(req,res,['-Save','-InitialDirectory',doc.directory]);
          if(res.destroyed)return;
          if(!destination)return reply(res,{cancelled:true});
        }
        await fsp.writeFile(destination,styledSource(body.text,body.format),'utf8');
        return reply(res,await openDocument(destination));
      }
      if (url.pathname==='/api/export') {
        const doc=getDocument(body.id);if(exporting)return reply(res,{error:'另一份簡報正在匯出，請稍候。'},409);
        const exportFormat=body.exportFormat||'pdf';
        if(!['pdf','pptx','html'].includes(exportFormat))throw new Error('未知的匯出格式。');
        exporting=true;let browser;
        try {
          const rendered=renderDocument(body.text,body.format,body.id);
          if(exportFormat==='html'){
            const html=await standaloneHtml(rendered.html,doc,body.id);
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Disposition':'attachment; filename=slides.html','Cache-Control':'no-store'});res.end(html);return;
          }
          if(exportFormat==='pptx'){
            const source=await standaloneHtml(rendered.html,doc,body.id,rendered.source);
            const bytes=await exportPptx(source,doc);
            res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.presentationml.presentation','Content-Disposition':'attachment; filename=slides.pptx','Cache-Control':'no-store'});res.end(bytes);return;
          }
          browser=await puppeteer.launch({executablePath:browserPath(),headless:true});
          const page=await browser.newPage();await page.setJavaScriptEnabled(false);
          // SVG backgrounds are not document.images; watch failed image/font requests too.
          const failedAssets=new Set();
          page.on('requestfailed',request=>{if(['image','font'].includes(request.resourceType()))failedAssets.add(request.url());});
          page.on('response',response=>{if(response.status()>=400&&['image','font'].includes(response.request().resourceType()))failedAssets.add(response.url());});
          await page.setContent(rendered.html,{waitUntil:'networkidle0',timeout:60000});
          await page.evaluate(()=>document.fonts.ready);
          const missing=await page.evaluate(()=>[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.getAttribute('src')));
          if(missing.length||failedAssets.size)throw new Error(`圖片或字型無法讀取：${[...missing,...failedAssets].join(', ')}`);
          const bytes=await page.pdf({printBackground:true,preferCSSPageSize:true,width:`${rendered.width}px`,height:`${rendered.height}px`,margin:{top:0,bottom:0,left:0,right:0},timeout:60000});
          res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':"attachment; filename=slides.pdf",'Cache-Control':'no-store'});res.end(bytes);
        } finally {if(browser)await browser.close();exporting=false;}
        return;
      }
    }
    if (req.method==='GET' && (['/', '/app.css'].includes(url.pathname)||/^\/[a-z0-9-]+\.js$/.test(url.pathname))) return sendFile(res,path.join(ROOT,'ui',url.pathname==='/'?'index.html':url.pathname.slice(1)));
    reply(res,{error:'找不到此頁面。'},404);
  } catch(e) {console.error(e.message);if(!res.headersSent)reply(res,{error:e.message},400);else res.end();}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Lab Slides ready: http://127.0.0.1:${PORT}`));
// Close only this workbench's Codex child when the server exits.
process.on('exit',()=>codex.close());
process.on('SIGTERM',()=>{codex.close();server.close(()=>process.exit(0));});
process.on('SIGINT',()=>{codex.close();server.close(()=>process.exit(0));});
