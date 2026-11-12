// Public release assets only. No logins, business writes or printing.
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),base='https://dongbumt.github.io/dongbu-inventory/',ref=process.env.DBMT_LEDGER_RELEASE_REF||'HEAD';
const files=['index.html','m02-auth.js','ledger-model.js','ledgers.js','styles/ledgers.css'];
const normalize=t=>t.replace(/\r\n/g,'\n');
const expected=Object.fromEntries(files.map(file=>[file,normalize(execFileSync('git',['show',ref+':'+file],{cwd:repo,encoding:'utf8',maxBuffer:12*1024*1024}))]));
const sha=execFileSync('git',['rev-parse',ref],{cwd:repo,encoding:'utf8'}).trim();
async function read(file){const url=new URL(file,base);url.searchParams.set('release-check',sha+'-'+Date.now());const res=await fetch(url,{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20000)});assert.equal(res.status,200,file+' HTTP status');return normalize(await res.text());}
(async()=>{
 let ready=false,last='';
 for(let attempt=0;attempt<30;attempt++){
  try{ready=await read('index.html')===expected['index.html'];if(ready)break;last='Previous release is still served';}catch(e){last=e.message;}
  if(attempt%6===0)console.log('Waiting for GitHub Pages: '+last);
  await new Promise(resolve=>setTimeout(resolve,10000));
 }
 assert(ready,'Deployment did not publish the expected index: '+last);
 for(const file of files){assert.equal(await read(file),expected[file],file+' differs from '+sha);console.log('PASS: deployed '+file+' matches '+sha);}
 console.log('PASS: both ledger menus, auth registry and current code/style cache versions are live');
})().catch(e=>{console.error(e);process.exitCode=1;});
