// Explicit test-only opt-in for restricted hosts; production browser sandboxing is unchanged.
if(process.env.LAB_TEST_NO_SANDBOX==='1'){
  const puppeteer=require('puppeteer-core'),launch=puppeteer.launch.bind(puppeteer);
  puppeteer.launch=options=>launch({...options,args:[...(options?.args||[]),'--no-sandbox']});
}
