/* Read-only A&D serial input: field-verified COM2 / 2400 / 7E1.
   No commands, automatic port probing, or simulated readings in production. */
(function(root){
  'use strict';
  const options={baudRate:2400,dataBits:7,stopBits:1,parity:'even',flowControl:'none'};
  function parse(line){
    const m=String(line).trim().match(/^(ST|US),([+-]\d{1,7}\.\d{2})\s*kg$/);
    if(!m) return null;
    const value=Number(m[2]);
    if(!Number.isFinite(value)||Math.abs(value)>150) return null;
    return {value,stable:m[1]==='ST'};
  }
  function create(serial,onChange=()=>{},clock=()=>Date.now()){
    let port=null,reader=null,task=null,connecting=false,stopping=false,last=null,error='';
    function status(){
      const connected=!!port && !stopping, fresh=last && clock()-last.at<=3000;
      return {connected,connecting,value:connected&&fresh?last.value:null,
        ready:!!(connected&&fresh&&last.stable&&last.value>0),
        message:connecting?'연결 중':!connected?(error||'저울 미연결'):!fresh?'수신 대기 · 중량 확인 필요':!last.stable?'흔들림 · 출력 대기':last.value<=0?'0 또는 음수 · 출력 대기':'안정',options};
    }
    const emit=()=>onChange(status());
    async function read(active){
      let buffer='';const decoder=new TextDecoder();
      try {
        if(!active.readable) throw Error('저울 데이터를 읽을 수 없습니다.');
        reader=active.readable.getReader();
        while(!stopping){
          const {value,done}=await reader.read();if(done)break;
          buffer+=decoder.decode(value,{stream:true});
          const lines=buffer.split(/[\r\n]/);buffer=lines.pop();
          if(buffer.length>256){buffer='';last=null;}
          for(const line of lines){
            if(!line.trim())continue;
            const parsed=parse(line);last=parsed?{...parsed,at:clock()}:null;
          }
          emit();
        }
      } catch(e){if(!stopping)error='수신 오류 · 연결을 다시 확인하세요.';}
      finally {
        reader?.releaseLock();reader=null;
        try{await active.close();}catch(e){/* Already disconnected. */}
        port=null;last=null;stopping=false;emit();
      }
    }
    async function connect(){
      if(port||connecting||stopping)return;
      if(!serial?.requestPort)throw Error('저울 연결은 HTTPS의 Edge 또는 Chrome에서 사용하세요.');
      connecting=true;error='';emit();
      try {
        const chosen=await serial.requestPort();
        await chosen.open(options);port=chosen;last=null;stopping=false;
        task=read(chosen);
      } catch(e){error=e.name==='NotFoundError'?'저울 선택 취소':'연결 실패 · SM 종료 및 COM2를 확인하세요.';throw Error(error);}
      finally{connecting=false;emit();}
    }
    async function disconnect(){
      if(connecting)return;
      stopping=true;last=null;emit();
      try{await reader?.cancel();await task;}finally{stopping=false;emit();}
    }
    return {status,connect,disconnect};
  }
  root.DBMTScale={parse,create};
})(window);
