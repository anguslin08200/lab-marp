// Match the active draft to rendered blocks, leaving both native editing and preview selection intact.
(()=>{
  const editor=document.getElementById('editor'),preview=document.getElementById('preview');
  const toggle=document.getElementById('sync-selection'),mirror=document.getElementById('source-selection-text');
  let renderedText='',blocks=[],doc,win,frame=0,driver='editor',revealing=false;
  toggle.checked=localStorage.getItem('lab-sync-selection')!=='false';
  const valid=()=>toggle.checked&&doc&&renderedText===editor.value;
  // The textarea's native scrollbar consumes width; mirror its content box exactly when wrapping.
  function moveMirror(){mirror.style.width=editor.clientWidth+'px';mirror.style.transform=`translate(${-editor.scrollLeft}px,${-editor.scrollTop}px)`;}
  function sourceMark(start,end){
    mirror.replaceChildren();if(end<=start)return;
    const mark=document.createElement('mark');mark.textContent=editor.value.slice(start,end);
    mirror.append(document.createTextNode(editor.value.slice(0,start)),mark,document.createTextNode(editor.value.slice(end)+'\n'));
    moveMirror();
  }
  function clear(){
    mirror.replaceChildren();doc?.querySelectorAll('.lab-source-match').forEach(el=>el.classList.remove('lab-source-match'));
    win?.CSS?.highlights?.delete('lab-source-selection');
  }
  function elements(){return blocks.map(block=>({...block,element:doc.querySelector(`[data-lab-source="${block.id}"]`)})).filter(block=>block.element);}
  // Math has separate visual and accessibility trees; plain-text matching excludes both.
  function textNodes(element){
    const nodes=[],walker=doc.createTreeWalker(element,4);let node;
    while((node=walker.nextNode()))if(!node.parentElement.closest('.katex,script,style'))nodes.push(node);
    return nodes;
  }
  function textRange(element,needle){
    const nodes=textNodes(element),text=nodes.map(node=>node.textContent).join('');
    let start=needle?text.indexOf(needle):-1,end;
    if(start>=0)end=start+needle.length;else {start=0;end=text.length;}
    if(end<=start)return null;
    const range=doc.createRange();let offset=0,started=false;
    for(const node of nodes){
      const next=offset+node.length;
      if(!started&&start<next){range.setStart(node,start-offset);started=true;}
      if(started&&end<=next){range.setEnd(node,end-offset);return range;}
      offset=next;
    }
    return null;
  }
  function leaves(matches){return matches.filter(a=>!matches.some(b=>a!==b&&a.element.contains(b.element)));}
  function paint(matches,needle=''){
    const ranges=[];
    for(const block of matches){block.element.classList.add('lab-source-match');const range=textRange(block.element,needle);if(range)ranges.push(range);}
    if(win.CSS?.highlights&&win.Highlight&&ranges.length)win.CSS.highlights.set('lab-source-selection',new win.Highlight(...ranges));
  }
  // Scroll only the counterpart, and tell scroll-sync to ignore this deliberate navigation.
  function revealPreview(element){
    element.scrollIntoView({block:'nearest',inline:'nearest'});
    document.dispatchEvent(new CustomEvent('lab-selection-scroll'));
  }
  function revealSource(start,end){
    const style=getComputedStyle(editor),height=parseFloat(style.lineHeight),padding=parseFloat(style.paddingTop);
    const line=editor.value.slice(0,start).split('\n').length-1;
    const last=line+editor.value.slice(start,end).split('\n').length-1;
    // A wrapped prefix can occupy many visual lines (especially embedded images).
    const wrapped=editor.wrap!=='off';
    const top=wrapped?sourceOffsetTop(start):line*height+padding,bottom=wrapped?sourceOffsetTop(end)+height:(last+1)*height+padding;
    if(top<editor.scrollTop||bottom>editor.scrollTop+editor.clientHeight)editor.scrollTop=Math.max(0,top-editor.clientHeight/3);
    // Reveal selections on long, unwrapped lines without changing keyboard focus.
    const column=start-(editor.value.lastIndexOf('\n',start-1)+1),canvas=document.createElement('canvas');
    const ctx=canvas.getContext('2d');ctx.font=style.font;
    const x=padding+ctx.measureText(editor.value.slice(start-column,start)).width;
    if(!wrapped&&(x<editor.scrollLeft||x>editor.scrollLeft+editor.clientWidth-padding))editor.scrollLeft=Math.max(0,x-padding);
    moveMirror();document.dispatchEvent(new CustomEvent('lab-selection-scroll'));
  }
  function fromEditor(reveal){
    const start=editor.selectionStart,end=editor.selectionEnd;if(start===end)return;
    const matches=leaves(elements().filter(block=>block.start<end&&block.end>start));
    if(!matches.length)return;
    const selected=editor.value.slice(start,end);
    // Include Markdown punctuation in the source selection but highlight the rendered label.
    const needle=selected.trim().replace(/^#{1,6}\s+/,'').replace(/^\*\*(.*?)\*\*$/,'$1');
    sourceMark(start,end);paint(matches,needle);
    if(reveal)revealPreview(matches[0].element);
  }
  function fromPreview(reveal){
    const selection=win.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return;
    const range=selection.getRangeAt(0),matches=leaves(elements().filter(block=>{
      if(!range.intersectsNode(block.element))return false;
      // Ignore zero-length boundary intersections between adjacent table cells or blocks.
      const part=range.cloneRange(),whole=doc.createRange();whole.selectNodeContents(block.element);
      if(part.compareBoundaryPoints(0,whole)<0)part.setStart(whole.startContainer,whole.startOffset);
      if(part.compareBoundaryPoints(2,whole)>0)part.setEnd(whole.endContainer,whole.endOffset);
      return part.toString().length>0;
    }));
    if(!matches.length)return;
    let start=Math.min(...matches.map(block=>block.start)),end=Math.max(...matches.map(block=>block.end));
    const selected=selection.toString();
    if(matches.length===1){
      const raw=editor.value.slice(start,end),index=raw.indexOf(selected);
      if(index>=0){
        // Repeated words within one block use the selected occurrence, not the first match.
        const before=doc.createRange();before.selectNodeContents(matches[0].element);before.setEnd(range.startContainer,range.startOffset);
        const count=selected?(before.toString().split(selected).length-1):0;
        let found=index;for(let n=0;n<count;n++){const next=raw.indexOf(selected,found+selected.length);if(next<0)break;found=next;}
        start+=found;end=start+selected.length;
      }
    }
    editor.setSelectionRange(start,end);sourceMark(start,end);paint(matches,selected);
    if(reveal)revealSource(start,end);
  }
  function update(){
    frame=0;const reveal=revealing;revealing=false;clear();if(!valid())return;
    if(driver==='preview')fromPreview(reveal);else fromEditor(reveal);
  }
  function schedule(reveal=false){revealing=revealing||reveal;if(!frame)frame=requestAnimationFrame(update);}
  function sourceSelected(){if(driver==='editor')schedule();}
  function previewSelected(){if(driver==='preview')schedule();}
  // Discard an old native preview selection when the user starts a new source selection.
  const useEditor=()=>{driver='editor';if(toggle.checked)win?.getSelection()?.removeAllRanges();};
  editor.addEventListener('pointerdown',useEditor);
  editor.addEventListener('pointerup',()=>{driver='editor';schedule(true);});
  editor.addEventListener('keydown',useEditor);
  editor.addEventListener('keyup',()=>schedule(true));
  editor.addEventListener('select',sourceSelected);
  document.addEventListener('selectionchange',sourceSelected);
  editor.addEventListener('scroll',moveMirror,{passive:true});
  new ResizeObserver(moveMirror).observe(editor);
  document.addEventListener('lab-editor-layout',moveMirror);
  editor.addEventListener('input',()=>{driver='editor';clear();});
  document.addEventListener('lab-document',()=>{driver='editor';clear();});
  // Incremental renders reuse the document; replace metadata and avoid accumulating styles/listeners.
  const previewDown=()=>{driver='preview';};
  const previewUp=()=>{driver='preview';schedule(true);};
  const previewKey=()=>{driver='preview';schedule(true);};
  document.addEventListener('lab-preview',event=>{
    clear();
    doc?.removeEventListener('selectionchange',previewSelected);
    doc?.removeEventListener('pointerdown',previewDown);doc?.removeEventListener('pointerup',previewUp);doc?.removeEventListener('keyup',previewKey);
    doc=preview.contentDocument;win=preview.contentWindow;renderedText=event.detail.text;blocks=event.detail.selectionBlocks||[];
    doc.getElementById('lab-selection-style')?.remove();
    const style=doc.createElement('style');style.id='lab-selection-style';
    // CSS highlights and outlines never reflow the slide, and are absent from exported PDFs.
    style.textContent='::highlight(lab-source-selection){background:#ffca2880;color:inherit}.lab-source-match{outline:2px solid #e9a800;outline-offset:2px} @media print{.lab-source-match{outline:none}::highlight(lab-source-selection){background:transparent}}';
    doc.head.append(style);
    doc.addEventListener('selectionchange',previewSelected);doc.addEventListener('pointerdown',previewDown);doc.addEventListener('pointerup',previewUp);doc.addEventListener('keyup',previewKey);
    driver='editor';schedule();
  });
  toggle.addEventListener('change',()=>{localStorage.setItem('lab-sync-selection',String(toggle.checked));schedule();});
})();
