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
    const retryDelays=[250,500,1000],retryWindow=10000;
    let port=null,reader=null,task=null,connecting=false,stopping=false,last=null,error=null;
    let recovery=null,cancelRetry=null,closeFailed=false,failures=[];
    function diagnose(e,phase='read'){
      const code=String(e?.name||'UnknownError');
      const settings='저울과 PC의 통신 설정(2400 bps / 7E1), 통신 케이블과 변환기 연결을 확인하세요.';
      const causes={
        ParityError:['패리티 오류',settings],
        FramingError:['프레임 오류',settings],
        BreakError:['통신 신호 끊김','저울 전원, 통신 케이블과 변환기 연결을 확인하세요.'],
        BufferOverrunError:['수신 버퍼 초과','PC 부하와 통신 변환기 상태를 확인하고 다시 연결하세요.'],
        NetworkError:phase==='open'
          ?['포트 열기 실패','SM 또는 다른 라벨전용 탭이 COM2를 사용 중인지, 장치가 연결되어 있는지 확인하세요.']
          :['장치 통신 오류','저울 전원, 통신 케이블, USB 변환기와 장치 드라이버 상태를 확인하세요.'],
        InvalidStateError:['포트 사용 상태 오류','이전 연결을 해제하고 SM 또는 다른 라벨전용 탭의 COM2 사용 여부를 확인하세요.'],
        TypeError:['수신 포트 상태 오류','다른 연결이 같은 포트를 사용 중인지 확인한 뒤 연결을 해제하고 다시 연결하세요.'],
        SecurityError:['포트 접근 권한 오류','HTTPS의 Edge 또는 Chrome에서 저울 포트 접근 권한을 확인하세요.'],
        NotAllowedError:['포트 접근 권한 오류','브라우저의 저울 포트 접근 권한을 확인하세요.'],
        NotSupportedError:['지원되지 않는 통신 설정','장치 드라이버가 2400 bps / 7E1 통신을 지원하는지 확인하세요.']
      };
      const [label,hint]=causes[code]||['장치/드라이버 오류','저울 전원, 케이블과 변환기 및 장치 드라이버 상태를 확인하세요.'];
      const raw=String(e?.message||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,240);
      return {code,label,detail:`${label} (${code}). ${hint}${raw?' 브라우저 오류: '+raw:''}`};
    }
    function problem(e,prefix,phase){
      const cause=diagnose(e,phase);
      return {...cause,message:`${prefix} · ${cause.label}`,detail:`${prefix}. ${cause.detail}`};
    }
    function status(){
      const connected=!!port && !stopping && !closeFailed;
      const fresh=!recovery && last && clock()-last.at<=3000;
      const waiting=recovery && clock()-recovery.at>=3000;
      const message=connecting?'연결 중':stopping?'연결 해제 중':error?error.message
        :!connected?'저울 미연결':waiting?'복구 대기 · 데이터 없음':recovery?`수신 복구 중 (${recovery.attempt}/${retryDelays.length})`
        :!fresh?'수신 대기 · 중량 확인 필요':!last.stable?'흔들림 · 출력 대기':last.value<=0?'0 또는 음수 · 출력 대기':'안정';
      return {connected,connecting,disconnecting:stopping,portOpen:!!port,recovering:!!recovery,
        value:connected&&fresh?last.value:null,
        ready:!!(connected&&fresh&&last.stable&&last.value>0),
        message,detail:error?.detail||(waiting?'3초 이상 유효한 중량을 받지 못했습니다. 저울의 연속 출력 설정과 케이블 연결을 확인하세요. '+recovery.detail:recovery?.detail)||message,
        errorCode:error?.code||recovery?.code||'',options};
    }
    const emit=()=>onChange(status());
    function waitForRetry(ms){
      return new Promise(resolve=>{
        const finish=()=>{clearTimeout(timer);cancelRetry=null;resolve();};
        const timer=setTimeout(finish,ms);cancelRetry=finish;
      });
    }
    async function closePort(active){
      try{
        await active.close();
        if(port===active)port=null;
        closeFailed=false;
      }catch(e){
        if(!active.readable){if(port===active)port=null;closeFailed=false;return;}
        // Keep the owned port available for an explicit close retry. Never open
        // a second connection while a failed close may still hold COM2.
        closeFailed=true;
        const cleanup=problem(e,'포트 해제 실패','close');
        error=error?{...error,detail:error.detail+' '+cleanup.detail}:cleanup;
        error.detail+=' 연결 해제를 누른 뒤 다시 연결하세요.';
      }
    }
    async function read(active){
      try {
        while(!stopping){
          let fault=null,buffer='';const decoder=new TextDecoder();
          try{
            if(!active.readable)throw Object.assign(Error('수신 포트를 사용할 수 없습니다.'),{name:'NetworkError'});
            reader=active.readable.getReader();
            while(!stopping){
              const {value,done}=await reader.read();
              if(done){
                if(stopping)break;
                throw Object.assign(Error('저울 수신 스트림이 종료되었습니다.'),{name:'NetworkError'});
              }
              buffer+=decoder.decode(value,{stream:true});
              const lines=buffer.split(/[\r\n]/);buffer=lines.pop();
              if(buffer.length>256){buffer='';last=null;}
              for(const line of lines){
                if(!line.trim())continue;
                const parsed=parse(line);last=parsed?{...parsed,at:clock()}:null;
                if(parsed)recovery=null;
              }
              emit();
            }
          }catch(e){fault=e;}
          finally{
            try{reader?.releaseLock();}catch(e){fault=fault||e;}
            reader=null;
          }
          if(stopping)break;
          // Discard the previous weight and partial frame before recovering.
          // Web Serial replaces readable after non-fatal framing/parity errors.
          last=null;
          if(!active.readable){error=problem(fault,'저울 연결 끊김');break;}
          if(['InvalidStateError','TypeError','SecurityError','NotAllowedError','NotSupportedError'].includes(fault?.name)){
            error=problem(fault,'수신 실패');break;
          }
          const now=clock();failures=failures.filter(at=>now-at<=retryWindow);failures.push(now);
          const attempt=failures.length;
          if(attempt>retryDelays.length){
            error=problem(fault,'수신 오류 반복');
            error.detail=`10초 내 ${attempt}회 오류 발생. ${error.detail}`;break;
          }
          const cause=diagnose(fault);
          recovery={...cause,attempt,at:now,detail:`자동 수신 복구 ${attempt}/${retryDelays.length}회 · 새 중량을 기다립니다. ${cause.detail}`};
          emit();
          await waitForRetry(retryDelays[attempt-1]);
        }
      } catch(e){if(!stopping)error=problem(e,'수신 실패');}
      finally {
        stopping=true;last=null;recovery=null;emit();
        await closePort(active);
        task=null;stopping=false;emit();
      }
    }
    async function connect(){
      if(port||connecting||stopping)return;
      if(!serial?.requestPort)throw Error('저울 연결은 HTTPS의 Edge 또는 Chrome에서 사용하세요.');
      connecting=true;error=null;recovery=null;failures=[];closeFailed=false;emit();
      try {
        const chosen=await serial.requestPort();
        await chosen.open(options);port=chosen;last=null;stopping=false;
        task=read(chosen);
      } catch(e){
        error=e.name==='NotFoundError'?{code:e.name,message:'저울 선택 취소',detail:'저울 포트 선택을 취소했습니다.'}:problem(e,'연결 실패','open');
        throw Error(error.detail);
      }
      finally{connecting=false;emit();}
    }
    async function disconnect(){
      if(connecting||stopping)return;
      stopping=true;last=null;recovery=null;error=null;emit();cancelRetry?.();
      const running=task;
      try{
        try{await reader?.cancel();}catch(e){/* An errored stream is already ending. */}
        await running;
        if(!running&&port)await closePort(port);
      }finally{task=null;stopping=false;emit();}
    }
    return {status,connect,disconnect};
  }
  root.DBMTScale={parse,create};
})(window);
