'use strict';

window.DBMT_COLD_STORAGE_STANDALONE = true;

const COLD_STORAGE_PUBLIC_ACCESS_KEY = 'dbmt_cold_storage_public_access';
let coldStoragePublicAccessRequired = false;

const SUPABASE_URL = 'https://hdwjwtmbsxfjrlvicgnn.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_40Sg1P9a5KKA-2pXtzXJZA_qSXDqPZg';
var traderInfoMap = {};
var APP_DATA_REGISTRY = {};
var APP_DATA_LABELS = {};
var DATA_CHANGE_MENU_BY_APP_KEY = {};
var DATA_CHANGE_MENU_ORDER = [];

function localDateString(date=new Date()){
  const year = date.getFullYear();
  const month = String(date.getMonth()+1).padStart(2,'0');
  const day = String(date.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
}

function htmlEscape(value){
  return String(value ?? '').replace(/[&<>"']/g,char=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[char]);
}

function jsArg(value){
  return htmlEscape(JSON.stringify(String(value ?? '')).replace(/</g,'\\u003c'));
}

function safeLocalStorageSet(key,value){
  try{ localStorage.setItem(key,value);return true; }
  catch(err){ console.warn('로컬 임시 저장 실패:',err);return false; }
}

function getTraderInfo(name){
  return traderInfoMap?.[name] || {};
}

function getSupabasePassword(){ return ''; }
function recordDataChange(){ return null; }
function resetDataChangeAppDataBaseline(){}
function gsSaveAppDataKeys(){}
function cacheAppDataValue(){}

function toast(message){
  const box = document.getElementById('csr-public-toast');
  if(!box) return;
  box.textContent = String(message || '');
  box.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=>box.classList.remove('show'),3200);
}

async function sbFunctionRequest(functionName,payload){
  const requestPayload = {...(payload || {})};
  if(String(requestPayload.action || '').startsWith('cold_storage_public_')){
    requestPayload.publicAccessKey = sessionStorage.getItem(COLD_STORAGE_PUBLIC_ACCESS_KEY) || '';
  }
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_PUBLISHABLE_KEY,
      Authorization:`Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(requestPayload)
  });
  const text = await response.text();
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }
  catch(err){ data = {error:text}; }
  if(response.status === 401){
    coldStoragePublicAccessRequired = true;
    sessionStorage.removeItem(COLD_STORAGE_PUBLIC_ACCESS_KEY);
  }
  if(!response.ok){
    const error = new Error(data?.error || data?.message || `서버 요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function requestColdStoragePublicAccess(){
  if(!coldStoragePublicAccessRequired && !sessionStorage.getItem(COLD_STORAGE_PUBLIC_ACCESS_KEY)){
    location.reload();
    return true;
  }
  const entered = window.prompt('냉동창고 요청 접속코드를 입력하세요.');
  const value = String(entered || '').trim();
  if(!value) return false;
  sessionStorage.setItem(COLD_STORAGE_PUBLIC_ACCESS_KEY,value);
  location.reload();
  return true;
}
window.requestColdStoragePublicAccess = requestColdStoragePublicAccess;

window.addEventListener('DOMContentLoaded',async()=>{
  const connection = document.getElementById('csr-public-connection');
  try{
    await window.initColdStorageRequestPage();
    if(connection){ connection.textContent='서버 연결됨';connection.classList.add('connected'); }
  }catch(err){
    if(err?.status === 401){
      if(connection){ connection.textContent='접속코드 필요';connection.classList.add('failed'); }
      requestColdStoragePublicAccess();
      return;
    }
    if(connection){ connection.textContent='연결 실패';connection.classList.add('failed'); }
    toast(`서버 연결 실패: ${err?.message || err}`);
  }
});
