/* Read-only sent/attempted content viewer. Never calls a delivery endpoint. */
(function(global){
  'use strict';
  let request=0,returnFocus=null,session='';
  const dialog=document.createElement('dialog');dialog.id='document-request-detail';
  dialog.setAttribute('aria-labelledby','document-request-detail-title');
  dialog.innerHTML='<header><h3 id="document-request-detail-title">발송 내용</h3><button type="button" data-detail-close aria-label="닫기">×</button></header><div id="document-request-detail-body"></div><footer><button type="button" class="btn btn-secondary" data-detail-close>닫기</button></footer>';
  document.body.append(dialog);
  const body=document.getElementById('document-request-detail-body');
  const canView=()=>Boolean(global.DBMTAuth?.isPersonal()&&DBMTAuth.can('document_check','view'));
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function reset(){request++;body.replaceChildren();if(dialog.open)dialog.close();}
  function applyPermissions(){const token=global.DBMTAuth?.getSessionToken()||'';if(token!==session||!canView())reset();session=token;}
  function safeHtml(html){
    const doc=new DOMParser().parseFromString(String(html),'text/html');
    doc.querySelectorAll('script,iframe,object,embed,link,base,meta,form').forEach(node=>node.remove());
    for(const node of doc.querySelectorAll('*'))for(const attr of [...node.attributes]){
      if(/^on/i.test(attr.name)||['href','src','srcset','action','formaction'].includes(attr.name.toLowerCase()))node.removeAttribute(attr.name);
    }
    const csp=doc.createElement('meta');csp.httpEquiv='Content-Security-Policy';
    csp.content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'";
    doc.head.prepend(csp);
    return '<!doctype html>'+doc.documentElement.outerHTML;
  }
  function render(log){
    const content=log.content_snapshot&&typeof log.content_snapshot==='object'?log.content_snapshot:null;
    const rows=Array.isArray(log.documents)?log.documents:[];
    const sent=log.status==='sent'||log.status==='accepted';
    const meta=[['구분',log.channel==='fax'?'팩스':'메일'],['요청일시',formatDocumentRequestDate(log.created_at)],['거래처',log.trader],
      ['수신처',[log.recipient_name,log.recipient].filter(Boolean).join(' · ')],['상태',log.provider_status||(sent?'완료':'실패')],
      ['발신',content?.sender?[content.sender.displayName,content.sender.from].filter(Boolean).join(' · '):'이전 이력에 발신정보 미보관']];
    body.innerHTML=`<dl class="document-detail-meta">${meta.map(([key,value])=>`<div><dt>${escape(key)}</dt><dd>${escape(value||'-')}</dd></div>`).join('')}</dl>
      <div class="document-detail-subject"><strong>제목</strong><span>${escape(log.subject||'-')}</span></div>
      ${!sent?`<p class="document-detail-note">발송 실패 이력입니다. 아래는 발송을 시도한 내용입니다.${log.error_message?' '+escape(log.error_message):''}</p>`:''}
      ${content?.html?'<h4>발송 본문</h4><iframe id="document-request-body-frame" title="보낸 메일 또는 팩스 요청서" sandbox="" referrerpolicy="no-referrer"></iframe>':
        content?.text?`<h4>발송 본문</h4><pre class="document-detail-text">${escape(content.text)}</pre>`:
        '<p class="document-detail-note">이전 이력은 본문 원본을 보관하지 않아 저장된 제목과 요청서류 목록만 표시합니다.</p>'}
      <h4>요청서류 목록 (${rows.length}건)</h4><div class="document-detail-table-wrap"><table><thead><tr><th>입고일</th><th>품목명</th><th>브랜드</th><th>원산지</th><th>이력번호</th><th>필요서류</th></tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${[row.date,row.product,row.brand,row.origin,row.lot,row.requiredDoc].map(value=>`<td>${escape(value||'-')}</td>`).join('')}</tr>`).join(''):'<tr><td colspan="6">저장된 요청서류가 없습니다.</td></tr>'}</tbody></table></div>`;
    const frame=document.getElementById('document-request-body-frame');if(frame)frame.srcdoc=safeHtml(content.html);
  }
  async function open(id){
    if(!canView()){toast('발송 내용을 조회할 권한이 없습니다.');return;}
    if(!/^\d{1,19}$/.test(String(id)))return;
    const token=DBMTAuth.getSessionToken(),serial=++request;
    session=token;
    returnFocus=document.activeElement;body.textContent='발송 내용을 불러오는 중입니다…';
    if(!dialog.open)dialog.showModal();
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
    try{
      const result=await sbRpc('dbmt_erp_get_document_request_log_detail',{p_token:token,p_id:String(id)},{signal:controller.signal});
      if(serial!==request||token!==DBMTAuth.getSessionToken()||!canView()||!dialog.open)return;
      if(!result?.ok||!result.log)throw new Error(result?.message||'발송 내용을 불러오지 못했습니다.');
      render(result.log);
    }catch(error){if(serial===request&&dialog.open&&token===DBMTAuth.getSessionToken()&&canView())body.textContent=error.message||String(error);}
    finally{clearTimeout(timeout);}
  }
  dialog.querySelectorAll('[data-detail-close]').forEach(button=>button.addEventListener('click',reset));
  dialog.addEventListener('close',()=>{request++;body.replaceChildren();if(returnFocus?.isConnected)returnFocus.focus();});
  document.getElementById('doc-request-log-tbody').addEventListener('click',event=>{const button=event.target.closest('[data-doc-request-detail]');if(button)void open(button.dataset.docRequestDetail);});
  global.DBMTDocumentRequestDetail={open,reset,applyPermissions};
})(window);
