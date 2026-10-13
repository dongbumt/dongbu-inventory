/* Account-form checks with fake DOM/RPCs only; no production accounts changed. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
const save = html.match(/async function saveMobileAdminAccount\([^]*?\n\}/)[0];
const fields = Object.fromEntries(['ma-account-id','ma-display-name','ma-login-id','ma-pin','ma-active'].map(id=>[id,{value:''}]));
const calls = [], messages = [];
const context = vm.createContext({document:{getElementById:id=>fields[id]},
  toast:message=>messages.push(message), requireSupabasePassword:()=> 'mock-session',
  sbRpc:async(name,args)=>{calls.push({name,args});return {ok:true};},
  recordDataChange(){}, resetMobileAdminAccountForm(){}, loadMobileAdminAccounts:async()=>{},
  setMobileAdminStatus:message=>messages.push(message)});
vm.runInContext(save, context);

(async()=>{
  for(const existing of [false,true]){
    for(const loginId of ['pjy','ABC','admin','legacy.user_01-x','a'.repeat(30),'ab','','a'.repeat(31),'관리자','a b','abc@']){
      calls.length=0;messages.length=0;
      Object.assign(fields['ma-account-id'],{value:existing?'qa-account':''});
      fields['ma-display-name'].value='가상 관리자';fields['ma-login-id'].value=loginId;
      fields['ma-pin'].value=existing?'':'0123';fields['ma-active'].value='1';
      await context.saveMobileAdminAccount();
      const valid=/^[A-Za-z0-9._-]{3,30}$/.test(loginId);
      assert.equal(calls.length,valid?1:0,`existing=${existing}, ID=${loginId}`);
      if(valid){
        assert.equal(calls[0].name,'dbmt_erp_mobile_admin_save_account');
        assert.equal(calls[0].args.p_login_id,loginId);
        assert.equal(calls[0].args.p_pin,existing?null:'0123');
      }else assert.match(messages[0],/3~30자/);
    }
  }
  for(const pin of ['123','12345','abcd','12a4']){
    calls.length=0;fields['ma-account-id'].value='';fields['ma-login-id'].value='pjy';fields['ma-pin'].value=pin;
    await context.saveMobileAdminAccount();assert.equal(calls.length,0,'Four-digit PIN validation is unchanged');
  }
  calls.length=0;fields['ma-login-id'].value=' pjy ';fields['ma-pin'].value='0123';
  await context.saveMobileAdminAccount();assert.equal(calls[0].args.p_login_id,'pjy');
  const base=fs.readFileSync(path.join(root,'supabase/schema-rpc-17c-mobile-admin-accounts.sql'),'utf8');
  const upgrade=fs.readFileSync(path.join(root,'supabase/migrations/20261013012204_mobile_admin_short_login_id.sql'),'utf8');
  const body=sql=>sql.match(/create or replace function public\.dbmt_mobile_admin_save_account\([^]*?\$dbmt\$;/)[0].replace(/\r/g,'');
  assert.equal(body(base),body(upgrade),'New installs and upgrades use the same server validation');
  assert.match(body(upgrade),/\{3,30\}/);
  assert.match(body(upgrade),/dbmt_check_password\(p_password\)/);
  console.log('PASS: three-letter IDs, legacy IDs, length/character rejection, trimming, new/edit PIN preservation, server migration parity and inline syntax.');
})().catch(error=>{console.error(error);process.exitCode=1;});
