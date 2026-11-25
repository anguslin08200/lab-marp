// Patch unchanged slide documents in place so images and iframe state survive typing.
let previewHead='',previewMeta='',previewSlides=[],previewMap=[],activeSlide=0,navigationWindow,presentationSlide=0,presentationExit=Promise.resolve(),presentationOpening=false;
// Marp may wrap SVGs in its own .marpit inside the workbench's layout wrapper.
function slideContainer(doc){return doc?.querySelector('svg[data-marpit-svg]')?.parentElement;}
function slideNodes(){return [...(slideContainer($('preview').contentDocument)?.children||[])];}
function frontmatter(text){return text.replace(/^\uFEFF/,'').match(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0]||'';}
function stablePreviewHtml(html){
  // Marpit randomizes scoped-style IDs on every render, even when CSS is unchanged.
  // Canonicalize attributes, selectors and scoped animation suffixes together.
  const scopes=new Map();for(const match of html.matchAll(/data-marpit-scope-([a-zA-Z0-9]{8})\b/g))if(!scopes.has(match[1]))scopes.set(match[1],`labscope${scopes.size}`);
  html=html.replace(/data-marpit-scope-([a-zA-Z0-9]{8})\b/g,(_,key)=>`data-marpit-scope-${scopes.get(key)}`);
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,(_,open,css,close)=>{
    for(const [key,stable] of scopes)css=css.replace(new RegExp(`-${key}(?=[^a-zA-Z0-9_-]|$)`,'g'),`-${stable}`);
    return open+css+close;
  });
}
function updatePreview(result,draft,version){
  const parsed=new DOMParser().parseFromString(stablePreviewHtml(result.html),'text/html');
  // Marp helpers cannot execute in the sandbox; removing them also avoids console noise.
  parsed.querySelectorAll('script').forEach(node=>node.remove());
  const head=parsed.head.innerHTML,meta=frontmatter(draft.text),incoming=[...slideContainer(parsed).children];
  const signatures=incoming.map(node=>node.outerHTML),iframe=$('preview'),oldScroll=iframe.contentWindow?.scrollY||0;
  const finish=()=>{
    if(version!==renderVersion)return;
    previewHead=head;previewMeta=meta;previewSlides=signatures;previewMap=result.slideLines||[];
    resizePreview();iframe.contentWindow.scrollTo(0,oldScroll);
    $('page-count').textContent=`${result.pages} 頁`;
    document.dispatchEvent(new CustomEvent('lab-preview',{detail:{text:draft.text,slideLines:result.slideLines,selectionBlocks:result.selectionBlocks}}));
    refreshNavigation();drawThumbnails();
  };
  if(!iframe.contentDocument?.querySelector('.marpit')||head!==previewHead||meta!==previewMeta){
    iframe.onload=finish;iframe.srcdoc='<!doctype html>'+parsed.documentElement.outerHTML;
  }else{
    const container=slideContainer(iframe.contentDocument);
    incoming.forEach((node,index)=>{
      if(signatures[index]===previewSlides[index])return;
      const replacement=iframe.contentDocument.importNode(node,true);
      if(container.children[index])container.children[index].replaceWith(replacement);else container.append(replacement);
    });
    while(container.children.length>incoming.length)container.lastElementChild.remove();
    finish();
  }
}
// Track the slide crossing the viewport's reading edge, even when several pages fit on screen.
function refreshNavigation(){
  const slides=slideNodes(),win=$('preview').contentWindow;if(!slides.length)return;
  const target=Math.min(80,win.innerHeight*.1);
  activeSlide=0;slides.forEach((node,index)=>{if(node.getBoundingClientRect().top<=target)activeSlide=index;});
  $('current-page').textContent=`第 ${activeSlide+1} / `;
  $('previous-slide').disabled=activeSlide===0;$('next-slide').disabled=activeSlide===slides.length-1;
  [...$('thumbnails').children].forEach((button,index)=>button.setAttribute('aria-current',String(index===activeSlide)));
}
// A layout probe measures wrapped source offsets without touching selection or keyboard focus.
function sourceOffsetTop(offset){
  return measureSourceOffsets([offset])[0];
}
function measureSourceOffsets(offsets){
  const editor=$('editor'),probe=document.createElement('div'),style=getComputedStyle(editor);
  for(const property of ['font','lineHeight','letterSpacing','tabSize','padding','whiteSpace','overflowWrap','wordBreak','boxSizing'])probe.style[property]=style[property];
  probe.style.cssText+=';position:fixed;visibility:hidden;left:-100000px;top:0;';probe.style.width=editor.clientWidth+'px';
  const origin=document.createElement('span');origin.textContent='\u200b';probe.append(origin);
  let previous=0;const markers=[];
  // Measure every slide in one layout pass rather than repeatedly laying out embedded base64 text.
  for(const offset of offsets){const marker=document.createElement('span');marker.textContent='\u200b';probe.append(document.createTextNode(editor.value.slice(previous,offset)),marker);markers.push(marker);previous=offset;}
  document.body.append(probe);
  // Subtract the font's inline leading, leaving a true line-top coordinate.
  const top=origin.getBoundingClientRect().top,y=markers.map(marker=>marker.getBoundingClientRect().top-top+parseFloat(style.paddingTop));probe.remove();return y;
}
function jumpSlide(index,source=true){
  const slides=slideNodes();index=Math.max(0,Math.min(slides.length-1,index));if(!slides[index])return;
  const win=$('preview').contentWindow;win.scrollTo(0,slides[index].getBoundingClientRect().top+win.scrollY-20);
  if(source){const editor=$('editor'),line=previewMap[index]||0,offset=editor.value.split('\n').slice(0,line).reduce((sum,text)=>sum+text.length+1,0);editor.setSelectionRange(offset,offset);editor.scrollTop=Math.max(0,sourceOffsetTop(offset)-24);document.dispatchEvent(new CustomEvent('lab-selection-scroll'));}
  activeSlide=index;refreshNavigation();
}
function drawThumbnails(){
  const sidebar=$('thumbnails');if(sidebar.hidden)return;
  const slides=slideNodes();
  while(sidebar.children.length>slides.length)sidebar.lastElementChild.remove();
  slides.forEach((slide,index)=>{
    let button=sidebar.children[index];
    if(!button){button=document.createElement('button');button.type='button';button.onclick=()=>jumpSlide(index);sidebar.append(button);}
    button.title=`跳至第 ${index+1} 頁`;button.setAttribute('aria-label',button.title);
    const signature=previewHead+previewSlides[index];if(button._signature===signature)return;button._signature=signature;
    const label=document.createElement('span');label.textContent=`${index+1}`;
    // Shadow DOM contains slide styles so thumbnail CSS cannot leak into the workbench.
    const miniature=document.createElement('div'),shadow=miniature.attachShadow({mode:'open'}),style=document.createElement('style');miniature.inert=true;miniature.setAttribute('aria-hidden','true');
    const base=$('preview').contentDocument.baseURI;
    style.textContent=absoluteCss([...$('preview').contentDocument.head.querySelectorAll('style:not(#preview-zoom):not(#lab-selection-style)')].map(node=>node.textContent).join('\n'),base)+'\n.marpit{padding:0;gap:0;min-width:0}.marpit>svg{width:100%;height:auto;box-shadow:none}';
    const container=document.createElement('div');container.className='marpit';container.innerHTML=previewSlides[index];
    // Thumbnail content enters the parent document, so remove active HTML before attachment.
    container.querySelectorAll('script,iframe,object,embed,link,meta,base,animate,set,animateMotion,animateTransform').forEach(node=>node.remove());
    container.querySelectorAll('*').forEach(node=>{for(const attribute of [...node.attributes])if(/^on/i.test(attribute.name)||attribute.name==='srcdoc'||/^\s*javascript:/i.test(attribute.value))node.removeAttribute(attribute.name);});
    // A shadow root has the workbench's base URL; resolve only resource attributes against the deck.
    container.querySelectorAll('[src],image[href],image[xlink\\:href],use[href],[style]').forEach(node=>{
      for(const attribute of ['src','href','xlink:href'])if(node.hasAttribute(attribute))node.setAttribute(attribute,absoluteResource(node.getAttribute(attribute),base));
      if(node.hasAttribute('style'))node.setAttribute('style',absoluteCss(node.getAttribute('style'),base));
    });container.querySelectorAll('style').forEach(node=>node.textContent=absoluteCss(node.textContent,base));
    shadow.append(style,container);button.replaceChildren(miniature,label);
  });refreshNavigation();
}
function absoluteResource(value,base){try{return /^(?:data:|#)/i.test(value)?value:new URL(value,base).href;}catch{return value;}}
function absoluteCss(css,base){return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_,quote,value)=>`url("${absoluteResource(value,base).replaceAll('"','%22')}")`);}
document.addEventListener('lab-preview',()=>{
  navigationWindow?.removeEventListener('scroll',refreshNavigation);navigationWindow=$('preview').contentWindow;
  navigationWindow.addEventListener('scroll',refreshNavigation,{passive:true});
  // Key events inside a same-origin iframe do not bubble to its parent document.
  navigationWindow.document.onkeydown=workbenchPreviewKey;
});
function workbenchPreviewKey(event){
  if(event.key==='F5'){event.preventDefault();startPresentation();return;}
  if(['PageUp','PageDown'].includes(event.key)&&!event.target.closest?.('textarea,input,select,[contenteditable="true"]')){event.preventDefault();jumpSlide(activeSlide+(event.key==='PageDown'?1:-1));}
}
// Presentation keeps one document alive and switches only the visible slide.
async function startPresentation(){
  if(!current||!lastHTML||presentationOpening||!$('presentation').hidden)return;presentationOpening=true;
  try{
  await presentationExit;
  // An invalid draft must not silently present the last successful rendering.
  clearTimeout(timer);if(!await render())return;
  const overlay=$('presentation'),frame=$('presentation-preview');presentationSlide=activeSlide;
  const html=new DOMParser().parseFromString(lastHTML,'text/html');html.querySelectorAll('script').forEach(node=>node.remove());
  const style=html.createElement('style');style.textContent='html,body{background:#080d16;overflow:hidden;height:100%}.marpit{padding:0!important;gap:0;display:flex;align-items:center;justify-content:center;width:100vw!important;height:100vh}.marpit>svg{display:none!important;box-shadow:none}.marpit>svg.present-active{display:block!important;width:min(100vw,calc(100vh * var(--slide-ratio)));height:auto;max-height:100vh}';html.head.append(style);
  const first=html.querySelector('.marpit>svg'),box=first?.getAttribute('viewBox')?.split(/\s+/).map(Number);html.documentElement.style.setProperty('--slide-ratio',box?box[2]/box[3]:16/9);
  // Reveal only after load so immediate keyboard input always reaches the new slide document.
  await new Promise(resolve=>{frame.onload=()=>{frame.contentDocument.onkeydown=presentationKey;showPresentationSlide(presentationSlide);resolve();};frame.srcdoc='<!doctype html>'+html.documentElement.outerHTML;});
  overlay.hidden=false;frame.contentWindow.focus();
  try{await overlay.requestFullscreen?.();}catch{/* The overlay still fills the workbench when fullscreen is unavailable. */}
  }catch(error){status(error.message,true);}finally{presentationOpening=false;}
}
function showPresentationSlide(index){
  const slides=[...(slideContainer($('presentation-preview').contentDocument)?.children||[])];if(!slides.length)return;
  presentationSlide=Math.max(0,Math.min(slides.length-1,index));slides.forEach((slide,i)=>slide.classList.toggle('present-active',i===presentationSlide));$('presentation-count').textContent=`第 ${presentationSlide+1} / ${slides.length} 頁`;
}
function closePresentation(){
  if($('presentation').hidden)return;$('presentation').hidden=true;
  if(document.fullscreenElement)presentationExit=document.exitFullscreen().catch(()=>{});
  jumpSlide(presentationSlide);$('present').focus();
  // Native fullscreen exit can restore focus into the now-hidden iframe; reclaim it afterward.
  presentationExit.finally(()=>{if($('presentation').hidden)requestAnimationFrame(()=>$('present').focus());});
}
function presentationKey(event){
  if($('presentation').hidden){workbenchPreviewKey(event);return;}
  if(event.key==='Escape'){event.preventDefault();closePresentation();}
  else if(['ArrowRight',' ','PageDown','ArrowLeft','PageUp'].includes(event.key)){event.preventDefault();showPresentationSlide(presentationSlide+(['ArrowLeft','PageUp'].includes(event.key)?-1:1));}
}
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&!$('presentation').hidden)closePresentation();});
document.addEventListener('keydown',event=>{if(!$('presentation').hidden)presentationKey(event);else workbenchPreviewKey(event);});
document.addEventListener('DOMContentLoaded',()=>{
  $('previous-slide').onclick=()=>jumpSlide(activeSlide-1);$('next-slide').onclick=()=>jumpSlide(activeSlide+1);
  $('toggle-thumbnails').onclick=()=>{const show=$('thumbnails').hidden;$('thumbnails').hidden=!show;$('toggle-thumbnails').setAttribute('aria-pressed',String(show));localStorage.setItem('lab-thumbnails',String(show));drawThumbnails();};
  if(localStorage.getItem('lab-thumbnails')==='true'){$('thumbnails').hidden=false;$('toggle-thumbnails').setAttribute('aria-pressed','true');}
  $('present').onclick=startPresentation;$('presentation-close').onclick=closePresentation;$('presentation-previous').onclick=()=>showPresentationSlide(presentationSlide-1);$('presentation-next').onclick=()=>showPresentationSlide(presentationSlide+1);
});
