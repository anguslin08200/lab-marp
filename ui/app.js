// Disk writes remain explicit; browser-local backups protect drafts between sessions.
const $ = id => document.getElementById(id);
let token, current, dirty=false, timer, renderVersion=0, lastHTML;
let statusTimer;
const status = (text,error=false) => {clearTimeout(statusTimer);$('status').textContent=text;$('status').classList.toggle('error',error);$('status').classList.add('visible');statusTimer=setTimeout(()=>$('status').classList.remove('visible'),error?12000:4000);};
async function api(route,data,options={}) {
  const response=await fetch(`/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':token},body:JSON.stringify(data),signal:options.signal});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'操作失敗');return result;
}
const payload=()=>({id:current?.id,text:$('editor').value,format:$('format').value});
function markDirty(value=true) {dirty=value;$('save-state').textContent=value?'尚未儲存':'已儲存';$('save-state').classList.toggle('unsaved',value);if(value)document.dispatchEvent(new Event('lab-dirty'));}
function applyDocument(doc,format='original') {
  // Flush before switching handles so a queued backup cannot attach to the next file.
  if(typeof backupDraft==='function')backupDraft();
  if(doc.untitled&&!doc.backupId)doc.backupId=crypto.randomUUID();
  const previousPath=current?.path;current=doc;if(!doc.template&&!doc.untitled)rememberDocument(doc.path);$('editor').value=doc.text;$('filename').textContent=doc.path;$('format').value=format;markDirty(false);render();document.dispatchEvent(new CustomEvent('lab-document',{detail:{changed:previousPath!==doc.path,doc}}));
  // A dropped document has no disk source until its first Save As.
  $('reload').disabled=!!doc.untitled;
}
async function render() {
  if(!current)return false;
  const version=++renderVersion;
  try {
    const draft=payload();const result=await api('render',draft);if(version!==renderVersion)return false;
    lastHTML=result.html;updatePreview(result,draft,version);
    return true;
  } catch(e) {if(version===renderVersion)status(e.message,true);return false;}
}
// Zoom changes the rendered slide width; the pane's scrollbar handles oversize slides.
function resizePreview() {
  const doc=$('preview').contentDocument;if(!doc)return;
  let style=doc.getElementById('preview-zoom');if(!style){style=doc.createElement('style');style.id='preview-zoom';doc.head.append(style);}
  const zoom=Number($('zoom').value);style.textContent=`.marpit{width:${zoom}%;min-width:300px}`;$('zoom-value').textContent=`${zoom}%`;
  // A short final slide can still reach the reading edge for page-by-page navigation.
  const last=slideNodes().at(-1);if(last)style.textContent+=`.marpit>svg:last-child{margin-bottom:${Math.max(0,$('preview').contentWindow.innerHeight-last.getBoundingClientRect().height-60)}px}`;
}
async function action(button,work) {button.disabled=true;try{await work();}catch(e){status(e.message,true);}finally{button.disabled=false;}}
$('editor').addEventListener('input',()=>{markDirty();clearTimeout(timer);timer=setTimeout(render,300);});
$('editor').addEventListener('keydown',event=>{if(event.key==='Tab'){event.preventDefault();const start=$('editor').selectionStart;const end=$('editor').selectionEnd;$('editor').setRangeText('  ',start,end,'end');$('editor').dispatchEvent(new Event('input'));}});
$('format').addEventListener('change',()=>{markDirty();render();});$('zoom').addEventListener('input',resizePreview);
new ResizeObserver(()=>{resizePreview();refreshNavigation();}).observe($('preview'));
// The web dialog always provides a path input, independently of native Windows dialogs.
$('open').onclick=()=>showOpenDocument();
$('reload').onclick=()=>action($('reload'),async()=>{if(dirty&&!confirm('重新載入會取代尚未儲存的修改，是否繼續？'))return;const doc=await api('reload',{id:current.id});$('editor').value=doc.text;markDirty(false);render();});
async function save(saveAs=false){
  if(!current)return;const snapshot=payload(),doc=await api('save',{...snapshot,saveAs:saveAs||current.untitled});if(doc.cancelled)return;
  // A slow Save As must not replace another document or erase typing made while the picker was open.
  if(current?.id!==snapshot.id){status('Markdown 已儲存：'+doc.path);return;}
  const latest={text:$('editor').value,format:$('format').value},edited=latest.text!==snapshot.text||latest.format!==snapshot.format;
  clearDraftBackup();markDirty(false);applyDocument(doc);clearDraftBackup();
  if(edited){$('editor').value=latest.text;$('format').value=latest.format;markDirty();render();status('已儲存送出時的版本；後續編輯仍保留在草稿。');}
  else status('Markdown 已儲存；選用的格式也已寫入檔案。');
}
$('save').onclick=()=>action($('save'),()=>save());$('save-as').onclick=()=>action($('save-as'),()=>save(true));
$('new').onclick=()=>{if(dirty&&!confirm('目前有尚未儲存的修改，仍要建立新簡報？'))return;$('new-dialog').showModal();};
$('close-dialog').onclick=()=>$('new-dialog').close();
// All download formats use the live draft and the original document's asset directory.
async function exportDraft(exportFormat='pdf'){
  const name=exportFormat.toUpperCase();status(`正在匯出 ${name}…`);
  const response=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':token},body:JSON.stringify({...payload(),exportFormat})});
  if(!response.ok){const result=await response.json();throw new Error(result.error);}
  const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(current.path.split(/[\\/]/).pop()||'slides.md').replace(/\.md$/i,'.'+exportFormat);a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status(`${name} 已匯出，請查看瀏覽器下載。`);
}
$('export').onclick=()=>action($('export'),()=>exportDraft());
// Pointer capture makes dragging reliable even while crossing the preview iframe.
function setSplit(percent){percent=Math.min(75,Math.max(20,percent));document.documentElement.style.setProperty('--editor-width',`${percent}%`);$('divider').setAttribute('aria-valuenow',Math.round(percent));localStorage.setItem('lab-split',percent);}
$('divider').addEventListener('pointerdown',e=>{$('divider').setPointerCapture(e.pointerId);document.body.classList.add('dragging');});
$('divider').addEventListener('pointermove',e=>{if(!document.body.classList.contains('dragging'))return;const rect=$('workspace').getBoundingClientRect();setSplit((e.clientX-rect.left)/rect.width*100);});
const endDrag=()=>document.body.classList.remove('dragging');$('divider').addEventListener('pointerup',endDrag);$('divider').addEventListener('lostpointercapture',endDrag);
$('divider').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setSplit(Number($('divider').getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?3:-3));}});
// Honor the same save lock for keyboard shortcuts while Codex is handling a draft.
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(!$('save').disabled)action($('save'),()=>save(e.shiftKey));}});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
(async()=>{
  const info=await(await fetch('/api/info')).json();token=info.token;
  for(const format of info.formats){const option=document.createElement('option');option.value=format.id;option.textContent=format.name;$('format').append(option);
    if(format.id!=='original'){const button=document.createElement('button');const title=document.createElement('strong');title.textContent=format.name;const description=document.createElement('small');description.textContent=format.description;button.append(title,description);button.onclick=()=>action(button,async()=>{const doc=await api('template',{format:format.id});$('new-dialog').close();applyDocument(doc,format.id);markDirty();});$('template-options').append(button);}}
  setSplit(Number(localStorage.getItem('lab-split'))||43);
  // Restore only successfully opened/saved files, keeping unsaved templates out of history.
  let initial,restoreError='';
  const last=recentDocuments()[0]?.path;
  if(last){try{initial=await api('open',{path:last});}catch(e){restoreError='上次的檔案無法載入：'+e.message;}}
  if(!initial)initial=info.formats.some(f=>f.id==='catlab')?await api('template',{format:'catlab'}):await api('open',{path:info.defaultPath});
  applyDocument(initial,initial.template?'catlab':'original');
  if(restoreError){showOpenDocument();$('open-message').textContent=restoreError+' 請從最近檔案選擇，或輸入新的路徑。';}
  // Defer CLI connection until the local workbench token and initial document are ready.
  // Share server capability information with the optional attachment controls.
  document.dispatchEvent(new CustomEvent('lab-ready',{detail:info}));
})().catch(e=>status(e.message,true));
