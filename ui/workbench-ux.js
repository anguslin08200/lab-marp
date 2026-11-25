// Browser-local drafts are throttled, flushed on navigation, and never sent to Codex implicitly.
let backupTimer,recoveryCandidate=null,backupWarning=false;
const draftKey=path=>'lab-draft:'+path.replaceAll('/','\\').toLowerCase();
const currentDraftKey=(doc=current)=>draftKey(doc.untitled?'untitled:'+doc.backupId:doc.path);
function backupDraft(){
  clearTimeout(backupTimer);backupTimer=null;if(!current||!dirty)return;
  try{localStorage.setItem(currentDraftKey(),JSON.stringify({path:current.path,text:$('editor').value,format:$('format').value,time:Date.now(),untitled:!!current.untitled,backupId:current.backupId,name:current.name}));backupWarning=false;}
  catch{if(!backupWarning){status('瀏覽器備份空間不足，請儲存目前草稿。',true);backupWarning=true;}}
}
function clearDraftBackup(){clearTimeout(backupTimer);backupTimer=null;if(current)localStorage.removeItem(currentDraftKey());$('draft-recovery').hidden=true;recoveryCandidate=null;}
// Untitled files get stable, separate recovery identities even though their display names match.
function untitledBackups(){
  try{return Object.keys(localStorage).filter(key=>key.startsWith('lab-draft:untitled:')).map(key=>({...JSON.parse(localStorage.getItem(key)),key})).filter(item=>item.untitled&&typeof item.text==='string'&&item.backupId).sort((a,b)=>b.time-a.time);}catch{return [];}
}
async function restoreUntitled(saved){
  const doc=await api('draft',{text:saved.text});doc.backupId=saved.backupId;doc.name=saved.name;applyDocument(doc,saved.format||'original');$('draft-recovery').hidden=true;markDirty();status('已恢復未命名草稿，儲存時請另存新檔。');
}
function offerRecovery(){
  $('draft-recovery').hidden=true;recoveryCandidate=null;if(!current)return;
  try{
    const own=JSON.parse(localStorage.getItem(currentDraftKey())||'null');
    const saved=own||(current.template?untitledBackups()[0]:null);
    if(saved&&typeof saved.text==='string'&&Number.isFinite(saved.time)&&saved.time>(current.mtimeMs||0)&&(saved.text!==$('editor').value||saved.format!==$('format').value)){
      recoveryCandidate={...saved,id:current.id};$('draft-description').textContent=`找到 ${new Date(saved.time).toLocaleString()} 的未儲存草稿${saved.untitled?' · '+(saved.name||'未命名'):''}`;$('draft-recovery').hidden=false;
    }
  }catch{/* A damaged or unavailable storage entry must not prevent opening the disk file. */}
}
document.addEventListener('lab-dirty',()=>{if(!backupTimer)backupTimer=setTimeout(backupDraft,700);updateLineNumbers();});
document.addEventListener('lab-document',()=>{offerRecovery();updateLineNumbers();});
$('draft-restore').onclick=async()=>{
  if(!recoveryCandidate||recoveryCandidate.id!==current.id)return;
  if(recoveryCandidate.untitled&&recoveryCandidate.backupId!==current.backupId){try{await restoreUntitled(recoveryCandidate);}catch(error){status(error.message,true);}return;}
  $('editor').value=recoveryCandidate.text;$('format').value=recoveryCandidate.format||'original';$('draft-recovery').hidden=true;recoveryCandidate=null;markDirty();render();status('已恢復未儲存草稿。');
};
$('draft-discard').onclick=()=>{if(recoveryCandidate?.untitled&&recoveryCandidate.backupId!==current?.backupId){localStorage.removeItem(draftKey('untitled:'+recoveryCandidate.backupId));offerRecovery();}else clearDraftBackup();};
window.addEventListener('pagehide',backupDraft);
document.addEventListener('visibilitychange',()=>{if(document.hidden)backupDraft();});
window.addEventListener('beforeunload',backupDraft);

// Both the textarea and the selection mirror use the same wrapping geometry.
function updateLineNumbers(){const editor=$('editor');$('line-numbers').textContent=Array.from({length:editor.value.split('\n').length},(_,i)=>i+1).join('\n');$('line-numbers').scrollTop=editor.scrollTop;}
function setEditorWrap(){
  const wrap=$('wrap-editor').checked;$('editor').wrap=wrap?'soft':'off';document.querySelector('.editor-frame').classList.toggle('wrapped',wrap);$('line-numbers').hidden=wrap;localStorage.setItem('lab-wrap',String(wrap));
  $('wrap-editor').title=wrap?'自動換行已開啟；行號暫時隱藏':'顯示行號；長行可水平捲動';
  document.dispatchEvent(new Event('lab-editor-layout'));updateLineNumbers();
}
$('wrap-editor').checked=localStorage.getItem('lab-wrap')!=='false';$('wrap-editor').onchange=setEditorWrap;setEditorWrap();
$('editor').addEventListener('scroll',()=>$('line-numbers').scrollTop=$('editor').scrollTop,{passive:true});
$('editor').addEventListener('input',updateLineNumbers);

// Keep one primary PDF action and expose alternate formats in a compact dropdown.
$('export-toggle').onclick=()=>{const open=$('export-menu').hidden;$('export-menu').hidden=!open;$('export-toggle').setAttribute('aria-expanded',String(open));};
for(const button of document.querySelectorAll('[data-export]'))button.onclick=()=>{
  $('export-menu').hidden=true;$('export-toggle').setAttribute('aria-expanded','false');action($('export'),()=>exportDraft(button.dataset.export));
};
document.addEventListener('click',event=>{if(!event.target.closest('.export-group')){$('export-menu').hidden=true;$('export-toggle').setAttribute('aria-expanded','false');}});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='o'){event.preventDefault();if(!$('open').disabled)showOpenDocument();}
});

// Browser drops lack a trusted local path, so their contents become an explicit Save As draft.
document.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';document.body.classList.add('file-dragging');}});
document.addEventListener('dragleave',event=>{if(!event.relatedTarget)document.body.classList.remove('file-dragging');});
document.addEventListener('drop',async event=>{
  document.body.classList.remove('file-dragging');const files=[...event.dataTransfer.files];if(!files.length)return;event.preventDefault();
  if(chatBusy){status('請等待 Codex 完成後再開啟檔案。',true);return;}
  const file=files.find(file=>/\.md$/i.test(file.name));if(!file){status('請拖入 .md Markdown 檔案。',true);return;}
  if(dirty&&!confirm('開啟拖入的檔案會取代目前編輯內容，是否繼續？'))return;
  try{
    const doc=await api('draft',{text:await file.text(),name:file.name});doc.name=file.name;applyDocument(doc);markDirty();
    status('已以未命名草稿開啟，儲存時請另存新檔。瀏覽器未提供來源路徑，相對圖片無法解析；請用「開啟」指定原檔路徑。',true);
  }catch(error){status(error.message,true);}
});
