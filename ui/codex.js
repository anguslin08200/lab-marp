// Codex returns validated draft changes; source files are saved only by the existing Save action.
let chatSession=null,chatBusy=false,chatConnected=false,chatAbort=null,chatCancelled=false;
let pendingProposal=null,lastCodexChange=null;
let chatAttachments=[],uploadBusy=false,attachmentGeneration=0;
let chatCatalog={models:[]};
// Keep polling and a pending send scoped to the current conversation generation.
let mineruAvailable=false,mineruPoll=null,mineruPolling=false,waitingSend=null,sendDecision=false;
const mineruPending=item=>['queued','parsing'].includes(item.mineru?.state);
function setMineruCapability(capability){
  if(!capability)return;mineruAvailable=!!capability.available;
  const checkbox=$('codex-mineru');checkbox.disabled=!mineruAvailable;
  $('mineru-reason').textContent=mineruAvailable?'':(capability.reason||'MinerU 無法使用');
  $('mineru-label').title=mineruAvailable?'':$('mineru-reason').textContent;
}
$('codex-mineru').checked=localStorage.getItem('lab-codex-mineru')!=='false';
$('codex-mineru').onchange=()=>localStorage.setItem('lab-codex-mineru',String($('codex-mineru').checked));
function cancelWaitingSend(){
  if(waitingSend)waitingSend.cancelled=true;
  if($('mineru-wait-dialog').open)$('mineru-wait-dialog').close('cancel');
}
function scheduleMineruPoll(){
  if(mineruPoll||mineruPolling||!chatAttachments.some(mineruPending))return;
  mineruPoll=setTimeout(pollMineru,1000);
}
async function pollMineru(){
  mineruPoll=null;if(mineruPolling)return;const generation=attachmentGeneration;
  const ids=chatAttachments.filter(mineruPending).map(item=>item.id);if(!ids.length)return;
  mineruPolling=true;
  try{
    const result=await api('codex/upload-status',{ids});
    if(generation===attachmentGeneration){
      const updates=new Map(result.attachments.map(item=>[item.id,item]));
      chatAttachments=chatAttachments.map(item=>updates.has(item.id)?{...item,...updates.get(item.id)}:item);
    }
  }catch(error){chatProgress('解析狀態更新失敗：'+error.message,true);}
  finally{mineruPolling=false;drawAttachments();scheduleMineruPoll();}
}
function pendingChoice(){
  return new Promise(resolve=>{
    const dialog=$('mineru-wait-dialog');
    dialog.returnValue='cancel';dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});dialog.showModal();
  });
}
for(const [id,value] of [['mineru-cancel','cancel'],['mineru-fast','fast'],['mineru-wait','wait']])$(id).onclick=()=>$('mineru-wait-dialog').close(value);

let chatStartedAt=0,chatTicker=null,chatStage='';
function chatProgress(text,error=false){chatStage=text;$('codex-progress').textContent=text+(chatBusy&&!error?` · 已等待 ${Math.floor((Date.now()-chatStartedAt)/1000)} 秒`:'');$('codex-progress').classList.toggle('error',error);}
function chatMessage(role,text){
  $('codex-messages').querySelector('.codex-empty')?.remove();
  const bubble=document.createElement('div');bubble.className=`chat-message ${role}`;
  const label=document.createElement('strong');label.textContent=role==='user'?'你':'Codex';
  const content=document.createElement('div');content.className='chat-text';content.textContent=text;bubble.append(label,content);$('codex-messages').append(bubble);scrollChat();return content;
}
function scrollChat(){$('codex-messages').scrollTop=$('codex-messages').scrollHeight;}
function setChatBusy(value){
  chatBusy=value;$('codex-send').disabled=value||uploadBusy||!chatConnected||!!waitingSend||sendDecision;$('codex-stop').hidden=!value&&!waitingSend;
  // Full Markdown may keep streaming after the short reply; show elapsed time without claiming completion.
  clearInterval(chatTicker);chatTicker=null;
  if(value){chatStartedAt=Date.now();chatTicker=setInterval(()=>{if(chatBusy&&!$('codex-progress').classList.contains('error'))chatProgress(chatStage);},1000);}
    // Remove the elapsed suffix once the final result or cancellation has arrived.
    else chatProgress(chatStage,$('codex-progress').classList.contains('error'));
  $('codex-model').disabled=value||!chatConnected;$('codex-effort').disabled=value||!chatConnected||!selectedChatModel()?.supportedReasoningEfforts?.length;$('codex-upload').disabled=value||uploadBusy||!!waitingSend||sendDecision;
  for(const button of $('codex-attachments').querySelectorAll('button'))button.disabled=value||uploadBusy;
  $('codex-reset').disabled=value||uploadBusy;$('codex-reconnect').disabled=value||uploadBusy;
  // Keep typing available; snapshot comparison protects concurrent manual changes.
  // Reload remains unavailable for unnamed drops because they have no disk source yet.
  for(const id of ['open','new','save','save-as','reload','format'])$(id).disabled=value||(id==='reload'&&!!current?.untitled);
  $('codex-undo').disabled=value||!lastCodexChange;$('codex-apply').disabled=value;
}
async function connectCodex(){
  $('codex-connection').textContent='連線中…';$('codex-reconnect').disabled=true;
  try{
    const result=await api('codex/status',{});setMineruCapability(result.mineru);chatConnected=result.available&&result.loggedIn;
    $('codex-connection').textContent=chatConnected?(result.accountType==='chatgpt'?'已連線 · ChatGPT':'已連線'):'尚未連線';
    $('codex-connection').classList.toggle('connected',chatConnected);
    if(!chatConnected)chatProgress(result.error||'請先在終端機執行 codex login，再按重新連線。',true);
    else{
      try{
        const catalog=await api('codex/models',{});chatCatalog=catalog;const select=$('codex-model'),previous=select.value||localStorage.getItem('lab-codex-model')||'';
        select.replaceChildren(new Option('沿用 CLI 設定'+(catalog.defaultModel?' · '+catalog.defaultModel:''),''));
        for(const model of catalog.models){const option=new Option(model.name,model.id);option.title=model.description;select.append(option);}
        select.value=catalog.models.some(m=>m.id===previous)?previous:'';updateEfforts();chatProgress('可選擇模型、加入參考檔案，或直接要求修改簡報。');
      }catch(e){chatProgress('模型清單載入失敗：'+e.message,true);}
    }
  }catch(e){chatConnected=false;$('codex-connection').textContent='連線失敗';chatProgress(e.message,true);}
  finally{$('codex-reconnect').disabled=false;setChatBusy(chatBusy);}
}
function clearChat(){cancelWaitingSend();chatSession=null;pendingProposal=null;lastCodexChange=null;attachmentGeneration++;for(const item of chatAttachments)api('codex/remove-upload',{id:item.id}).catch(()=>{});chatAttachments=[];drawAttachments();$('codex-apply').hidden=true;$('codex-undo').disabled=true;$('codex-messages').replaceChildren();chatProgress('新的對話會以目前編輯內容開始。');}
function applyCodexProposal(proposal){
  const before={id:current.id,text:$('editor').value,format:$('format').value};
  if(proposal.markdown!==null)$('editor').value=proposal.markdown;
  $('format').value=proposal.format;
  lastCodexChange={before,after:{text:$('editor').value,format:$('format').value}};
  pendingProposal=null;$('codex-apply').hidden=true;$('codex-undo').disabled=chatBusy;
  markDirty();clearTimeout(timer);render();chatProgress('已更新 Markdown 與預覽。按「儲存」寫入檔案。');
}
// The server sends a POST SSE stream so credentials stay in headers, not URL query strings.
async function streamChat(body,receive,signal){
  const response=await fetch('/api/codex/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':token},body:JSON.stringify(body),signal});
  if(!response.ok){const error=await response.json();throw new Error(error.error||'Codex 連線失敗。');}
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  try{
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const event=block.split('\n').find(line=>line.startsWith('event: '))?.slice(7);
        const data=block.split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');
        if(event&&data)receive(event,JSON.parse(data));
      }
    }
  }finally{reader.releaseLock();}
}
async function submitChat(event){
  event.preventDefault();if(chatBusy||uploadBusy||!chatConnected||!current)return;
  const message=$('codex-input').value.trim();if(!message)return;
  // Lock submission while the choice is open or parsing is being awaited.
  if(sendDecision||waitingSend)return;
  let fastText=false;
  if(chatAttachments.some(mineruPending)){
    sendDecision=true;$('codex-send').disabled=true;
    const generation=attachmentGeneration,documentId=current.id,ids=chatAttachments.map(item=>item.id),originalMessage=message;
    let choice;
    try{choice=await pendingChoice();}finally{sendDecision=false;}
    if(choice!=='fast'&&choice!=='wait'){setChatBusy(false);return;}
    if(generation!==attachmentGeneration||current?.id!==documentId||ids.some(id=>!chatAttachments.some(item=>item.id===id))){setChatBusy(false);return;}
    fastText=choice==='fast';
    if(choice==='wait'){
      const wait={cancelled:false};waitingSend=wait;setChatBusy(false);chatProgress('等待論文解析完成…');
      while(!wait.cancelled&&generation===attachmentGeneration&&current?.id===documentId&&ids.every(id=>chatAttachments.some(item=>item.id===id))&&chatAttachments.some(item=>ids.includes(item.id)&&mineruPending(item)))await new Promise(resolve=>setTimeout(resolve,250));
      waitingSend=null;$('codex-stop').hidden=true;
      if(wait.cancelled||generation!==attachmentGeneration||current?.id!==documentId||ids.some(id=>!chatAttachments.some(item=>item.id===id))||$('codex-input').value.trim()!==originalMessage){setChatBusy(false);chatProgress('已取消等待傳送。');return;}
    }
  }
  const snapshot={...payload()};pendingProposal=null;$('codex-apply').hidden=true;
  const attached=chatAttachments.map(a=>a.id);
  chatMessage('user',message+(attached.length?'\n附件：'+chatAttachments.map(a=>a.name).join('、'):''));const assistant=chatMessage('assistant','');$('codex-input').value='';
  chatAbort=new AbortController();chatCancelled=false;setChatBusy(true);chatProgress('正在連接 Codex…');
  let completed=false,failed=false;
  try{
    await streamChat({...snapshot,message,sessionId:chatSession,model:$('codex-model').value,effort:$('codex-effort').value,attachmentIds:attached,fastText},(event,data)=>{
      if(event==='session'){chatSession=data.sessionId;$('codex-connection').textContent=`已連線 · ${data.model}${data.effort?" · "+data.effort:""}`;}
      if(event==='status')chatProgress(data.text);
      if(event==='reply'){assistant.textContent=data.text;scrollChat();chatProgress('已收到說明，正在生成完整回覆與 Markdown，尚未套用…');}
      if(event==='error'){failed=true;chatSession=null;assistant.textContent=assistant.textContent||data.message;chatProgress(data.message,true);}
      if(event==='complete'){
        completed=true;assistant.textContent=data.reply;scrollChat();
        if(chatCancelled){chatProgress('已停止，Markdown 未更改。');return;}
        if(!data.changed){chatProgress('回覆完成。');return;}
        if(current.id!==snapshot.id||$('editor').value!==snapshot.text||$('format').value!==snapshot.format){
          pendingProposal={...data,snapshot};$('codex-apply').hidden=false;chatProgress('你已繼續編輯。Codex 的修改已保留，可按「套用回覆中的修改」。');
        }else applyCodexProposal(data);
      }
    },chatAbort.signal);
    if(!completed&&!failed)throw new Error('Codex 回覆中斷，Markdown 未更改。');
  }catch(e){if(chatCancelled||e.name==='AbortError'){assistant.textContent=assistant.textContent||'已停止。';chatProgress('已停止，Markdown 未更改。');}else{assistant.textContent=assistant.textContent||e.message;chatProgress(e.message,true);}}
  finally{chatAbort=null;setChatBusy(false);}
}
$('codex-form').addEventListener('submit',submitChat);
$('codex-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('codex-form').requestSubmit();}});
$('codex-stop').onclick=()=>{
  if(waitingSend){cancelWaitingSend();return;}
  chatCancelled=true;chatProgress('正在停止…');
  if(chatSession)api('codex/cancel',{sessionId:chatSession}).finally(()=>{chatAbort?.abort();chatSession=null;}).catch(()=>{});
  else chatAbort?.abort();
};
$('codex-reconnect').onclick=connectCodex;
// Cancel a pending send immediately, before waiting for the server to reset the session.
$('codex-reset').onclick=async()=>{cancelWaitingSend();try{if(chatSession)await api('codex/reset',{sessionId:chatSession});clearChat();}catch(e){chatProgress(e.message,true);}};
$('codex-apply').onclick=()=>{
  if(pendingProposal?.baseId!==current.id){chatProgress('這份修改屬於先前的檔案，請重新送出要求。',true);return;}
  // Delayed proposals replace the whole draft, so explicitly protect later manual edits.
  if(($('editor').value!==pendingProposal.snapshot.text||$('format').value!==pendingProposal.snapshot.format)&&!confirm('套用此回覆會取代送出要求之後的手動編輯，是否繼續？'))return;
  applyCodexProposal(pendingProposal);
};
$('codex-undo').onclick=()=>{
  if(!lastCodexChange||lastCodexChange.before.id!==current.id)return;
  const {before,after}=lastCodexChange;
  if(($('editor').value!==after.text||$('format').value!==after.format)&&!confirm('復原會取代這次 Codex 修改之後的手動編輯，是否繼續？'))return;
  $('editor').value=before.text;$('format').value=before.format;lastCodexChange=null;$('codex-undo').disabled=true;markDirty();render();chatProgress('已復原上次 Codex 修改。');
};
// Collapse changes only layout: transcript, attachments, and in-flight requests survive.
$('toggle-codex').onclick=()=>setChatCollapsed(!$('codex-pane').classList.contains('collapsed'));
$('codex-collapse').onclick=$('toggle-codex').onclick;
document.addEventListener('lab-document',event=>{if(event.detail.changed&&!chatBusy)clearChat();});
document.addEventListener('lab-ready',event=>{setMineruCapability(event.detail?.mineru);connectCodex();},{once:true});

// File contents stay local during upload and go to Codex only with an explicit chat submission.
function drawAttachments(){
  $('codex-attachments').replaceChildren();
  for(const item of chatAttachments){
    const chip=document.createElement('span');chip.className='attachment-chip';
    const label=document.createElement('span');label.textContent=item.name;label.title=`${item.name} ? ${Math.ceil(item.bytes/1024)} KB`;
    chip.append(label);
    // Expose parsing progress and the fast-text fallback without hiding the filename.
    const result=item.mineru;
    if(result){
      const state=document.createElement('span');state.className='mineru-state';
      if(result.state==='queued'){
        const queued=typeof result.queuedAt==='number'?(result.queuedAt<1e12?result.queuedAt*1000:result.queuedAt):Date.parse(result.queuedAt);
        state.textContent='排隊中'+(Number.isFinite(queued)?` ${Math.max(0,Math.floor((Date.now()-queued)/1000))} 秒`:'');
      }
      if(result.state==='parsing'){
        const started=typeof result.startedAt==='number'?(result.startedAt<1e12?result.startedAt*1000:result.startedAt):Date.parse(result.startedAt);
        state.textContent='解析中…'+(Number.isFinite(started)?` ${Math.max(0,Math.floor((Date.now()-started)/1000))} 秒`:'');
      }
      if(result.state==='complete')state.textContent=`已解析：${result.figures||0} 項`;
      if(result.state==='failed')state.textContent=`解析失敗：${result.error||'未知錯誤'}，使用快速文字`;
      if(result.truncated)state.textContent+=(state.textContent?' · ':'')+'已截斷';
      state.title=state.textContent;chip.append(state);
      if(result.state==='complete'&&result.figures>0){const figures=document.createElement('button');figures.type='button';figures.textContent='圖片';figures.disabled=chatBusy||uploadBusy;figures.onclick=()=>openMineruFigures(item);chip.append(figures);}
    }
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除 '+item.name);remove.disabled=chatBusy||uploadBusy;
    remove.onclick=async()=>{cancelWaitingSend();chatAttachments=chatAttachments.filter(a=>a.id!==item.id);drawAttachments();try{await api('codex/remove-upload',{id:item.id});}catch(e){chatProgress(e.message,true);}};
    chip.append(remove);$('codex-attachments').append(chip);
  }
  scheduleMineruPoll();
}
// Capture the editor selection before opening the modal and discard stale async responses.
let figureGeneration=0;
async function openMineruFigures(item){
  const generation=++figureGeneration,documentId=current?.id,editor=$('editor'),start=editor.selectionStart,end=editor.selectionEnd;
  const dialog=$('mineru-figures-dialog'),grid=$('mineru-figures-grid'),message=$('mineru-figures-message');grid.replaceChildren();message.textContent='載入圖片中…';dialog.showModal();
  try{
    const result=await api('codex/figures',{id:item.id});
    if(generation!==figureGeneration||!dialog.open||current?.id!==documentId||!chatAttachments.some(a=>a.id===item.id))return;
    message.textContent=result.figures.length?'選擇圖片插入游標位置。':'沒有可插入的圖片。';
    // MinerU also crops equations and tables; group them so architecture figures and charts come first.
    const kindOf=file=>/_equation_/.test(file)?'equation':/_table_/.test(file)?'table':'figure';
    const groups=[['figure','圖與圖表'],['table','表格'],['equation','公式']].map(([kind,label])=>({kind,label,count:result.figures.filter(f=>kindOf(f.file)===kind).length})).filter(g=>g.count);
    const tabs=document.createElement('div');tabs.className='figure-tabs';tabs.setAttribute('role','tablist');grid.before(tabs);
    const showKind=kind=>{for(const b of grid.children)b.hidden=b.dataset.kind!==kind;for(const t of tabs.children)t.setAttribute('aria-selected',String(t.dataset.kind===kind));};
    for(const group of groups){const tab=document.createElement('button');tab.type='button';tab.setAttribute('role','tab');tab.dataset.kind=group.kind;tab.textContent=`${group.label} ${group.count}`;tab.onclick=()=>showKind(group.kind);tabs.append(tab);}
    dialog.addEventListener('close',()=>tabs.remove(),{once:true});
    for(const figure of result.figures){
      const button=document.createElement('button'),image=document.createElement('img'),caption=document.createElement('span');button.type='button';button.dataset.kind=kindOf(figure.file);image.src=figure.dataURI;image.alt=`第 ${figure.page} 頁`;caption.textContent=`第 ${figure.page} 頁`;button.append(image,caption);grid.append(button);
      button.onclick=async()=>{
        for(const choice of grid.querySelectorAll('button'))choice.disabled=true;
        try{
          const inserted=await api('codex/insert-figure',{id:item.id,file:figure.file,documentId});
          if(generation!==figureGeneration||!dialog.open||current?.id!==documentId||!chatAttachments.some(a=>a.id===item.id))return;
          editor.setRangeText(inserted.markdown,start,end,'end');markDirty();clearTimeout(timer);render();dialog.close();editor.focus();
        }catch(error){message.textContent=error.message;for(const choice of grid.querySelectorAll('button'))choice.disabled=false;}
      };
    }
    // Open on figures/charts when present; equations stay one click away.
    if(groups.length)showKind(groups[0].kind);
  }catch(error){if(generation===figureGeneration&&dialog.open)message.textContent=error.message;}
}
$('mineru-figures-close').onclick=()=>$('mineru-figures-dialog').close();
$('mineru-figures-dialog').addEventListener('close',()=>{figureGeneration++;});
$('codex-model').onchange=()=>{localStorage.setItem('lab-codex-model',$('codex-model').value);updateEfforts();chatProgress('下一次訊息會使用所選模型，保留目前對話。');};
$('codex-upload').onclick=()=>{$('codex-files').click();};
$('codex-files').onchange=async()=>{
  const files=[...$('codex-files').files];$('codex-files').value='';if(!files.length||chatBusy||uploadBusy)return;
  if(files.length+chatAttachments.length>5){chatProgress('最多可加入 5 個附件。',true);return;}
  if(files.some(f=>f.size>10*1024*1024)||files.reduce((sum,f)=>sum+f.size,chatAttachments.reduce((sum,a)=>sum+a.bytes,0))>25*1024*1024){chatProgress('每檔上限 10 MB，附件合計上限 25 MB。',true);return;}
  const generation=attachmentGeneration;uploadBusy=true;setChatBusy(chatBusy);
  let failed=false;
  try{
    for(const file of files){
      chatProgress('正在讀取 '+file.name+'…');
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('檔案讀取失敗：'+file.name));reader.readAsDataURL(file);});
      const item=await api('codex/upload',{name:file.name,data,mineru:mineruAvailable&&$('codex-mineru').checked});
      if(generation!==attachmentGeneration){await api('codex/remove-upload',{id:item.id});continue;}
      chatAttachments.push(item);drawAttachments();
    }
  }catch(e){failed=true;chatProgress(e.message,true);}
  finally{uploadBusy=false;setChatBusy(chatBusy);drawAttachments();if(!failed&&generation===attachmentGeneration)chatProgress('附件已準備。輸入要求後按「傳送」；尚未傳送到 Codex。');}
};
// Keep per-model effort preferences and preserve the CLI-advertised order and descriptions.
function selectedChatModel(){return chatCatalog.models.find(m=>m.id===($('codex-model').value||chatCatalog.defaultModel));}
function updateEfforts(){
  const model=selectedChatModel(),select=$('codex-effort'),supported=model?.supportedReasoningEfforts||[];
  const preferred=!$('codex-model').value?chatCatalog.defaultEffort:null;
  const fallback=supported.some(e=>e.reasoningEffort===preferred)?preferred:model?.defaultReasoningEffort;
  select.replaceChildren(new Option('預設'+(fallback?' · '+fallback:''),''));
  for(const item of supported){const option=new Option(item.reasoningEffort,item.reasoningEffort);option.title=item.description;select.append(option);}
  const saved=localStorage.getItem('lab-codex-effort-'+(model?.id||''))||'';
  select.value=supported.some(e=>e.reasoningEffort===saved)?saved:'';
  select.disabled=chatBusy||!chatConnected||!supported.length;
}
$('codex-effort').onchange=()=>{localStorage.setItem('lab-codex-effort-'+(selectedChatModel()?.id||''),$('codex-effort').value);chatProgress('下一次訊息會使用所選 effort，保留目前對話。');};
// Use a percentage so the chat/editor balance survives viewport changes without hiding the editor.
// Start compact while continuing to honor the user's explicitly dragged percentage.
let chatHeight=Number(localStorage.getItem('lab-codex-height'))||38;
function layoutChat(){
  const pane=$('codex-pane'),parent=pane.parentElement;
  const available=parent.clientHeight-50-34-8-80;
  const height=Math.max(0,Math.min(parent.clientHeight*chatHeight/100,available));
  pane.style.setProperty('--chat-height',height+'px');
  $('codex-divider').setAttribute('aria-valuenow',Math.round(height));
  $('codex-divider').setAttribute('aria-valuemin','0');$('codex-divider').setAttribute('aria-valuemax',Math.max(0,available));
}
function setChatCollapsed(collapsed){
  $('codex-pane').classList.toggle('collapsed',collapsed);$('codex-divider').hidden=collapsed;
  $('codex-collapse').textContent=collapsed?'展開':'收起';
  for(const id of ['toggle-codex','codex-collapse'])$(id).setAttribute('aria-expanded',String(!collapsed));
  localStorage.setItem('lab-codex-collapsed',String(collapsed));layoutChat();
}
const chatDivider=$('codex-divider');let chatDrag=null;
chatDivider.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();chatDrag={y:e.clientY,height:$('codex-pane').getBoundingClientRect().height};chatDivider.setPointerCapture(e.pointerId);document.body.classList.add('chat-dragging');});
chatDivider.addEventListener('pointermove',e=>{if(!chatDrag)return;chatHeight=Math.max(15,Math.min(85,(chatDrag.height+chatDrag.y-e.clientY)/$('codex-pane').parentElement.clientHeight*100));layoutChat();});
function finishChatDrag(){if(!chatDrag)return;chatDrag=null;document.body.classList.remove('chat-dragging');localStorage.setItem('lab-codex-height',String(chatHeight));}
for(const event of ['pointerup','pointercancel','lostpointercapture'])chatDivider.addEventListener(event,finishChatDrag);
chatDivider.addEventListener('keydown',e=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();chatHeight=e.key==='Home'?15:e.key==='End'?85:Math.max(15,Math.min(85,chatHeight+(e.key==='ArrowUp'?3:-3)));layoutChat();localStorage.setItem('lab-codex-height',String(chatHeight));});
new ResizeObserver(layoutChat).observe($('codex-pane').parentElement);
setChatCollapsed(localStorage.getItem('lab-codex-collapsed')==='true');
