(function(root){
  'use strict';
  let offset=0,total=0,loadEpoch=0,viewEpoch=0,selected=null,selectedToken='',queryKey='';
  const el=id=>document.getElementById(id);
  function token(){
    if(!root.DBMTAuth?.isPersonal()||!root.DBMTAuth.can('driver_attendance','view'))throw new Error('배송기사근태 조회 권한이 없습니다.');
    return root.DBMTAuth.getSessionToken();
  }
  const filters=()=>({from:el('dt-from').value,to:el('dt-to').value,search:el('dt-search').value.trim()});
  function status(text){el('dt-status').textContent=text;}
  function close(){viewEpoch++;selected=null;selectedToken='';el('dt-view-modal').classList.add('hidden');el('dt-view-image').removeAttribute('src');el('dt-view-print').disabled=true;}
  function pending(){loadEpoch++;queryKey='';close();el('dt-body').replaceChildren();status('조건을 변경했습니다. 조회 버튼을 눌러주세요.');el('dt-prev').disabled=true;el('dt-next').disabled=true;}
  async function load(start=0){
    const version=++loadEpoch,f=filters();el('dt-prev').disabled=true;el('dt-next').disabled=true;status('온도기록지를 불러오는 중입니다...');
    try{
      const auth=token();
      if(!f.from||!f.to||f.to<f.from)throw new Error('조회할 기록일 범위를 확인해주세요.');
      const result=await root.sbRpc('dbmt_temperature_record_list',{p_token:auth,p_client:'erp',p_from:f.from,p_to:f.to,p_offset:start,p_search:f.search});
      if(version!==loadEpoch||auth!==token())return;
      offset=start;total=result.total||0;queryKey=JSON.stringify(f);const body=el('dt-body');body.replaceChildren();
      for(const row of result.rows||[]){
        const tr=document.createElement('tr');
        [row.record_date,row.employee_name,row.vehicle_no,new Date(row.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}),row.note||'-'].forEach(text=>{const td=document.createElement('td');td.textContent=text;tr.append(td);});
        const td=document.createElement('td'),button=document.createElement('button');button.className='btn btn-secondary btn-sm';button.textContent='보기 / 출력';button.onclick=()=>root.openDriverTemperatureRecord(row.id);td.append(button);tr.append(td);body.append(tr);
      }
      if(!body.children.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.textContent='해당 기간에 전송된 온도기록지가 없습니다.';tr.append(td);body.append(tr);}
      status(`${f.from} ~ ${f.to} · 총 ${total}건${total?' · '+(offset+1)+' ~ '+Math.min(offset+50,total)+'건 표시':''}`);
      el('dt-prev').disabled=offset===0;el('dt-next').disabled=offset+50>=total;
    }catch(error){if(version===loadEpoch){queryKey='';el('dt-body').replaceChildren();status(error.message);}}
  }
  async function view(id){
    close();const version=viewEpoch;el('dt-view-modal').classList.remove('hidden');el('dt-view-info').textContent='기록지를 불러오는 중입니다...';
    try{
      const auth=token(),record=await root.sbRpc('dbmt_temperature_record_image',{p_token:auth,p_client:'erp',p_id:id});
      if(version!==viewEpoch||auth!==token())return;
      if(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(record.image||''))throw new Error('기록지 이미지가 올바르지 않습니다.');
      const img=el('dt-view-image');img.src=record.image;await img.decode();
      if(version!==viewEpoch||auth!==token())return;
      selected=record;selectedToken=auth;el('dt-view-info').textContent=[record.record_date,record.employee_name,record.vehicle_no,record.note].filter(Boolean).join(' · ');el('dt-view-print').disabled=false;
    }catch(error){if(version===viewEpoch)el('dt-view-info').textContent=error.message;}
  }
  function print(){
    try{
      if(!selected||selectedToken!==token())throw new Error('기록지를 다시 조회한 뒤 출력해주세요.');
      if(!root.DBMTTemperatureRecord.openPrint(selected))throw new Error('브라우저의 팝업 차단을 해제해주세요.');
    }catch(error){root.toast(error.message);}
  }
  function init(){
    close();
    if(!el('dt-to').value)el('dt-to').value=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
    if(!el('dt-from').value){const date=new Date(el('dt-to').value+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-6);el('dt-from').value=date.toISOString().slice(0,10);}
    return load();
  }
  root.initDriverTemperatureOffice=init;root.loadDriverTemperatureRecords=()=>load();root.openDriverTemperatureRecord=view;
  root.closeDriverTemperatureRecord=close;root.printDriverTemperatureRecord=print;root.markDriverTemperaturePending=pending;
  root.shiftDriverTemperaturePage=direction=>{if(queryKey!==JSON.stringify(filters()))return pending();const next=offset+direction*50;if(next>=0&&next<total)load(next);};
})(window);
