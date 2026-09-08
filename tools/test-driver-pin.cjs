/* Driver PIN UI tests. RPCs are mocked; no production data is read or changed. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const driver = fs.readFileSync(path.join(root, 'driver-attendance.html'), 'utf8');
for (const [name, html] of [['index.html',index],['driver-attendance.html',driver]]) {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1], {filename:name});
}
const accountFunctions = index.slice(index.indexOf('function resetDriverAccountForm(){'), index.indexOf('async function setDriverAccountActive('));
const formStart = index.indexOf('<input type="hidden" id="da-account-edit-employee-id">');
const form = index.slice(formStart, index.indexOf('<div class="tbl-wrap"', formStart));
const loginStart = driver.indexOf('async function loginDriver(event){');
const loginFunction = driver.slice(loginStart, driver.indexOf('async function logoutDriver()', loginStart));

(async () => {
  const executablePath = process.env.CHROME_PATH || [chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => fs.existsSync(p));
  const browser = await chromium.launch({headless:true, executablePath});
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(form);
    await page.addScriptTag({content:`
      const employees = [{id:'qa-driver',name:'테스트 기사'}];
      const driverAdminData = {accounts:[]};
      window.requests = []; window.messages = [];
      function toast(message){messages.push(message);}
      function setDriverAdminStatus(){}
      function requireSupabasePassword(){return 'mock-erp-session';}
      async function sbRpc(name,args){requests.push({name,args});return {ok:true};}
      function recordDataChange(){}
      async function loadDriverAdminData(){}
      document.getElementById('da-account-employee').innerHTML += '<option value="qa-driver">테스트 기사</option>';
      ${accountFunctions}
    `});
    const field = page.locator('#da-account-password');
    assert.equal(await field.getAttribute('inputmode'), 'numeric');
    assert.equal(await field.getAttribute('maxlength'), '4');
    assert.equal(await field.getAttribute('type'), 'password');
    for (const existing of [false,true]) {
      for (const password of ['', '0123','0000','9876','123','12345','abcd','12a4',' 123','1234 ','１２３４','123\n']) {
        const result = await page.evaluate(async ({existing,password}) => {
          driverAdminData.accounts = existing ? [{employee_id:'qa-driver'}] : [];
          requests.length = 0; messages.length = 0;
          document.getElementById('da-account-employee').value = 'qa-driver';
          document.getElementById('da-account-login').value = 'qa-driver';
          // Assign directly to exercise validation even if maxlength is bypassed.
          document.getElementById('da-account-password').value = password;
          await saveDriverAccount();
          return {requests,messages};
        }, {existing,password});
        const valid = /^[0-9]{4}$/.test(password) || (existing && password === '');
        assert.equal(result.requests.length, valid ? 1 : 0, `existing=${existing}, password length=${password.length}`);
        if (valid) {
          assert.equal(result.requests[0].name, 'dbmt_erp_driver_admin_save_account');
          assert.equal(result.requests[0].args.p_login_password, password || null);
        } else assert.equal(result.messages[0], '비밀번호는 숫자 4자리로 입력해주세요.');
      }
    }
    // Use the actual driver login field and submit function, keeping legacy input unrestricted.
    const login = await browser.newPage();
    await login.route('**/*', route => route.abort());
    const passwordInput = driver.match(/<input id="login-password"[^>]*>/)[0];
    await login.setContent(`<input id="login-id" value="qa-driver">${passwordInput}<button id="login-btn">로그인</button>`);
    await login.addScriptTag({content:`
      window.requests = [];
      function setMessage(){}
      async function rpc(name,args){requests.push({name,args});return {ok:false,message:'mock rejection'};}
      ${loginFunction}
    `});
    assert.equal(await login.locator('#login-password').getAttribute('inputmode'), 'numeric');
    assert.equal(await login.locator('#login-password').getAttribute('maxlength'), null);
    assert.equal(await login.locator('#login-password').getAttribute('pattern'), null);
    for (const password of ['0123','Legacy-password-123!']) {
      await login.locator('#login-password').fill(password);
      await login.evaluate(() => loginDriver({preventDefault(){}}));
      assert.equal(await login.evaluate(() => requests.at(-1).args.p_login_password), password);
    }
    const baseSql = fs.readFileSync(path.join(root,'supabase/schema-rpc-09b-driver-admin.sql'),'utf8');
    const upgradeSql = fs.readFileSync(path.join(root,'supabase/schema-rpc-35-driver-four-digit-pin.sql'),'utf8');
    const definition = sql => sql.slice(sql.indexOf('create or replace function public.dbmt_driver_admin_save_account(')).split('$dbmt$;')[0].replace(/\r/g,'');
    assert.equal(definition(baseSql), definition(upgradeSql), 'Fresh installs and upgrades must use identical validation');
    console.log('PASS: driver PIN create/edit validation, leading zeros, blank preservation, legacy login UI, SQL parity, inline JS syntax');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
