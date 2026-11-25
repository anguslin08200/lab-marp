// Attach draft offsets to rendered blocks; theme substitution changes only the YAML prefix.
function sourceSelection(marp, text, source) {
  const offsets=[0];for(const match of text.matchAll(/\n/g))offsets.push(match.index+1);
  const clean=text.replace(/^\uFEFF/,''),header=clean.match(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const body=clean.slice(header?.[0].length||0);
  // Use the unchanged body suffix, including extra blank lines inserted by theme formatting.
  const lineCount=value=>(value.match(/\n/g)||[]).length;
  const shift=source===text?0:lineCount(source.slice(0,source.length-body.length))-lineCount(header?.[0]||'');
  const blocks=[];
  function attach(token,startLine,endLine,start,end){
    startLine-=shift;endLine-=shift;
    if(startLine<0||startLine>=offsets.length)return;
    const from=start??offsets[startLine],to=end??(offsets[endLine]??text.length);
    if(to<=from)return;
    const id=String(blocks.length);token.attrSet('data-lab-source',id);
    blocks.push({id,start:from,end:to,line:startLine});
  }
  // Custom math renderers ignore token attributes; add them to the existing outer tag.
  // Keeping the original element avoids changing scoped slide CSS or slide geometry.
  for(const type of ['marp_math_block','fence','code_block']){
    const render=marp.markdown.renderer.rules[type];if(!render)continue;
    marp.markdown.renderer.rules[type]=(tokens,index,...args)=>{
      const html=render(tokens,index,...args),id=tokens[index].attrGet('data-lab-source');
      return id===null?html:html.replace(/^(\s*<[a-z][\w:-]*)\b/i,`$1 data-lab-source="${id}"`);
    };
  }
  marp.markdown.core.ruler.push('lab_selection_source',state=>{
    if(state.inlineMode)return;blocks.length=0;
    let row=null,cursor=0;
    state.tokens.forEach((token,index)=>{
      if(token.type==='tr_open'){row=token.map;cursor=0;}
      if(token.type==='tr_close')row=null;
      // Cells lack Markdown-it line maps. Match their inline source within the mapped row.
      if(['td_open','th_open'].includes(token.type)&&row){
        const line=row[0]-shift,base=offsets[line];
        if(base===undefined)return;
        const raw=text.slice(base,offsets[line+1]??text.length),inline=state.tokens[index+1];
        const content=inline?.type==='inline'?inline.content:'';
        const found=content?raw.indexOf(content,cursor):-1;
        if(found>=0){attach(token,row[0],row[1],base+found,base+found+content.length);cursor=found+content.length;}
        return;
      }
      if(!token.map||token.hidden)return;
      if(!['heading_open','paragraph_open','list_item_open','tr_open','marp_math_block','fence','code_block'].includes(token.type))return;
      // A parent list item's map includes nested children; map its own text separately.
      const map=token.type==='list_item_open'&&state.tokens[index+1]?.map?state.tokens[index+1].map:token.map;
      attach(token,map[0],map[1]);
    });
  });
  return blocks;
}
module.exports={sourceSelection};
