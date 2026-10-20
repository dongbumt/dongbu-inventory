// Execute the actual Edge handler with in-memory SMTP/FTP/SQL fixtures. Never sends a real message.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/send-document-request/index.ts'),'utf8').replace(/^import .*;\r?\n/gm,'');
let handler,authorized=true,fail=false,envelope,uploaded,logRows=[];
const settings={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-only',DAUM_SMTP_USER:'fixture',DAUM_SMTP_APP_PASSWORD:'fixture',DAUM_SMTP_FROM:'sender@example.invalid',BAROBILL_CERT_KEY:'fixture',BAROBILL_CORP_NUM:'1234567890',BAROBILL_SENDER_ID:'fixture',BAROBILL_MEMBER_PASSWORD:'fixture',BAROBILL_FROM_NUMBER:'0212345678'};
const sender={profileId:'dongbumt',secretAlias:'dongbumt',isDefault:true,name:'가상 법인',displayName:'가상 발신처',email:'reply@example.invalid',fax:'02-1111-2222',businessRegistrationNo:''};
const db={rpc:async()=>({data:authorized,error:null}),from:name=>({insert:async values=>{assert.equal(name,'document_request_logs');logRows.push(structuredClone(values));return {error:null}}})};
const sandbox={Deno:{env:{get:key=>settings[key]||''},serve:fn=>handler=fn},createClient:()=>db,
 nodemailer:{createTransport:()=>({sendMail:async args=>{envelope=args;if(fail)throw Error('fixture delivery failure');return {messageId:'fixture-mail-id'}}})},
 Request,Response,TextEncoder,Uint8Array,crypto:global.crypto,console,Date,URL,fetch:()=>{throw Error('Network use forbidden')},sender};
vm.createContext(sandbox);vm.runInContext(stripTypeScriptTypes(source),sandbox);
vm.runInContext('getRequestSenderProfile=async()=>({...sender});uploadBarobillFile=async(name,html)=>{globalThis.uploadedBody=html};barobillSoap=async()=>"fixture-fax-id";',sandbox);
async function send(channel){const result=await handler(new Request('https://fixture.invalid/send-document-request',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost'},body:JSON.stringify({action:'send',erpSessionToken:'fixture-token',channel,trader:'가상 거래처 <A>',recipient:channel==='email'?'recipient@example.invalid':'0212345678',documents:[{date:'2026-10-20',product:'가상 <제품>',brand:'가상 <브랜드>',origin:'국내산',lot:'001-LOT',requiredDoc:'등급판정서'}]})}));return {status:result.status,data:await result.json()};}
(async()=>{
 assert.equal((await send('email')).status,200);
 let stored=logRows.at(-1);assert.equal(stored.status,'sent');assert.equal(stored.content_snapshot.html,envelope.html);assert.equal(stored.content_snapshot.text,envelope.text);assert.equal(stored.subject,envelope.subject);
 assert(stored.content_snapshot.html.includes('&lt;제품&gt;'));assert.equal(stored.content_snapshot.sender.from,settings.DAUM_SMTP_FROM);
 assert(stored.content_snapshot.html.includes('&lt;브랜드&gt;'));assert.equal(stored.documents[0].brand,'가상 <브랜드>');
 assert.equal((stored.content_snapshot.html.match(/주식회사 동부엠티/g)||[]).length,1,'Show the sender name once in the message');
 assert(!stored.content_snapshot.html.includes('법인 :'));assert(!stored.content_snapshot.text.includes('법인명:'));
 assert(envelope.from.includes('주식회사 동부엠티'));assert(stored.content_snapshot.text.includes('브랜드: 가상 <브랜드>'));
 assert.equal(vm.runInContext('normalizeDocuments([{product:"legacy"}])[0].brand',sandbox),'','Old clients may omit the brand');
 const original=stored.content_snapshot.html;sender.displayName='변경된 발신처';assert.equal(stored.content_snapshot.html,original);
 sender.profileId='dongbu_distribution';
 assert.equal((await send('fax')).status,200);stored=logRows.at(-1);uploaded=sandbox.uploadedBody;
 assert.equal(stored.status,'accepted');assert.equal(stored.content_snapshot.html,uploaded);assert.equal(stored.content_snapshot.sender.from,'0212345678');
 assert.equal((uploaded.match(/\(주\)동부축산유통/g)||[]).length,1);assert(!uploaded.includes('<strong>법인</strong>'));assert(uploaded.includes('&lt;브랜드&gt;'));
 fail=true;assert.equal((await send('email')).status,502);stored=logRows.at(-1);assert.equal(stored.status,'failed');assert.equal(stored.content_snapshot.html,envelope.html);
 authorized=false;const count=logRows.length;assert.equal((await send('email')).status,401);assert.equal(logRows.length,count);
 const index=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const helper=index.match(/function documentRequestBrand\([^]*?\n\}/)[0];
 const form=vm.createContext({labelProducts:[{id:'p',brand:'등록 브랜드'}]});vm.runInContext(helper,form);
 assert.equal(vm.runInContext('documentRequestBrand({brand:"입고 당시 브랜드",labelProductId:"p"})',form),'입고 당시 브랜드');
 assert.equal(vm.runInContext('documentRequestBrand({labelProductId:"p"})',form),'등록 브랜드');
 assert.equal(vm.runInContext('documentRequestBrand({product:"동일 이름"})',form),'','Never guess a brand from a non-unique product name');
 console.log('PASS: exact sent snapshots; brand normalization/escaping; historical/master brand source; sender names once; both profiles; legacy clients; failed/denied sends; providers mocked');
})().catch(e=>{console.error(e);process.exitCode=1});
