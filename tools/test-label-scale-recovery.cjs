// Isolated Web Serial streams and virtual time. No hardware, ERP or printing.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','label-scale.js'),'utf8');
const fault=(name,message=name)=>Object.assign(new Error(message),{name});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture({openError=null,closeErrors=0,chooseError=null}={}){
  let now=1000,nextTimer=0,stream=null,controller=null;
  const timers=new Map(),events=[],stats={requests:0,opens:0,closes:0};
  const renew=()=>{stream=new ReadableStream({start(value){controller=value;}});};
  const port={
    get readable(){return stream;},
    async open(options){stats.opens++;if(openError)throw openError;stats.options=options;renew();},
    async close(){stats.closes++;assert(!stream?.locked,'Release the reader lock before closing');if(closeErrors-->0)throw fault('InvalidStateError','QA close still busy');stream=null;}
  };
  const serial={async requestPort(){stats.requests++;if(chooseError)throw chooseError;return port;}};
  const context={window:{},TextDecoder,setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
  vm.runInNewContext(source,context);
  const scale=context.window.DBMTScale.create(serial,value=>events.push({...value}),()=>now);
  return {scale,stats,events,timers,port,
    async send(text){controller.enqueue(new TextEncoder().encode(text));await flush();},
    async fail(name,{fatal=false,message='QA device read failure'}={}){
      const old=controller;if(fatal)stream=null;else renew();old.error(fault(name,message));await flush();
    },
    async end(){const old=controller;stream=null;old.close();await flush();},
    async advance(){assert.equal(timers.size,1,'Only one recovery timer may be pending');const [id,item]=timers.entries().next().value;timers.delete(id);now+=item.ms;item.fn();await flush();return item.ms;},
    elapse(ms){now+=ms;}
  };
}
(async()=>{
  // Recover without opening COM2 again, and never reuse the old stable weight.
  for(const name of ['ParityError','FramingError','BufferOverrunError','BreakError','UnknownError']){
    const f=fixture();await f.scale.connect();await f.send('ST,+00009.99 kg\r\n');assert.equal(f.scale.status().ready,true);
    await f.send('ST,+000');await f.fail(name);
    assert.equal(f.scale.status().recovering,true,name);assert.equal(f.scale.status().ready,false);assert.equal(f.scale.status().value,null);
    assert.equal(f.scale.status().errorCode,name);assert.match(f.scale.status().detail,new RegExp(name));
    assert.equal(await f.advance(),250);
    await f.send('02.50 kg\r\n');assert.equal(f.scale.status().ready,false,'Discard pre-error partial frames');
    await f.send('ST,+00002.50 kg\r\n');assert.equal(f.scale.status().value,2.5);assert.equal(f.scale.status().ready,true);assert.equal(f.scale.status().recovering,false);
    assert.deepEqual({requests:f.stats.requests,opens:f.stats.opens,closes:f.stats.closes},{requests:1,opens:1,closes:0});
    f.elapse(3001);assert.equal(f.scale.status().ready,false);assert.equal(f.scale.status().value,null,'Still reject stale weights after recovering');
    await f.scale.disconnect();assert.equal(f.stats.closes,1);assert.equal(f.timers.size,0);
  }
  // A few good frames must not hide a continuously flapping connection.
  {
    const f=fixture();await f.scale.connect();
    for(const delay of [250,500,1000]){
      await f.fail('FramingError',{message:'QA repeated framing fault'});assert.equal(f.scale.status().ready,false);
      assert.equal(await f.advance(),delay);await f.send('ST,+00001.00 kg\r\n');assert.equal(f.scale.status().ready,true);
    }
    await f.fail('FramingError',{message:'QA repeated framing fault'});
    assert.equal(f.scale.status().connected,false);assert.equal(f.scale.status().value,null);assert.equal(f.scale.status().errorCode,'FramingError');
    assert.match(f.scale.status().message,/수신 오류 반복/);assert.match(f.scale.status().detail,/10초 내 4회.*QA repeated framing fault/);
    assert.equal(f.stats.closes,1);assert.equal(f.timers.size,0);assert.equal(f.stats.requests,1);
    await f.scale.connect();await f.send('ST,+00003.00 kg\r\n');assert.equal(f.scale.status().ready,true,'An explicit reconnect resets the recovery budget');await f.scale.disconnect();
  }
  {
    const f=fixture();await f.scale.connect();await f.fail('ParityError');await f.advance();await f.send('ST,+00001.00 kg\r\n');
    f.elapse(10001);await f.fail('ParityError');assert.match(f.scale.status().message,/1\/3/,'A new isolated error after a healthy interval gets a new retry budget');await f.scale.disconnect();
  }
  {
    const f=fixture();await f.scale.connect();await f.fail('ParityError');await f.advance();f.elapse(3001);
    assert.match(f.scale.status().message,/데이터 없음/);assert.match(f.scale.status().detail,/3초.*연속 출력.*ParityError/);assert.equal(f.scale.status().ready,false);
    await f.send('ST,+00002.00 kg\r\n');assert.equal(f.scale.status().ready,true,'A delayed new reading still resumes the same connection');await f.scale.disconnect();
  }
  // Fatal disconnection and unexpected EOF close cleanly without port probing.
  for(const eof of [false,true]){
    const f=fixture();await f.scale.connect();await f.send('ST,+00004.00 kg\r\n');
    if(eof)await f.end();else await f.fail('NetworkError',{fatal:true});
    assert.equal(f.scale.status().ready,false);assert.equal(f.scale.status().portOpen,false);assert.match(f.scale.status().message,/연결 끊김/);
    assert.match(f.scale.status().detail,/NetworkError.*케이블/);assert.equal(f.timers.size,0);assert.equal(f.stats.requests,1);assert.equal(f.stats.closes,1);
  }
  // A manual disconnect cancels the backoff and cannot revive a previous read.
  {
    const f=fixture();await f.scale.connect();await f.fail('ParityError');await f.scale.connect();assert.equal(f.stats.requests,1);
    const closing=f.scale.disconnect();await f.scale.connect();await closing;
    assert.equal(f.timers.size,0);assert.equal(f.stats.closes,1);assert.equal(f.stats.requests,1);assert.equal(f.scale.status().message,'저울 미연결');
    await f.scale.connect();await f.send('US,+00002.00 kg\r\n');assert.equal(f.scale.status().ready,false);
    await f.send('ST,+00002.00 kg\r\n');assert.equal(f.scale.status().ready,true);assert.equal(f.stats.requests,2);await f.scale.disconnect();
  }
  // If closing fails, retain the handle for an explicit release retry.
  {
    const f=fixture({closeErrors:1});await f.scale.connect();await f.scale.disconnect();
    assert.equal(f.stats.closes,1);assert.equal(f.scale.status().portOpen,true);assert.equal(f.scale.status().connected,false);assert.equal(f.scale.status().ready,false);
    assert.match(f.scale.status().detail,/포트 해제 실패.*InvalidStateError/);
    await f.scale.connect();assert.equal(f.stats.requests,1,'Do not open another connection before the failed close is resolved');
    await f.scale.disconnect();assert.equal(f.stats.closes,2);assert.equal(f.scale.status().portOpen,false);assert.equal(f.scale.status().message,'저울 미연결');
  }
  // Access, configuration and stream-lock errors are not retried as noise.
  for(const name of ['InvalidStateError','TypeError','SecurityError','NotAllowedError','NotSupportedError']){
    const f=fixture();await f.scale.connect();await f.fail(name);
    assert.equal(f.scale.status().connected,false);assert.equal(f.timers.size,0);assert.equal(f.scale.status().errorCode,name);assert.equal(f.stats.closes,1);
  }
  for(const name of ['NetworkError','InvalidStateError','SecurityError','NotAllowedError','NotSupportedError','UnknownError']){
    const f=fixture({openError:fault(name,'QA native open reason')});await assert.rejects(f.scale.connect(),new RegExp(name));
    assert.equal(f.scale.status().errorCode,name);assert.match(f.scale.status().detail,/QA native open reason/);assert.equal(f.timers.size,0);assert.equal(f.stats.requests,1);assert.equal(f.stats.closes,0);
  }
  {
    const f=fixture({chooseError:fault('NotFoundError')});await assert.rejects(f.scale.connect(),/선택을 취소/);
    assert.equal(f.scale.status().message,'저울 선택 취소');assert.equal(f.stats.opens,0);assert.equal(f.timers.size,0);
  }
  console.log('PASS: transient read recovery on the same port; stale/partial weight rejection; bounded flapping errors and detailed causes; disconnect/EOF; manual cancellation/reconnect; failed-close retry; permission/configuration failures; no hardware or printing.');
})().catch(error=>{console.error(error);process.exitCode=1;});
