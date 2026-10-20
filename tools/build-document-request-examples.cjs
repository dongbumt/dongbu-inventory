// Render examples from the actual outgoing templates. This script never sends messages.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=path.join(root,'output','document-request-examples');
const source=fs.readFileSync(path.join(root,'supabase/functions/send-document-request/index.ts'),'utf8').replace(/^import .*;\r?\n/gm,'');
const sandbox={Deno:{serve:()=>{},env:{get:()=>''}},Date,console,crypto:global.crypto};
vm.createContext(sandbox);vm.runInContext(stripTypeScriptTypes(source),sandbox);
const rows=[{date:'2026-10-20',product:'소지',brand:'예시 브랜드 A',origin:'미국산',lot:'800000000001',requiredDoc:'수입신고필증'},
 {date:'2026-10-20',product:'삼겹살',brand:'예시 브랜드 B',origin:'국내산',lot:'L126000000001',requiredDoc:'등급판정서'}];
const senders=[{profileId:'dongbumt',name:'주식회사동부엠티',displayName:'동부엠티',email:'dongbumt1812@hanmail.net',fax:'032-232-1812',file:'동부엠티'},
 {profileId:'dongbu_distribution',name:'(주)동부축산유통',displayName:'동부축산유통',email:'',fax:'032-578-0108',file:'동부축산유통'}];
(async()=>{
 fs.mkdirSync(output,{recursive:true});const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:900,height:570}});await page.route('**/*',route=>route.abort());
  for(const sender of senders)for(const type of ['메일','팩스']){
   const body=(type==='메일'?sandbox.requestEmailHtml:sandbox.requestFaxHtml)(sender,'예시 거래처',rows);
   const file=path.join(output,`${type}_${sender.file}_예시.html`);fs.writeFileSync(file,body,'utf8');
   await page.setContent(body);assert.deepEqual(await page.locator('th').allTextContents(),['No.','품목명','브랜드','원산지','이력번호','필요서류']);
   const text=await page.locator('body').innerText(),name='주식회사 동부엠티 / (주)동부축산유통';
   assert.equal(text.split(name).length-1,1,'Only one sender name');assert(!text.includes('법인 :'));assert(!text.includes('법인\n'));
   assert(text.includes('예시 브랜드 A'));assert(text.includes('예시 브랜드 B'));assert(!text.includes('이메일()'));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:file.replace(/\.html$/,'.png'),fullPage:true});
   if(type==='메일'){await page.setViewportSize({width:480,height:760});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:900,height:570});}
   console.log(file);
  }
  console.log('PASS: both mail/fax profiles, brand order, single sender, no duplicate footer/legal row, no empty reply address, desktop/mobile containment; no delivery');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
