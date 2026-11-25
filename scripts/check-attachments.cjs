// Check parsing, persistent lookup, and rejection paths without calling Codex or an external service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { AttachmentStore } = require('../attachments.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-marp-attachments-'));
const base64 = value => Buffer.from(value).toString('base64');

async function minimalDocx() {
  // A tiny valid OOXML package exercises Mammoth without maintaining a binary fixture.
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>附件測試繁體中文</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function blankPdf() {
  // Build one empty page with a correct cross-reference table to test textless PDFs.
  let document = '%PDF-1.4\n';
  const offsets = [0];
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R>>',
    '<</Length 0>>\nstream\n\nendstream',
  ];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { document += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  document += `trailer\n<</Size ${offsets.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document);
}

(async () => {
  try {
    const store = new AttachmentStore(root);
    const text = await store.add({ name: '筆記.md', data: base64('中文、English ✅') });
    assert.equal(text.kind, 'text');
    assert.equal(text.characters, '中文、English ✅'.length);
    assert.equal(store.resolve([text.id])[0].text, '中文、English ✅');
    assert.equal(path.dirname(store.resolve([text.id])[0].path), path.join(root, '.codex-work', 'uploads'));
    const json = await store.add({ name: '資料.json', data: base64('{"標題":"測試"}') });
    assert.equal(store.resolve([json.id])[0].text, '{"標題":"測試"}');

    const pdfBytes = fs.readFileSync(path.join(__dirname, '..', 'output', 'catlab-sample.pdf'));
    const pdf = await store.add({ name: '簡報.pdf', data: base64(pdfBytes) });
    const pdfEntry = store.resolve([pdf.id])[0];
    assert.match(pdfEntry.text, /論文標題/);
    assert.match(fs.readFileSync(path.join(root, '.codex-work', 'uploads', `${pdf.id}.md`), 'utf8'), /第 1 頁/);
    assert.deepEqual(fs.readFileSync(pdfEntry.path), pdfBytes);

    const docx = await store.add({ name: '報告.docx', data: base64(await minimalDocx()) });
    assert.match(store.resolve([docx.id])[0].text, /附件測試繁體中文/);

    const pngBytes = fs.readFileSync(path.join(__dirname, '..', 'templates', 'catlab-mark.png'));
    const image = await store.add({ name: '圖.png', data: base64(pngBytes) });
    assert.equal(store.resolve([image.id])[0].dataURI, `data:image/png;base64,${base64(pngBytes)}`);
    assert.equal(store.resolve([image.id])[0].mime, 'image/png');

    const reopened = new AttachmentStore(root);
    assert.equal(reopened.resolve([pdf.id])[0].text, pdfEntry.text);
    assert.throws(() => reopened.resolve([pdf.id, pdf.id]), /不重複/);
    assert.throws(() => reopened.resolve(['0'.repeat(32)]), /找不到附件/);
    assert.throws(() => reopened.resolve([text.id, pdf.id, docx.id, image.id, '0'.repeat(32), '1'.repeat(32)]), /最多 5 個/);
    await assert.rejects(store.add({ name: '../escape.txt', data: base64('bad') }), /檔名無效/);
    await assert.rejects(store.add({ name: 'bad.md', data: '%%%%' }), /Base64/);
    await assert.rejects(store.add({ name: 'bad.png', data: base64('not a PNG') }), /圖片內容/);
    await assert.rejects(store.add({ name: 'bad.pdf', data: base64('not a PDF') }), /PDF 檔案格式/);
    await assert.rejects(store.add({ name: 'blank.pdf', data: base64(blankPdf()) }), /沒有可讀文字/);
    await assert.rejects(store.add({ name: 'empty.txt', data: base64('') }), /Base64/);
    await assert.rejects(store.add({ name: 'huge.md', data: base64('A'.repeat(10 * 1024 * 1024 + 1)) }), /10 MB/);
    const longA = await store.add({ name: 'a.txt', data: base64('甲'.repeat(180_000)) });
    const longB = await store.add({ name: 'b.txt', data: base64('乙'.repeat(180_000)) });
    assert.throws(() => store.resolve([longA.id, longB.id]), /350,000/);

    const untouched = path.join(root, 'outside.txt');
    fs.writeFileSync(untouched, 'safe');
    assert.equal(reopened.remove(pdf.id), true);
    assert.equal(reopened.remove(pdf.id), false);
    assert.equal(fs.existsSync(pdfEntry.path), false);
    assert.equal(fs.readFileSync(untouched, 'utf8'), 'safe');
    assert.throws(() => reopened.remove('../outside.txt'), /ID 無效/);
    console.log('附件檢查通過：PDF、DOCX、UTF-8、圖片、持久化與安全邊界。');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
