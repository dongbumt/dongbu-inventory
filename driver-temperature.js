(function(root){
  'use strict';
  let options,source=null,corners=null,cropped=null,pending=null,busy=false,epoch=0,session='',drag=-1,listEpoch=0,recognition=null;
  const el=id=>document.getElementById(id),api=()=>root.DBMTTemperatureRecord;
  const kstDay=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
  const message=(text,error=false)=>{el('temp-message').textContent=text;el('temp-message').className='message '+(error?'error':'');};
  function setBusy(value){
    busy=value;
    ['temp-camera-btn','temp-gallery-btn','temp-rotate-btn','temp-detect-btn','temp-crop-btn','temp-back-btn','temp-upload-btn'].forEach(id=>el(id).disabled=value);
    ['temp-date','temp-vehicle','temp-note'].forEach(id=>el(id).disabled=value||!!pending);
    el('temp-vehicle-retry-btn').disabled=value||!!pending;
  }
  function clearPhoto(){
    epoch++;recognition?.abort();recognition=null;source=null;corners=null;cropped=null;pending=null;drag=-1;
    ['temp-editor','temp-preview','temp-cancel-btn'].forEach(id=>el(id).classList.add('hidden'));
    el('temp-preview-image').removeAttribute('src');el('temp-canvas').width=1;el('temp-canvas').height=1;
    el('temp-camera-input').value='';el('temp-photo-input').value='';el('temp-note').value='';el('temp-vehicle').value='';el('temp-vehicle-status').textContent='';setBusy(false);
  }
  function reset(){clearPhoto();session='';listEpoch++;el('temp-history').textContent='로그인 후 확인할 수 있습니다.';el('temp-vehicle').value='';message('');}
  function draw(){
    if(!source)return;
    const canvas=el('temp-canvas'),maxWidth=Math.max(200,el('temperature-panel').clientWidth-34),maxHeight=Math.max(250,Math.min(500,innerHeight*.52));
    const scale=Math.min(maxWidth/source.width,maxHeight/source.height,1);canvas.width=Math.round(source.width*scale);canvas.height=Math.round(source.height*scale);
    const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0,canvas.width,canvas.height);
    ctx.fillStyle='rgba(0,0,0,.38)';ctx.beginPath();ctx.rect(0,0,canvas.width,canvas.height);
    corners.forEach((p,i)=>i?ctx.lineTo(p.x*canvas.width,p.y*canvas.height):ctx.moveTo(p.x*canvas.width,p.y*canvas.height));ctx.closePath();ctx.fill('evenodd');
    ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(p.x*canvas.width,p.y*canvas.height):ctx.moveTo(p.x*canvas.width,p.y*canvas.height));ctx.closePath();ctx.stroke();
    corners.forEach((p,i)=>{const x=p.x*canvas.width,y=p.y*canvas.height;ctx.beginPath();ctx.arc(x,y,11,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle='#222';ctx.stroke();ctx.fillStyle='#111';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(i+1),x,y);});
  }
  function findPaper(){const result=api().detectPaper(source);corners=result.corners;draw();message(result.detected?'기록지 영역을 찾았습니다. 네 모서리와 글자가 모두 포함됐는지 확인해주세요.':'자동으로 영역을 찾기 어렵습니다. 네 점을 기록지 모서리에 직접 맞춰주세요.');}
  async function selectPhoto(event){
    const file=event.target.files?.[0];if(!file)return;
    clearPhoto();const version=epoch,token=options.getToken();setBusy(true);message('사진에서 기록지 영역을 찾고 있습니다.');
    try{
      const photo=await api().loadPhoto(file);if(version!==epoch||token!==options.getToken())return;
      source=photo;el('temp-editor').classList.remove('hidden');el('temp-cancel-btn').classList.remove('hidden');findPaper();
    }catch(error){if(version===epoch)message(error.message,true);}
    finally{if(version===epoch)setBusy(false);}
  }
  async function crop(){
    if(busy||!source)return;const version=epoch;setBusy(true);message('기록지 부분을 자르고 있습니다.');
    try{
      const result=await api().cropPaper(source,corners);if(version!==epoch)return;cropped=result;pending=null;
      el('temp-preview-image').src=result.image;el('temp-editor').classList.add('hidden');el('temp-preview').classList.remove('hidden');el('temp-date').value=kstDay();
      await readVehicle(version);
      if(version===epoch&&result.width<450)message('사진 해상도가 낮습니다. 글자가 흐리면 더 가까이 다시 촬영해주세요.',true);
    }catch(error){if(version===epoch)message(error.message,true);}finally{if(version===epoch)setBusy(false);}
  }
  async function readVehicle(version){
    recognition?.abort();const controller=new AbortController();recognition=controller;
    el('temp-vehicle').value='';el('temp-vehicle-status').textContent='상단 차량번호를 읽고 있습니다…';message('차량번호를 자동으로 인식하고 있습니다. 처음에는 잠시 걸릴 수 있습니다.');
    try{
      const result=await root.DBMTTemperatureOCR.recognizeVehicle(cropped.image,{signal:controller.signal,onProgress:progress=>{
        if(version===epoch&&progress.status==='recognizing text')el('temp-vehicle-status').textContent=`차량번호 인식 중… ${Math.round(progress.progress*100)}%`;
      }});
      if(version!==epoch||controller.signal.aborted)return;
      if(result?.vehicleNo){
        el('temp-vehicle').value=result.vehicleNo;el('temp-vehicle-status').textContent='자동 인식 완료 · 사진의 번호와 다르면 수정해주세요.';
        message('차량번호를 자동으로 입력했습니다. 기록지를 확인한 뒤 전송해주세요.');
      }else{
        el('temp-vehicle-status').textContent='번호를 확실하게 읽지 못했습니다. 다시 인식하거나 직접 입력해주세요.';
        message('기록지 상단의 차량번호가 선명한지 확인해주세요.',true);
      }
    }catch(error){
      if(version!==epoch||controller.signal.aborted)return;
      el('temp-vehicle-status').textContent='자동 인식을 완료하지 못했습니다. 다시 인식하거나 직접 입력해주세요.';
      message('차량번호 자동 인식에 실패했습니다. 번호를 직접 입력해도 전송할 수 있습니다.',true);
    }finally{if(recognition===controller)recognition=null;}
  }
  async function upload(){
    if(busy||!cropped)return;const token=options.getToken(),version=epoch;
    if(!token){message('기사 로그인이 필요합니다.',true);return;}
    if(!pending){
      const date=el('temp-date').value,vehicle=el('temp-vehicle').value.trim();
      if(!date){message('기록일을 입력해주세요.',true);return;}
      if(!vehicle){message('차량번호를 다시 인식하거나 사진에 나온 번호를 입력해주세요.',true);return;}
      pending={requestId:crypto.randomUUID(),date,vehicleNo:vehicle,note:el('temp-note').value.trim(),...cropped};
    }
    setBusy(true);message('사무실로 전송하고 있습니다.');
    try{
      const result=await options.rpc('dbmt_driver_save_temperature_record',{p_token:token,p_record:pending});
      if(version!==epoch||token!==options.getToken())return;
      if(!result?.ok)throw new Error(result?.message||'전송에 실패했습니다.');
      clearPhoto();message('전송 완료! 사무실 ERP의 배송기사근태 → 온도기록지에서 출력할 수 있습니다.');loadHistory();
    }catch(error){if(version===epoch)message(`${error.message} 전송을 다시 누르면 같은 요청으로 재확인하므로 중복 저장되지 않습니다.`,true);}
    finally{if(version===epoch)setBusy(false);}
  }
  async function loadHistory(){
    const token=options.getToken(),version=++listEpoch;if(!token)return;
    const to=kstDay(),fromDate=new Date(to+'T12:00:00Z');fromDate.setUTCDate(fromDate.getUTCDate()-6);
    el('temp-history').textContent='전송내역 확인 중...';
    try{
      const result=await options.rpc('dbmt_temperature_record_list',{p_token:token,p_client:'driver',p_from:fromDate.toISOString().slice(0,10),p_to:to,p_offset:0,p_search:''});
      if(version!==listEpoch||token!==options.getToken())return;
      const rows=result.rows||[],container=el('temp-history');container.replaceChildren();
      if(!rows.length){container.textContent='최근 7일 전송내역이 없습니다.';return;}
      rows.forEach(row=>{const div=document.createElement('div');div.className='temp-history-row';div.textContent=`${row.record_date} · ${row.vehicle_no} · 전송 완료 (${new Date(row.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})})`;container.append(div);});
      if(result.total>rows.length){const div=document.createElement('div');div.textContent=`총 ${result.total}건 중 최근 ${rows.length}건 표시`;container.append(div);}
    }catch(error){if(version===listEpoch&&token===options.getToken())el('temp-history').textContent='전송내역을 불러오지 못했습니다. '+error.message;}
  }
  function init(settings){
    options=settings;
    el('temp-camera-btn').onclick=()=>el('temp-camera-input').click();el('temp-gallery-btn').onclick=()=>el('temp-photo-input').click();
    ['temp-camera-input','temp-photo-input'].forEach(id=>el(id).onchange=selectPhoto);
    el('temp-rotate-btn').onclick=()=>{if(source&&!busy){const next=api().rotatePhoto(source,corners);source=next.canvas;corners=next.corners;draw();}};
    el('temp-detect-btn').onclick=()=>{if(source&&!busy)findPaper();};el('temp-crop-btn').onclick=crop;el('temp-upload-btn').onclick=upload;
    el('temp-vehicle-retry-btn').onclick=async()=>{if(busy||pending||!cropped)return;const version=epoch;setBusy(true);try{await readVehicle(version);}finally{if(version===epoch)setBusy(false);}};
    el('temp-vehicle').oninput=()=>{el('temp-vehicle-status').textContent='직접 수정한 차량번호로 전송합니다.';};
    el('temp-back-btn').onclick=()=>{if(pending&&!confirm('전송 결과가 불확실하면 먼저 전송 버튼으로 재확인해주세요. 그래도 다시 편집할까요?'))return;pending=null;setBusy(false);el('temp-preview').classList.add('hidden');el('temp-editor').classList.remove('hidden');draw();};
    el('temp-cancel-btn').onclick=()=>{if(pending&&!confirm('전송된 기록은 취소되지 않습니다. 사진 편집을 종료할까요?'))return;clearPhoto();message('사진을 취소했습니다.');};
    el('temp-refresh-btn').onclick=loadHistory;
    const canvas=el('temp-canvas');
    canvas.onpointerdown=event=>{
      if(busy||!corners)return;const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
      let best=42;drag=-1;corners.forEach((p,i)=>{const d=Math.hypot(p.x*rect.width-x,p.y*rect.height-y);if(d<best){best=d;drag=i;}});
      if(drag>=0){event.preventDefault();canvas.setPointerCapture(event.pointerId);}
    };
    canvas.onpointermove=event=>{if(drag<0||busy)return;const rect=canvas.getBoundingClientRect(),next=corners.map(p=>({...p}));next[drag]={x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};if(api().validCorners(next)){corners=next;draw();}};
    canvas.onpointerup=canvas.onpointercancel=()=>{drag=-1;};root.addEventListener('resize',draw);
  }
  function onSession(){const token=options.getToken();if(token!==session){reset();session=token;}loadHistory();}
  root.DBMTDriverTemperature={init,onSession,reset};
})(window);
