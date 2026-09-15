/* Restore only webpage fullscreen that a label print interrupted.
 * Chromium exits document fullscreen before scripted printing. Re-entry can
 * require fresh user activation; failure must never fail/repeat a print job.
 * Browser fullscreen (F11) is separate and is not controlled by this module.
 */
(function(global){
  'use strict';
  const doc=global.document;
  let active=null,pending=null,timer=null,revision=0,requesting=false;
  function sync(){
    const button=doc.getElementById('fullscreen-btn');if(!button)return;
    button.textContent=doc.fullscreenElement?'전체화면 해제':pending?'전체화면 복귀':'전체화면';
    button.title=pending?'브라우저가 자동 복귀를 제한했습니다. 누르면 전체화면으로 돌아갑니다. 인쇄 중에도 유지하려면 F11을 사용하세요.':'인쇄 중에도 유지되는 브라우저 전체화면은 F11로 사용할 수 있습니다.';
    button.setAttribute('aria-pressed',String(!!doc.fullscreenElement));
    button.dataset.restorePending=String(!!pending);
  }
  function cancel(){
    revision++;global.clearTimeout(timer);timer=null;pending=null;
    if(active)active.cancelled=true;
    sync();
  }
  async function restore(){
    timer=null;
    const target=pending,stamp=revision;
    if(!target||active||requesting||!target.isConnected||doc.fullscreenElement)return;
    requesting=true;
    try{
      await target.requestFullscreen();
      if(stamp===revision)pending=null;
    }catch(e){/* Expected if the browser requires a new touch/click. */}
    finally{requesting=false;sync();}
  }
  function beforePrint(){
    global.clearTimeout(timer);timer=null;revision++;pending=null;
    active={target:doc.fullscreenElement,cancelled:false};sync();return active;
  }
  function afterPrint(session){
    if(active!==session)return;
    active=null;
    if(!session.cancelled&&session.target?.isConnected&&!doc.fullscreenElement){
      pending=session.target;
      // Let the browser release its native print UI before one recovery attempt.
      timer=global.setTimeout(restore,250);
    }
    sync();
  }
  async function toggle(){
    if(requesting)return;
    if(pending&&!doc.fullscreenElement&&!active){await restore();return;}
    cancel();
    try{
      if(doc.fullscreenElement)await doc.exitFullscreen();
      else await doc.documentElement.requestFullscreen();
    }catch(e){
      if(typeof global.setStatus==='function')global.setStatus('전체화면은 키보드 F11로도 사용할 수 있습니다.','warn');
    }
    sync();
  }
  doc.addEventListener('fullscreenchange',()=>{
    if(doc.fullscreenElement){pending=null;global.clearTimeout(timer);timer=null;}
    sync();
  });
  doc.addEventListener('keydown',event=>{
    // Never fight an operator explicitly leaving fullscreen, including while
    // a slow print job is still open. Do not intercept the key itself.
    if(event.key==='Escape'||event.key==='F11')cancel();
  },true);
  global.DBMTLabelFullscreen={beforePrint,afterPrint,toggle,sync};
})(window);
