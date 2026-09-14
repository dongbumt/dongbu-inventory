// Offline regression tests: deferred RPCs use fictional data and never contact storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const names = ['gsSaveAppData','supabaseSaveAppDataKeys','saveSubMaterials','refreshSubMaterialStockSnapshot'];
const source = names.map(name=>{
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}).join('\n');
const clone = value=>JSON.parse(JSON.stringify(value));
const flush = ()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){
  let resolve, reject;
  const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function fixture(){
  const storage = new Map([['enabled','1']]);
  const saves = [], reads = [], notices = [], changeCalls = [], logs = [];
  const keys = ['subMaterialItems','subMaterialLots','subMaterialCounts'];
  const baseline = {};
  const server = {subMaterialItems:[],subMaterialLots:[],subMaterialCounts:[]};
  let deferReads = false;
  const ctx = vm.createContext({
    console:{error(){},warn(){}}, SUPABASE_ENABLED_KEY:'enabled',
    localStorage:{getItem:key=>storage.get(key) ?? null,setItem:(key,value)=>storage.set(key,value)},
    subMaterialItems:[],subMaterialLots:[],subMaterialCounts:[],
    APP_DATA_REGISTRY:{},asArray:value=>Array.isArray(value) ? value : [value],
    requireSupabasePassword:()=> 'fictional-token',DBMTAuth:{getSessionToken:()=> 'fictional-token'},
    gsShowSync:message=>notices.push(message),syncDataChangeLogsSoon(){},
    recordAppDataChanges(){
      const changed = keys.filter(key=>JSON.stringify(ctx[key]) !== baseline[key]);
      changed.forEach(key=>{baseline[key]=JSON.stringify(ctx[key]);logs.push(key);});
      changeCalls.push(changed);
      return changed;
    },
    async sbRpc(name,args){
      if(name === 'dbmt_erp_save_app_data'){
        const call = {payload:clone(args.p_payload),...deferred()};
        saves.push(call);
        await call.promise;
        if(call.response) return call.response;
        Object.assign(server,call.payload);
        return {ok:true};
      }
      assert.equal(name,'dbmt_erp_get_submaterial_stock');
      const call = {result:{ok:true,items:clone(server.subMaterialItems),lots:clone(server.subMaterialLots),counts:clone(server.subMaterialCounts)},...deferred()};
      reads.push(call);
      if(deferReads) await call.promise;
      return call.result;
    }
  });
  keys.forEach(key=>{
    baseline[key]=JSON.stringify(ctx[key]);
    ctx.APP_DATA_REGISTRY[key]={get:()=>ctx[key]};
  });
  const declarations = ['subMaterialPendingSavePromise','subMaterialPendingSaveKeys'].map(name=>{
    const match = html.match(new RegExp(`(?:let|const) ${name} = [^\\n]+;`));
    assert.ok(match,`missing state ${name}`);
    return match[0];
  }).join('\n');
  vm.runInContext(`${declarations}\n${source}\nfunction pendingKeys(){return [...subMaterialPendingSaveKeys];}`,ctx);
  return {ctx,saves,reads,notices,changeCalls,logs,server,storage,setDeferReads(value){deferReads=value;}};
}

async function main(){
  const unhandled = [];
  const onUnhandled = error=>unhandled.push(error);
  process.on('unhandledRejection',onUnhandled);
  try{
    // Two changes must be serialized, and a read must wait for the newer save too.
    {
      const f = fixture(), {ctx,saves,reads} = f;
      ctx.subMaterialItems=[{id:'item',certRequired:true,certDate:'2026-09-14'}];
      const first = ctx.saveSubMaterials();
      const read = ctx.refreshSubMaterialStockSnapshot();
      assert.equal(f.changeCalls.length,1,'change metadata is recorded synchronously');
      assert.match(f.storage.get('dbmt_submaterial_items'),/2026-09-14/,'local backup is immediate');
      await flush();
      assert.equal(saves.length,1);
      assert.equal(reads.length,0,'read waits for pending item save');
      ctx.subMaterialLots=[{id:'lot',qty:30}];
      const second = ctx.saveSubMaterials();
      await flush();
      assert.equal(saves.length,1,'a second save cannot overtake the first');
      saves[0].resolve();
      await flush();
      assert.equal(saves.length,2);
      assert.equal(reads.length,0,'read also waits for a save added while it was waiting');
      saves[1].resolve();
      await Promise.all([first,second]);
      const result = await read;
      assert.equal(result.items[0].certDate,'2026-09-14');
      assert.equal(result.lots[0].qty,30);
      assert.deepEqual(f.logs,['subMaterialItems','subMaterialLots'],'queuing does not duplicate change logs');
      assert.equal(f.changeCalls.length,2,'explicit changed keys preserve the original metadata flow');
      assert.equal(ctx.pendingKeys().length,0);
    }
    // An ignored save rejection stays observable to reads and retains keys for an unchanged retry.
    {
      const {ctx,saves,reads,notices} = fixture();
      ctx.subMaterialItems=[{id:'item',certDate:'2026-09-14'}];
      ctx.saveSubMaterials();
      await flush();
      saves[0].reject(new Error('fictional save failure'));
      await flush();
      await assert.rejects(ctx.refreshSubMaterialStockSnapshot(),/fictional save failure/);
      assert.equal(reads.length,0,'failed local changes cannot be replaced by a server snapshot');
      assert.equal(ctx.subMaterialItems[0].certDate,'2026-09-14');
      assert.ok(notices.some(message=>/저장 실패/.test(message)),'existing save error remains visible');
      const retry = ctx.saveSubMaterials();
      await flush();
      assert.equal(saves.length,2,'retry includes failed keys even if the local value has not changed');
      assert.equal(saves[1].payload.subMaterialItems[0].certDate,'2026-09-14');
      saves[1].resolve();
      await retry;
      assert.equal((await ctx.refreshSubMaterialStockSnapshot()).items[0].certDate,'2026-09-14');
    }
    // An already queued newer save can recover the failed earlier save before a waiting read.
    {
      const {ctx,saves,reads} = fixture();
      ctx.subMaterialItems=[{id:'item',certDate:'2026-09-13'}];
      ctx.saveSubMaterials();
      const read = ctx.refreshSubMaterialStockSnapshot();
      await flush();
      ctx.subMaterialItems[0].certDate='2026-09-14';
      const newer = ctx.saveSubMaterials();
      saves[0].reject(new Error('first attempt failed'));
      await flush();
      assert.equal(saves.length,2);
      assert.equal(reads.length,0);
      saves[1].resolve();
      await newer;
      assert.equal((await read).items[0].certDate,'2026-09-14');
    }
    // A JSON denial is a failed save even when the HTTP/RPC promise resolves normally.
    {
      const {ctx,saves,reads} = fixture();
      ctx.subMaterialItems=[{id:'item',certDate:'2026-09-14'}];
      ctx.saveSubMaterials();
      await flush();
      saves[0].response={ok:false,message:'fictional permission denial'};
      saves[0].resolve();
      await flush();
      await assert.rejects(ctx.refreshSubMaterialStockSnapshot(),/fictional permission denial/);
      assert.equal(reads.length,0);
      assert.equal(ctx.pendingKeys().length,1);
    }
    // Changes made during the GET invalidate its result and require a new read after saving.
    {
      const f = fixture(), {ctx,saves,reads} = f;
      f.setDeferReads(true);
      const read = ctx.refreshSubMaterialStockSnapshot();
      await flush();
      assert.equal(reads.length,1);
      ctx.subMaterialItems=[{id:'item',certDate:'2026-09-14'}];
      const save = ctx.saveSubMaterials();
      await flush();
      reads[0].resolve();
      await flush();
      assert.equal(reads.length,1,'stale GET is discarded while the new save is pending');
      saves[0].resolve();
      await save;
      await flush();
      assert.equal(reads.length,2);
      reads[1].resolve();
      assert.equal((await read).items[0].certDate,'2026-09-14');
    }
    // Offline changes also block replacement; reconnect plus the same save retries retained keys.
    {
      const {ctx,storage,saves,reads} = fixture();
      storage.set('enabled','0');
      ctx.subMaterialLots=[{id:'lot',qty:70}];
      ctx.saveSubMaterials();
      await flush();
      await assert.rejects(ctx.refreshSubMaterialStockSnapshot(),/서버에 저장되지/);
      assert.equal(reads.length,0);
      storage.set('enabled','1');
      const retry = ctx.saveSubMaterials();
      await flush();
      saves[0].resolve();
      await retry;
      assert.equal((await ctx.refreshSubMaterialStockSnapshot()).lots[0].qty,70);
    }
    // Existing callers may keep ignoring gsSaveAppData's returned promise without unhandled errors.
    {
      const {ctx,saves,notices} = fixture();
      ctx.subMaterialItems=[{id:'item'}];
      ctx.gsSaveAppData();
      saves[0].reject(new Error('fictional common save failure'));
      await flush();
      assert.ok(notices.some(message=>/저장 실패/.test(message)));
    }
    await flush();
    assert.deepEqual(unhandled,[],'ignored legacy callers must not cause unhandled promise rejections');
    console.log('PASS submaterial save queue: serial saves, delayed reads, failure, retry, stale GET, offline and ignored promises');
  } finally {
    process.removeListener('unhandledRejection',onUnhandled);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
