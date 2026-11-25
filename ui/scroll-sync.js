// Align source lines with actual slide positions instead of using one whole-document percentage.
(()=>{
  const editor=document.getElementById('editor'),preview=document.getElementById('preview');
  const toggle=document.getElementById('sync-scroll');
  let renderedText='',slideLines=[],driver='editor',frame=0,previewWindow;
  let ignoreEditor=null,ignorePreview=null;
  // Cache wrapped line measurements until source text or textarea width changes.
  let measuredText='',measuredWidth=0,measuredLines=[],measuredOffsets=[];
  toggle.checked=localStorage.getItem('lab-sync-scroll')!=='false';
  function positions(){
    const doc=preview.contentDocument,win=preview.contentWindow;
    if(!doc||renderedText!==editor.value)return null;
    const slides=[...doc.querySelectorAll('.marpit > svg[data-marpit-svg]')];
    if(!slides.length||slides.length!==slideLines.length)return null;
    const style=getComputedStyle(editor),lineHeight=parseFloat(style.lineHeight);
    const sourceMax=Math.max(0,editor.scrollHeight-editor.clientHeight);
    const previewMax=Math.max(0,doc.scrollingElement.scrollHeight-win.innerHeight);
    const padding=parseFloat(win.getComputedStyle(doc.querySelector('.marpit')).paddingTop)||0;
    if(editor.wrap!=='off'&&(measuredText!==editor.value||measuredWidth!==editor.clientWidth||measuredLines.join(',')!==slideLines.join(','))){
      measuredText=editor.value;measuredWidth=editor.clientWidth;measuredLines=slideLines.slice();
      const lines=editor.value.split('\n'),offsets=[0];for(const line of lines)offsets.push(offsets.at(-1)+line.length+1);
      measuredOffsets=measureSourceOffsets(slideLines.map(line=>offsets[line]||0)).map(top=>Math.max(0,top-parseFloat(style.paddingTop)));
    }
    const points=slideLines.map((line,i)=>({
      source:i===0?0:Math.min(sourceMax,editor.wrap==='off'?line*lineHeight:measuredOffsets[i]),
      preview:i===0?0:Math.min(previewMax,Math.max(0,slides[i].getBoundingClientRect().top+win.scrollY-padding))
    }));
    points.push({source:sourceMax,preview:previewMax});return {points,sourceMax,previewMax};
  }
  // Interpolate within each slide; duplicate clamped anchors at the bottom remain bounded.
  function translate(value,points,from,to){
    if(value<=0)return 0;
    if(value>=points.at(-1)[from])return points.at(-1)[to];
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i];
      if(value<b[from])return a[to]+(b[to]-a[to])*(value-a[from])/(b[from]-a[from]);
    }
    return points.at(-1)[to];
  }
  function sync(){
    frame=0;if(!toggle.checked)return;
    const map=positions();if(!map)return;
    if(driver==='editor'){
      if(!map.sourceMax)return;
      const target=translate(editor.scrollTop,map.points,'source','preview');
      if(Math.abs(previewWindow.scrollY-target)>1){previewWindow.scrollTo(previewWindow.scrollX,target);ignorePreview=previewWindow.scrollY;}
    }else{
      if(!map.previewMax)return;
      const target=translate(previewWindow.scrollY,map.points,'preview','source');
      if(Math.abs(editor.scrollTop-target)>1){editor.scrollTop=target;ignoreEditor=editor.scrollTop;}
    }
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(sync);}
  editor.addEventListener('scroll',()=>{
    if(ignoreEditor!==null&&Math.abs(editor.scrollTop-ignoreEditor)<=1){ignoreEditor=null;return;}
    ignoreEditor=null;driver='editor';schedule();
  },{passive:true});
  function previewScrolled(){
    if(ignorePreview!==null&&Math.abs(previewWindow.scrollY-ignorePreview)<=1){ignorePreview=null;return;}
    ignorePreview=null;driver='preview';schedule();
  }
  // Rebind after both initial iframe loads and incremental slide patches.
  document.addEventListener('lab-preview',event=>{
    previewWindow?.removeEventListener('scroll',previewScrolled);
    previewWindow=preview.contentWindow;renderedText=event.detail.text;slideLines=event.detail.slideLines||[];
    ignoreEditor=null;ignorePreview=previewWindow.scrollY;previewWindow.addEventListener('scroll',previewScrolled,{passive:true});schedule();
  });
  editor.addEventListener('input',()=>{driver='editor';});
  // Selection navigation already revealed the counterpart; do not scroll it back by page ratio.
  document.addEventListener('lab-selection-scroll',()=>{
    if(frame){cancelAnimationFrame(frame);frame=0;}
    ignoreEditor=editor.scrollTop;ignorePreview=previewWindow?.scrollY??null;
  });
  document.addEventListener('lab-document',event=>{if(event.detail.changed){driver='editor';editor.scrollTop=0;}});
  toggle.addEventListener('change',()=>{localStorage.setItem('lab-sync-scroll',String(toggle.checked));schedule();});
  // Zoom, splitter dragging, chat visibility and window resizing all change the scroll geometry.
  // Keep the corresponding source position as the anchor when slide dimensions change.
  const geometryChanged=()=>{driver='editor';schedule();};
  new ResizeObserver(geometryChanged).observe(editor);
  new ResizeObserver(geometryChanged).observe(preview);
  document.getElementById('zoom').addEventListener('input',geometryChanged);
  document.addEventListener('lab-editor-layout',geometryChanged);
})();
