// Keep uploaded references within this local workbench; callers never supply disk paths.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const mammoth = require('mammoth');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_STORED_FILES = 100;
const MAX_FILE_TEXT = 200_000;
const MAX_TOTAL_TEXT = 350_000;
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'csv', 'json', 'yaml', 'yml', 'log']);
const IMAGE_MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const ID_PATTERN = /^[a-f0-9]{32}$/;

const SHA_PATTERN = /^[a-f0-9]{64}$/;
const FIGURE_PATTERN = /^page_(\d+)_(image|chart|table|equation)_(\d+)\.jpe?g$/i;
// One shared FIFO prevents overlapping GPU jobs, including jobs from separate stores.
let mineruQueue = Promise.resolve();
function detectMineru() {
  const base = path.resolve(__dirname, '..', 'mineru');
  const kit = process.env.LAB_MINERU_KIT || path.join(base, '.venv', 'Scripts', 'mineru-kit.exe');
  const home = process.env.LAB_MINERU_HOME || path.join(base, 'home');
  let available = false;
  try { available = fs.statSync(kit).isFile() && fs.statSync(home).isDirectory(); } catch {}
  return {kit, home, available, reason: available ? '' : 'MinerU 執行檔或模型目錄不存在，使用快速文字。'};
}
function childRun(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {windowsHide:true, ...options, stdio:['ignore','ignore','pipe']});
    let log = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => {log = (log + data).slice(-4000);});
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.on('error', error => {clearTimeout(timer); reject(error);});
    child.on('close', code => {clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`MinerU 解析失敗 (${code})：${log.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-700) || '程序逾時或結束'}`));});
  });
}
async function runMineru({kit, home, pdf, zip}) {
  await childRun(kit, ['parse', pdf, '-o', zip, '-f', 'zip', '--tier', 'standard'], {
    env:{...process.env, MINERU_HOME:home, PYTHONIOENCODING:'utf-8'}
  });
}
async function extractMineru(zip, destination) {
  // Only allow expected paper outputs; ZIP entries never supply arbitrary extraction paths.
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:LAB_EXTRACT_ZIP)
try {
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName -eq 'markdown.md' -or $entry.FullName -match '^images/page_[0-9]+_(image|chart|table|equation)_[0-9]+\\.jpe?g$') {
      if ($entry.Length -gt 268435456) { throw 'MinerU output file too large' }
      $target = Join-Path $env:LAB_EXTRACT_DIR $entry.FullName
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  }
} finally { $archive.Dispose() }`;
  await childRun('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script, 'utf16le').toString('base64')], {
    env:{...process.env, LAB_EXTRACT_ZIP:zip, LAB_EXTRACT_DIR:destination}
  });
}
function limitedMarkdown(markdown) {
  // Drop a reference list first, keeping the more useful paper body within attachment limits.
  let text = markdown;
  if (text.length > MAX_FILE_TEXT) {
    const references = /^#{1,6}\s+(?:\d+[.\s]+)?(?:references|bibliography|參考文獻|参考文献)\s*#*\s*$/im.exec(text);
    if (references) text = text.slice(0, references.index);
  }
  const truncated = text.length > MAX_FILE_TEXT;
  if (truncated) {
    text = text.slice(0, MAX_FILE_TEXT - 30);
    text = text.replace(/!\[[^\]]*\]\([^)]*$|__LAB_ASSET_[a-f0-9]*$/i, '') + '\n\n[內容已截斷]';
  }
  return {text, truncated};
}
function decodeBase64(data) {
  // Reject malformed encodings before Buffer's permissive base64 decoder can discard characters.
  if (typeof data !== 'string') throw new Error('附件資料必須是 Base64 字串。');
  const match = /^data:[^;,]+;base64,(.*)$/is.exec(data);
  const encoded = match ? match[1] : data;
  if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error('單一附件不可超過 10 MB。');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('附件的 Base64 資料無效。');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.toString('base64') !== encoded) throw new Error('附件的 Base64 資料無效。');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('單一附件不可超過 10 MB。');
  return buffer;
}

function isImage(buffer, extension) {
  // Extension and file signature must agree before image bytes reach any downstream tool.
  if (extension === 'png') return buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (extension === 'jpg' || extension === 'jpeg') return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (extension === 'webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function readableText(text, format) {
  if (!text.trim()) throw new Error(`${format} 沒有可讀文字；掃描圖片需要先另行進行 OCR。`);
  if (text.length > MAX_FILE_TEXT) throw new Error('單一附件擷取文字不可超過 200,000 字元。');
  return text;
}

async function extractPdf(buffer) {
  // Mozilla's Node example uses the legacy ESM build and getTextContent per page.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const pages = [];
    let characters = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      page.cleanup();
      if (pageText) {
        const segment = `## 第 ${number} 頁\n\n${pageText}`;
        characters += segment.length + 2;
        if (characters > MAX_FILE_TEXT) throw new Error('單一附件擷取文字不可超過 200,000 字元。');
        pages.push(segment);
      }
    }
    return readableText(pages.join('\n\n'), 'PDF');
  } finally {
    await task.destroy();
  }
}

class AttachmentStore {
  constructor(root, options = {}) {
    if (typeof root !== 'string' || !root) throw new Error('必須指定附件儲存根目錄。');
    const resolvedRoot = fs.realpathSync(path.resolve(root));
    this.directory = path.join(resolvedRoot, '.codex-work', 'uploads');
    fs.mkdirSync(this.directory, { recursive: true });
    // Refuse a redirected upload directory so removal stays inside the chosen project root.
    if (!fs.realpathSync(this.directory).startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('附件儲存目錄必須位於專案內。');
    this.mineru = options.mineru || detectMineru();
    this.runMineru = options.runMineru || runMineru;
    this.cacheLimitBytes = options.cacheLimitBytes ?? 2 * 1024 ** 3;
    this.cacheDirectory = path.join(resolvedRoot, '.codex-work', 'mineru-cache');
    fs.mkdirSync(this.cacheDirectory, {recursive:true});
    if (!fs.realpathSync(this.cacheDirectory).startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('MinerU 快取需位於專案內。');
    this.jobs = new Map();
    this.entries = new Map();
    // Only manifests with generated IDs and matching bounded filenames can be restored.
    for (const file of fs.readdirSync(this.directory)) {
      if (!file.endsWith('.meta.json') || !ID_PATTERN.test(file.slice(0, -10))) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
        if (entry.id !== file.slice(0, -10) || !['text', 'pdf', 'docx', 'image'].includes(entry.kind) || !/^[a-z]+$/.test(entry.extension)) continue;
        if (!fs.statSync(this._original(entry)).isFile()) continue;
        if (entry.kind !== 'image' && !fs.statSync(this._textPath(entry)).isFile() && !TEXT_EXTENSIONS.has(entry.extension)) continue;
        this.entries.set(entry.id, entry);
      } catch { /* Ignore incomplete or damaged local entries. */ }
    }
    this._pruneCache();
    // Resume interrupted jobs after restart while preserving explicitly disabled uploads.
    for (const entry of this.entries.values()) {
      if (entry.kind === 'pdf' && ['queued','parsing'].includes(entry.mineru?.state)) this._queue(entry);
    }
  }

  // Persist states so a restarted workbench can recover cached and interrupted uploads.
  _save(entry) { if (this.entries.has(entry.id)) fs.writeFileSync(path.join(this.directory, `${entry.id}.meta.json`), JSON.stringify(entry)); }
  _entry(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('附件 ID 無效。');
    const entry = this.entries.get(id);
    if (!entry) throw new Error('找不到附件。');
    return entry;
  }
  _cache(sha) {
    if (!SHA_PATTERN.test(sha || '')) throw new Error('MinerU 快取識別無效。');
    const target = path.join(this.cacheDirectory, sha);
    if (fs.existsSync(target) && fs.realpathSync(target) !== target) throw new Error('MinerU 快取不能重新導向。');
    return target;
  }
  _cached(entry) {
    try {
      const directory = this._cache(entry.sha);
      const info = JSON.parse(fs.readFileSync(path.join(directory, 'cache.json'), 'utf8'));
      if (info.sha !== entry.sha || !Array.isArray(info.files) || info.files.some(file => typeof file !== 'string' || !FIGURE_PATTERN.test(file))) return null;
      const md = path.join(directory, 'markdown.md');
      if (fs.lstatSync(md).isSymbolicLink()) return null;
      return {...info, directory, markdown:fs.readFileSync(md, 'utf8')};
    } catch { return null; }
  }
  _paper(entry, includeData = false) {
    const cached = this._cached(entry);
    if (!cached) throw new Error('MinerU 快取已清理，使用快速文字。');
    const figures = [...cached.files].sort((a,b) => Number(FIGURE_PATTERN.exec(a)[1])-Number(FIGURE_PATTERN.exec(b)[1]) || a.localeCompare(b,undefined,{numeric:true})).map(file => {
      const full = path.join(cached.directory, 'images', file);
      // Realpath checks also reject redirected image directories or individual files.
      if (fs.realpathSync(full) !== full || !fs.statSync(full).isFile()) throw new Error('論文圖片路徑無效。');
      const reference = `__LAB_ASSET_${crypto.createHash('sha256').update(`${entry.sha}/${file}`).digest('hex').slice(0,32)}__`;
      return {reference, file, page:Number(FIGURE_PATTERN.exec(file)[1]), path:full,
        ...(includeData ? {dataURI:`data:image/jpeg;base64,${fs.readFileSync(full).toString('base64')}`} : {})};
    });
    const tokens = new Map(figures.map(figure => [figure.file, figure.reference]));
    const initial = limitedMarkdown(cached.markdown);
    const rewritten = initial.text.replace(/!\[([^\]]*)\]\(images\/([^\s)]+)\)/g, (match, label, file) => {
      if (!tokens.has(file)) return '';
      return `![${label}](${tokens.get(file)})`;
    });
    const limited = limitedMarkdown(rewritten);
    return {...limited, truncated:initial.truncated || limited.truncated, figures};
  }
  _describe(entry) {
    if (entry.mineru?.state === 'complete') {
      try {
        const paper = this._paper(entry);
        entry.characters = paper.text.length;
        entry.mineru.figures = paper.figures.length;
        entry.mineru.truncated = paper.truncated;
      } catch (error) {
        entry.mineru = {...entry.mineru, state:'failed', error:error.message};
        entry.characters = fs.readFileSync(this._textPath(entry), 'utf8').length;
        this._save(entry);
      }
    }
    const {id,name,kind,bytes,characters,mineru} = entry;
    return {id,name,kind,bytes,characters,...(mineru ? {mineru:{...mineru}} : {})};
  }
  status(ids) {
    this._validateIDs(ids);
    return ids.map(id => this._describe(this._entry(id)));
  }
  _validateIDs(ids) {
    if (!Array.isArray(ids) || ids.length > MAX_FILES || ids.some(id => typeof id !== 'string' || !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) throw new Error('附件 ID 必須是不重複的有效清單，最多 5 個。');
  }
  _pruneCache() {
    // Delete only generated SHA cache directories, oldest completed result first.
    const items = [];
    for (const sha of fs.readdirSync(this.cacheDirectory)) {
      if (!SHA_PATTERN.test(sha)) continue;
      try {
        const directory = this._cache(sha);
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'cache.json'), 'utf8'));
        if (manifest.sha !== sha) continue;
        let size = fs.statSync(path.join(directory, 'markdown.md')).size + fs.statSync(path.join(directory, 'cache.json')).size;
        for (const file of manifest.files) {
          if (!FIGURE_PATTERN.test(file)) throw new Error('Invalid cache');
          const image = path.join(directory, 'images', file);
          if (fs.realpathSync(image) !== image) throw new Error('Redirected cache');
          size += fs.statSync(image).size;
        }
        items.push({directory, size, time:manifest.createdAt || 0});
      } catch { /* Incomplete caches are never considered reusable. */ }
    }
    let total = items.reduce((sum,item) => sum + item.size, 0);
    for (const item of items.sort((a,b) => a.time - b.time)) {
      if (total <= this.cacheLimitBytes) break;
      fs.rmSync(item.directory, {recursive:true, force:true});
      total -= item.size;
    }
  }
  _queue(entry) {
    if (this._cached(entry)) {
      entry.mineru = {state:'complete', figures:0, cacheHit:true};
      this._save(entry);
      return;
    }
    if (!this.mineru.available) {
      entry.mineru = {state:'disabled', error:this.mineru.reason};
      this._save(entry);
      return;
    }
    entry.mineru = {state:'queued', queuedAt:Date.now(), figures:0, cacheHit:false};
    this._save(entry);
    // Deduplicate the same PDF within this store while preserving global job order.
    const previous = this.jobs.get(entry.sha);
    const task = previous || mineruQueue.then(async () => {
      const start = Date.now();
      for (const current of this.entries.values()) if (current.sha === entry.sha && current.mineru?.state === 'queued') {
        current.mineru = {...current.mineru, state:'parsing', startedAt:start}; this._save(current);
      }
      if (this._cached(entry)) return;
      const staging = fs.mkdtempSync(path.join(this.cacheDirectory, 'job-'));
      const zip = path.join(staging, 'result.zip');
      try {
        await this.runMineru({...this.mineru, pdf:this._original(entry), zip, tier:'standard'});
        await extractMineru(zip, staging);
        const markdown = fs.readFileSync(path.join(staging, 'markdown.md'), 'utf8');
        if (!markdown.trim()) throw new Error('MinerU 沒有產生可讀 Markdown。');
        const images = path.join(staging, 'images');
        const files = fs.existsSync(images) ? fs.readdirSync(images).filter(file => FIGURE_PATTERN.test(file)) : [];
        for (const file of files) if (!isImage(fs.readFileSync(path.join(images,file)), path.extname(file).slice(1).toLowerCase())) throw new Error('MinerU 圖片格式無效。');
        fs.unlinkSync(zip);
        fs.writeFileSync(path.join(staging,'cache.json'), JSON.stringify({sha:entry.sha, files, createdAt:Date.now()}));
        const destination = this._cache(entry.sha);
        if (!fs.existsSync(destination)) fs.renameSync(staging, destination);
        else if (!this._cached(entry)) throw new Error('MinerU 快取損壞，請清理該快取後重試。');
        this._pruneCache();
        if (!this._cached(entry)) throw new Error('MinerU 輸出超過快取容量，使用快速文字。');
      } finally {
        // Staging was created by this job; never delete a client-supplied path.
        if (fs.existsSync(staging)) fs.rmSync(staging, {recursive:true, force:true});
      }
    });
    if (!previous) {
      this.jobs.set(entry.sha, task);
      mineruQueue = task.catch(() => {});
      task.finally(() => {if (this.jobs.get(entry.sha) === task) this.jobs.delete(entry.sha);}).catch(() => {});
    }
    task.then(() => {
      if (!this.entries.has(entry.id)) return;
      entry.mineru = {...entry.mineru, state:'complete'};
      this._describe(entry); this._save(entry);
    }, error => {
      if (!this.entries.has(entry.id)) return;
      entry.mineru = {...entry.mineru, state:'failed', error:error.message}; this._save(entry);
    });
  }
  figures(id) {
    const entry = this._entry(id);
    if (entry.mineru?.state !== 'complete') throw new Error('論文尚未完成解析。');
    return this._paper(entry, true).figures.map(({file,page,dataURI}) => ({file,page,dataURI}));
  }
  insertFigure(id, file, document = {}) {
    // The ID and whitelisted basename, never a request path, identify the source image.
    if (typeof file !== 'string' || !FIGURE_PATTERN.test(file)) throw new Error('論文圖片檔名無效。');
    const entry = this._entry(id);
    if (entry.mineru?.state !== 'complete') throw new Error('論文尚未完成解析。');
    const figure = this._paper(entry,true).figures.find(item => item.file === file);
    if (!figure) throw new Error('找不到論文圖片。');
    if (!document.path || document.untitled || document.template || !document.directory) return {markdown:`![w:900](${figure.dataURI})`};
    const root = fs.realpathSync(document.directory);
    let paperName = path.parse(entry.name).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'paper';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(paperName)) paperName = '_' + paperName;
    let folder = root;
    for (const component of ['assets',paperName]) {
      folder = path.join(folder,component);
      if (!fs.existsSync(folder)) fs.mkdirSync(folder);
      if (fs.realpathSync(folder) !== folder || !fs.statSync(folder).isDirectory()) throw new Error('圖片目錄不能重新導向。');
    }
    const bytes = fs.readFileSync(figure.path);
    let target = path.join(folder,file);
    if (fs.existsSync(target)) {
      if (fs.realpathSync(target) !== target) throw new Error('圖片檔案不能重新導向。');
      if (!fs.readFileSync(target).equals(bytes)) target = path.join(folder,`${path.parse(file).name}_${crypto.createHash('sha256').update(bytes).digest('hex').slice(0,12)}${path.extname(file)}`);
    }
    if (!fs.existsSync(target)) fs.writeFileSync(target,bytes,{flag:'wx'});
    else if (fs.realpathSync(target) !== target || !fs.readFileSync(target).equals(bytes)) throw new Error('圖片檔名衝突，未覆寫原有檔案。');
    const relative = path.relative(root,target).split(path.sep).map(encodeURIComponent).join('/');
    return {markdown:`![w:900](${relative})`};
  }
  _original(entry) { return path.join(this.directory, `${entry.id}.${entry.extension}`); }
  _textPath(entry) { return path.join(this.directory, `${entry.id}.md`); }

  async add({ name, data, mineru = false } = {}) {
    // A display name cannot become a path or contain a directory separator.
    if (this.entries.size >= MAX_STORED_FILES) throw new Error('附件暫存已達 100 個；請先移除不需要的附件。');
    if (typeof name !== 'string' || !name.trim() || name !== path.win32.basename(name) || name !== path.posix.basename(name) || name.includes('\0')) {
      throw new Error('附件檔名無效；請提供不含路徑的檔名。');
    }
    const cleanName = name.trim();
    const extension = path.extname(cleanName).slice(1).toLowerCase();
    let kind;
    if (TEXT_EXTENSIONS.has(extension)) kind = 'text';
    else if (extension === 'pdf' || extension === 'docx') kind = extension;
    else if (IMAGE_MIMES[extension]) kind = 'image';
    else throw new Error('不支援此附件格式；可使用 PDF、DOCX、文字檔或 PNG/JPEG/WebP 圖片。');

    const buffer = decodeBase64(data);
    let text = '';
    if (kind === 'image') {
      if (!isImage(buffer, extension)) throw new Error('圖片內容與副檔名不符，或圖片檔案已損毀。');
    } else if (kind === 'pdf') {
      if (buffer.toString('ascii', 0, 5) !== '%PDF-') throw new Error('PDF 檔案格式無效。');
      try { text = await extractPdf(buffer); }
      catch (error) { if (error.message.includes('沒有可讀文字') || error.message.includes('200,000')) throw error; throw new Error('無法讀取 PDF 文字；請確認檔案未損毀或加密。'); }
    } else if (kind === 'docx') {
      if (buffer.toString('ascii', 0, 2) !== 'PK') throw new Error('DOCX 檔案格式無效。');
      try { text = readableText((await mammoth.extractRawText({ buffer })).value, 'DOCX'); }
      catch (error) { if (error.message.includes('沒有可讀文字') || error.message.includes('200,000')) throw error; throw new Error('無法讀取 DOCX 文字；請確認檔案未損毀。'); }
    } else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new Error('文字附件必須使用 UTF-8 編碼。'); }
      text = readableText(text, '文字附件');
    }

    let id;
    do { id = crypto.randomBytes(16).toString('hex'); }
    while (this.entries.has(id) || fs.existsSync(path.join(this.directory, `${id}.meta.json`)));
    const entry = { id, name: cleanName, kind, extension, bytes: buffer.length, characters: text.length };
    const original = this._original(entry);
    const sidecar = this._textPath(entry);
    const manifest = path.join(this.directory, `${id}.meta.json`);
    const created = [];
    try {
      fs.writeFileSync(original, buffer, { flag: 'wx' });
      created.push(original);
      if (kind === 'pdf' || kind === 'docx') { fs.writeFileSync(sidecar, text, { flag: 'wx' }); created.push(sidecar); }
      fs.writeFileSync(manifest, JSON.stringify(entry), { flag: 'wx' });
      created.push(manifest);
    } catch (error) {
      // Roll back all files for an incomplete upload, without touching other entries.
      for (const file of created.reverse()) { try { fs.unlinkSync(file); } catch {} }
      throw error;
    }
    this.entries.set(id, entry);
    if (kind === 'pdf') {
      // Hash content rather than the display name so renamed papers share a cache.
      entry.sha = crypto.createHash('sha256').update(buffer).digest('hex');
      if (mineru === true) this._queue(entry);
      else {entry.mineru = {state:'disabled'}; this._save(entry);}
    }
    return this._describe(entry);
  }

  resolve(ids, {fastText = false} = {}) {
    if (!Array.isArray(ids) || ids.length > MAX_FILES || ids.some(id => typeof id !== 'string' || !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
      throw new Error('附件 ID 必須是不重複的清單，最多 5 個。');
    }
    let bytes = 0;
    let characters = 0;
    return ids.map(id => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`找不到附件：${id}`);
      bytes += entry.bytes;
      this._describe(entry);
      if (bytes > MAX_TOTAL_BYTES) throw new Error('附件總大小不可超過 25 MB。');

      const original = this._original(entry);
      const paper = !fastText && entry.mineru?.state === 'complete' ? this._paper(entry,true) : null;
      const text = paper ? paper.text : entry.kind === 'image' ? '' : fs.readFileSync(entry.kind === 'pdf' || entry.kind === 'docx' ? this._textPath(entry) : original, 'utf8');
      characters += text.length;
      if (characters > MAX_TOTAL_TEXT) throw new Error('附件文字總長不可超過 350,000 字元。');
      const mime = IMAGE_MIMES[entry.extension] || (entry.kind === 'pdf' ? 'application/pdf' : entry.kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain; charset=utf-8');
      const dataURI = entry.kind === 'image' ? `data:${mime};base64,${fs.readFileSync(original).toString('base64')}` : undefined;
      return { id, name: entry.name, kind: entry.kind, text, path: original, mime, dataURI, ...(paper ? {figures:paper.figures} : {}) };
    });
  }

  remove(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('附件 ID 無效。');
    const entry = this.entries.get(id);
    if (!entry) return false;
    // Every deletion path is derived solely from the generated ID inside the upload directory.
    for (const file of [this._original(entry), ...(entry.kind === 'pdf' || entry.kind === 'docx' ? [this._textPath(entry)] : []), path.join(this.directory, `${id}.meta.json`)]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.entries.delete(id);
    return true;
  }
}

module.exports = { AttachmentStore, detectMineru, limitedMarkdown };
