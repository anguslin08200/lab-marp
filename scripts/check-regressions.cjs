// Adapt legacy checks' fixed URLs in memory, keeping the user's running server untouched.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
if(process.argv[2]){
  require('./check-browser-support.cjs');
  // The legacy chat layout check assumes a logged-in CLI catalog; supply metadata only.
  // Its own mocked transport still verifies effort submission without any inference use.
  if(process.argv[2]==='check-chat-controls.cjs'){
    const puppeteer=require('puppeteer-core'),launch=puppeteer.launch.bind(puppeteer);
    puppeteer.launch=async options=>{
      const browser=await launch(options),newPage=browser.newPage.bind(browser);
      browser.newPage=async()=>{const page=await newPage();await page.evaluateOnNewDocument(()=>{
        const originalFetch=window.fetch.bind(window);
        window.fetch=(input,init)=>{
          const pathname=new URL(typeof input==='string'?input:input.url,location.href).pathname;
          if(pathname==='/api/codex/status')return Promise.resolve(new Response(JSON.stringify({available:true,loggedIn:true,accountType:'chatgpt'}),{headers:{'Content-Type':'application/json'}}));
          if(pathname==='/api/codex/models')return Promise.resolve(new Response(JSON.stringify({models:[{id:'fixture',name:'Fixture',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],defaultModel:'fixture',defaultEffort:'low'}),{headers:{'Content-Type':'application/json'}}));
          return originalFetch(input,init);
        };
      });return page;};return browser;
    };
  }
  const file=path.resolve(__dirname,process.argv[2]);
  const source=fs.readFileSync(file,'utf8').replaceAll('127.0.0.1:8766',`127.0.0.1:${process.env.LAB_SLIDES_PORT||8771}`).replaceAll('127.0.0.1:8767',`127.0.0.1:${process.env.LAB_SLIDES_PORT||8771}`);
  module.filename=file;module.paths=require('node:module')._nodeModulePaths(path.dirname(file));module._compile(source,file);
}else{
  for(const name of ['check-workbench.cjs','check-scroll-sync.cjs','check-selection-sync.cjs','check-recent-documents.cjs','check-chat-controls.cjs','check-open-path.cjs']){
    console.log(`Running ${name}`);
    const result=spawnSync(process.execPath,[__filename,name],{stdio:'inherit',windowsHide:true,env:process.env});
    if(result.status!==0){process.exitCode=1;break;}
  }
}
