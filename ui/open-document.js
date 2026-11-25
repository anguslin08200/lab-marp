// Native browsing is optional: users can always enter a full path without waiting for Windows UI.
let openOperation=null,openGeneration=0;
function cancelOpenOperation(){openGeneration++;openOperation?.abort();openOperation=null;$('open-browse').disabled=false;$('open-submit').disabled=false;}
function showOpenDocument(){
  cancelOpenOperation();$('open-message').textContent='';$('open-path').value=current&&!current.template?current.path:(recentDocuments()[0]?.path||'');drawRecentDocuments();
  $('open-dialog').showModal();$('open-path').focus();$('open-path').select();
  // Listing is independent of the native picker and cannot block direct-path submission.
  browseFolder();drawUntitledDrafts();
}
$('open-dialog').addEventListener('close',cancelOpenOperation);
$('open-dialog').addEventListener('cancel',cancelOpenOperation);
$('open-cancel').onclick=()=>{$('open-dialog').close();};
$('open-browse').onclick=async()=>{
  cancelOpenOperation();const generation=openGeneration,initialPath=$('open-path').value;
  const controller=new AbortController();openOperation=controller;$('open-browse').disabled=true;
  $('open-message').textContent='請選擇檔案；也可直接貼上路徑後按「開啟」，或取消。';
  // Limit waiting while keeping Cancel and direct-path submission available.
  const timeout=setTimeout(()=>controller.abort(),120000);
  try{
    const doc=await api('open',{}, {signal:controller.signal});
    if(generation!==openGeneration||!$('open-dialog').open)return;
    if(!doc.cancelled&&$('open-path').value===initialPath)$('open-path').value=doc.path;
    $('open-message').textContent=doc.cancelled?'已取消檔案選擇。':'路徑已選取，按「開啟」載入。';
  }catch(e){if(generation===openGeneration)$('open-message').textContent=e.name==='AbortError'?'選檔等待逾時，請直接貼上路徑或重試。':e.message;}
  finally{clearTimeout(timeout);if(generation===openGeneration){openOperation=null;$('open-browse').disabled=false;}}
};
$('open-form').onsubmit=async event=>{
  event.preventDefault();
  // Explorer's "Copy as path" includes quotes; accept both quoted and unquoted full paths.
  const path=$('open-path').value.trim().replace(/^"([\s\S]*)"$/,'$1');if(!path)return;
  if(dirty&&!confirm('目前有尚未儲存的修改，仍要開啟另一份檔案？'))return;
  cancelOpenOperation();const generation=openGeneration,controller=new AbortController();openOperation=controller;
  $('open-submit').disabled=true;$('open-browse').disabled=true;$('open-message').textContent='正在讀取 Markdown…';
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const doc=await api('open',{path},{signal:controller.signal});
    if(generation!==openGeneration||!$('open-dialog').open)return;
    applyDocument(doc);$('open-dialog').close();
  }catch(e){if(generation===openGeneration)$('open-message').textContent=e.name==='AbortError'?'讀取逾時，請確認檔案路徑後重試。':e.message;}
  finally{clearTimeout(timeout);if(generation===openGeneration){openOperation=null;$('open-submit').disabled=false;$('open-browse').disabled=false;}}
};
// Browser-local history stores paths only, never Markdown text or credentials; cap at 20 unique files.
const recentDocumentKey='lab-recent-documents';
function recentDocuments(){
  try{const entries=JSON.parse(localStorage.getItem(recentDocumentKey)||'[]');return Array.isArray(entries)?entries.filter(e=>e&&typeof e.path==='string'&&e.path.toLowerCase().endsWith('.md')).slice(0,20):[];}catch{return [];}
}
function writeRecentDocuments(entries){try{localStorage.setItem(recentDocumentKey,JSON.stringify(entries));}catch{/* Storage restrictions must not block opening or saving a document. */}}
function rememberDocument(path){
  if(typeof path!=='string'||!path.toLowerCase().endsWith('.md'))return;
  const normalized=path.replaceAll('/','\\').toLowerCase();
  writeRecentDocuments([{path,openedAt:new Date().toISOString()},...recentDocuments().filter(e=>e.path.replaceAll('/','\\').toLowerCase()!==normalized)].slice(0,20));
}
function drawRecentDocuments(){
  const entries=recentDocuments(),list=$('recent-files');list.replaceChildren();$('recent-clear').disabled=!entries.length;
  if(!entries.length){const empty=document.createElement('p');empty.className='recent-empty';empty.textContent='尚無紀錄；成功開啟或儲存 Markdown 後會出現在這裡。';list.append(empty);return;}
  for(const entry of entries){
    const row=document.createElement('div');row.className='recent-file';
    const open=document.createElement('button');open.type='button';open.className='recent-open';open.title=entry.path;
    const name=document.createElement('strong');name.textContent=entry.path.split(/[\\/]/).pop();const path=document.createElement('small');path.textContent=entry.path;open.append(name,path);
    // Use the same submission path and unsaved-change protection as manually entering a path.
    open.onclick=()=>{if(chatBusy)return;$('open-path').value=entry.path;$('open-form').requestSubmit();};
    const remove=document.createElement('button');remove.type='button';remove.className='quiet';remove.textContent='移除';remove.setAttribute('aria-label','移除紀錄 '+entry.path);
    remove.onclick=()=>{writeRecentDocuments(recentDocuments().filter(e=>e.path!==entry.path));drawRecentDocuments();};
    row.append(open,remove);list.append(row);
  }
}
$('recent-clear').onclick=()=>{writeRecentDocuments([]);drawRecentDocuments();};

// Ignore stale directory replies when rapidly navigating or closing the file dialog.
let browseGeneration=0,browseParent=null;
async function browseFolder(dir){
  const generation=++browseGeneration;$('browse-files').textContent='正在讀取資料夾…';
  try{
    const listing=await api('browse',{dir,id:current?.id});if(generation!==browseGeneration||!$('open-dialog').open)return;
    browseParent=listing.parent;$('browse-parent').disabled=!listing.parent;$('browse-directory').textContent=listing.dir;$('browse-directory').title=listing.dir;
    $('browse-drive').replaceChildren(...listing.drives.map(drive=>new Option(drive,drive)));
    const drive=listing.drives.find(drive=>listing.dir.toLowerCase().startsWith(drive.toLowerCase()));if(drive)$('browse-drive').value=drive;
    $('browse-files').replaceChildren();
    if(!listing.entries.length)$('browse-files').textContent='此資料夾沒有子資料夾或 Markdown。';
    for(const entry of listing.entries){
      const button=document.createElement('button');button.type='button';button.className='browse-entry';button.textContent=(entry.directory?'▸  ':'▤  ')+entry.name;button.title=entry.path;
      button.onclick=()=>{if(chatBusy)return;if(entry.directory)browseFolder(entry.path);else{$('open-path').value=entry.path;$('open-form').requestSubmit();}};$('browse-files').append(button);
    }
  }catch(error){if(generation===browseGeneration)$('browse-files').textContent=error.message;}
}
$('browse-parent').onclick=()=>{if(browseParent)browseFolder(browseParent);};
$('browse-drive').onchange=()=>browseFolder($('browse-drive').value);
$('open-dialog').addEventListener('close',()=>{browseGeneration++;});

// Every dropped draft remains independently recoverable, including earlier unnamed documents.
function drawUntitledDrafts(){
  let list=$('untitled-drafts');if(!list){list=document.createElement('div');list.id='untitled-drafts';$('recent-files').after(list);}
  list.replaceChildren();const backups=untitledBackups();if(!backups.length)return;
  const heading=document.createElement('strong');heading.textContent='未命名草稿備份';list.append(heading);
  for(const saved of backups){const button=document.createElement('button');button.type='button';button.className='browse-entry';button.textContent=`${saved.name||'未命名草稿'} · ${new Date(saved.time).toLocaleString()}`;button.onclick=async()=>{
    if(chatBusy||dirty&&!confirm('恢復草稿會取代目前編輯內容，是否繼續？'))return;
    try{await restoreUntitled(saved);$('open-dialog').close();}catch(error){$('open-message').textContent=error.message;}
  };list.append(button);}
}
