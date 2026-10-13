/* Scan feedback only; audio failures must never interrupt inventory work. */
(function(global){
  'use strict';
  const patterns={
    success:[[1046.5,0,0.3,'sine',0.36],[784,0.36,0.44,'sine',0.36]],
    error:[[740,0,0.1,'square',0.09],[740,0.16,0.1,'square',0.09]]
  };
  let context=null;
  const voices=new Set();
  function unlock(event){
    if(!event.isTrusted)return;
    try{
      const Audio=global.AudioContext||global.webkitAudioContext;
      if(!Audio)return;
      if(!context||context.state==='closed')context=new Audio();
      if(context.state!=='running')context.resume().catch(()=>{});
    }catch(_){}
  }
  function stop(){
    for(const voice of voices){
      try{
        const now=context.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0,now,0.003);
        voice.oscillator.stop(now+0.01);
      }catch(_){}
    }
    voices.clear();
  }
  function play(kind){
    try{
      if(!patterns[kind]||!context||context.state!=='running'||global.document.hidden)return;
      // A burst must sound like the latest visible result, not a delayed queue.
      stop();
      const start=context.currentTime+0.015;
      for(const [frequency,offset,duration,type,volume] of patterns[kind]){
        const oscillator=context.createOscillator(),gain=context.createGain(),at=start+offset;
        const voice={oscillator,gain};voices.add(voice);
        oscillator.type=type;oscillator.frequency.setValueAtTime(frequency,at);
        gain.gain.setValueAtTime(0,at);
        gain.gain.linearRampToValueAtTime(volume,at+0.005);
        if(kind==='success'){
          gain.gain.setValueAtTime(volume,at+duration*0.65);
          gain.gain.exponentialRampToValueAtTime(0.0001,at+duration);
        }
        else{
          gain.gain.setValueAtTime(volume,at+duration-0.01);
          gain.gain.linearRampToValueAtTime(0,at+duration);
        }
        oscillator.connect(gain);gain.connect(context.destination);
        oscillator.onended=()=>{voices.delete(voice);oscillator.disconnect();gain.disconnect();};
        oscillator.start(at);oscillator.stop(at+duration+0.01);
      }
    }catch(_){stop();}
  }
  // Resume inside the input gesture, before awaiting the server's scan result.
  for(const type of ['pointerup','click','keydown','paste'])global.document.addEventListener(type,unlock,{capture:true,passive:true});
  global.document.addEventListener('visibilitychange',()=>{if(global.document.hidden)stop();});
  global.DBMTPdaSound={play};
})(window);
