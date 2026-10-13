// Audio API fixtures plus real offline synthesis. Never plays through speakers.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {chromium}=require('playwright');
const source=fs.readFileSync(path.join(__dirname,'../pda-sound.js'),'utf8');
function fixture(mode='normal'){
  const listeners={},contexts=[],notes=[],gains=[];
  const parameter=()=>({values:[],ramps:[],setValueAtTime(value,at){this.values.push([value,at]);},linearRampToValueAtTime(value,at){this.ramps.push([value,at]);},exponentialRampToValueAtTime(){},cancelScheduledValues(){},setTargetAtTime(){}});
  class Audio{
    constructor(){if(mode==='constructor-failure')throw Error('Audio unavailable');this.state='suspended';this.currentTime=1;this.destination={};contexts.push(this);}
    resume(){if(mode==='resume-failure')return Promise.reject(Error('Audio blocked'));this.state='running';return Promise.resolve();}
    createOscillator(){
      if(mode==='node-failure')throw Error('Audio node unavailable');
      const note={starts:[],stops:[],connect(){},disconnect(){},start(at){this.starts.push(at);},stop(at){this.stops.push(at);}};
      note.frequency={setValueAtTime(value,at){note.frequencyValues=[value,at];}};notes.push(note);return note;
    }
    createGain(){const gain=parameter();gains.push(gain);return {gain,connect(){},disconnect(){}};}
  }
  const document={hidden:false,addEventListener(type,handler){listeners[type]=handler;}};
  const window={document,AudioContext:mode==='unsupported'?undefined:Audio};
  vm.runInNewContext(source,{window});
  return {window,document,contexts,notes,gains,event:(type,trusted=true)=>listeners[type]({isTrusted:trusted})};
}
(async()=>{
  const f=fixture();f.window.DBMTPdaSound.play('success');assert.equal(f.contexts.length,0,'No autoplay or audio creation before interaction');
  f.event('keydown',false);assert.equal(f.contexts.length,0);
  f.event('pointerup');assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].state,'running');
  f.window.DBMTPdaSound.play('success');assert.deepEqual(f.notes.map(n=>n.frequencyValues[0]),[1046.5,784]);assert(f.notes.every(n=>n.type==='sine'));
  f.window.DBMTPdaSound.play('error');assert.deepEqual(f.notes.slice(-2).map(n=>n.frequencyValues[0]),[740,740]);assert(f.notes.slice(-2).every(n=>n.type==='square'));
  for(const gain of f.gains.slice(-2)){assert.deepEqual(gain.values.map(([value])=>value),[0,.09]);assert.deepEqual(gain.ramps.map(([value])=>value),[.09,0]);}
  assert(Math.abs(f.notes.at(-1).starts[0]-f.notes.at(-2).starts[0]-.16)<1e-9);
  assert(f.notes.slice(-2).every(note=>Math.abs(note.stops[0]-note.starts[0]-.11)<1e-9),'Preserve error tone length, gap and loudness');
  assert(f.notes.slice(0,2).every(n=>n.stops.at(-1)===1.01),'New result cancels old/queued tones');
  for(let i=0;i<50;i++)f.window.DBMTPdaSound.play(i%2?'error':'success');
  assert(f.notes.slice(-2).every(n=>n.type==='square'));assert(f.notes.at(-1).starts[0]<1.2,'Rapid results cannot build a long audio backlog');
  for(const note of f.notes)note.onended();
  f.contexts[0].state='suspended';f.event('keydown');assert.equal(f.contexts[0].state,'running');assert.equal(f.contexts.length,1);
  f.document.hidden=true;f.event('visibilitychange');const count=f.notes.length;f.window.DBMTPdaSound.play('error');assert.equal(f.notes.length,count);
  f.document.hidden=false;f.contexts[0].state='closed';f.event('click');assert.equal(f.contexts.length,2,'Recreate a closed audio context on the next input');
  for(const mode of ['unsupported','constructor-failure','resume-failure','node-failure']){
    const broken=fixture(mode);assert.doesNotThrow(()=>{broken.event('click');broken.window.DBMTPdaSound.play('success');broken.window.DBMTPdaSound.play('error');});
  }
  await Promise.resolve();
  console.log('PASS: gesture activation, distinct patterns, latest-result playback, background/closed-context recovery, unavailable/blocked audio isolation');
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',args:['--mute-audio']});
  try{
    const activation=await browser.newPage();await activation.setContent('<button>Activate audio</button>');
    await activation.evaluate(()=>{const Native=AudioContext;window.AudioContext=class extends Native{constructor(){super();window.__actualAudio=this;}};});
    await activation.addScriptTag({content:source});assert.equal(await activation.evaluate(()=>Boolean(window.__actualAudio)),false);
    await activation.getByRole('button').click();await activation.waitForFunction(()=>__actualAudio.state==='running');
    await activation.evaluate(()=>__actualAudio.suspend());
    await activation.getByRole('button').press('Enter');await activation.waitForFunction(()=>__actualAudio.state==='running');
    await activation.evaluate(()=>__actualAudio.close());await activation.close();
    console.log('PASS: real Chrome AudioContext activates on a trusted click and resumes on a trusted scanner-style keypress');
    for(const kind of ['success','error']){
      const page=await browser.newPage();await page.setContent('<button>Activate audio</button>');
      await page.evaluate(()=>{
        window.__offline=new OfflineAudioContext(1,48000,48000);
        window.AudioContext=class{constructor(){return {state:'running',currentTime:0,destination:__offline.destination,createOscillator:()=>__offline.createOscillator(),createGain:()=>__offline.createGain()};}};
      });
      await page.addScriptTag({content:source});await page.getByRole('button').click();
      const audio=await page.evaluate(async kind=>{
        DBMTPdaSound.play(kind);const buffer=await __offline.startRendering(),samples=buffer.getChannelData(0),rate=buffer.sampleRate;
        const rms=(start,end)=>{const part=samples.slice(start*rate,end*rate);return Math.sqrt(part.reduce((sum,v)=>sum+v*v,0)/part.length);};
        const energy=(frequency,start,end)=>{let re=0,im=0;for(let i=Math.floor(start*rate);i<end*rate;i++){const angle=2*Math.PI*frequency*i/rate;re+=samples[i]*Math.cos(angle);im+=samples[i]*Math.sin(angle);}return re*re+im*im;};
        const windows=kind==='success'?[[.035,.2],[.42,.65]]:[[.035,.09],[.19,.24]];
        return {peak:Math.max(...samples.map(Math.abs)),first:rms(...windows[0]),second:rms(...windows[1]),gap:kind==='success'?rms(.33,.36):rms(.13,.15),tail:kind==='success'?rms(.9,.98):rms(.5,.8),sustain:kind==='success'?[rms(.16,.2),rms(.62,.65)]:[],energies:windows.map(([a,b])=>[740,784,1046.5].map(hz=>energy(hz,a,b)))};
      },kind);
      assert(audio.first>0.005&&audio.second>0.005,'Both actual synthesized notes must be non-silent');
      assert(audio.peak<0.5&&audio.tail===0,'No clipping or stuck tone');
      if(kind==='success'){
        assert(audio.energies[0][2]>audio.energies[0][0]*5);assert(audio.energies[1][1]>audio.energies[1][2]*5);
        assert(audio.sustain.every(rms=>rms>0.2),'Success notes must remain clearly audible instead of decaying immediately');
        assert(audio.gap===0,'Separate the two longer success notes');
      }
      else{assert(audio.gap===0,'Two separate error beeps');assert(audio.energies.every(e=>e[0]>e[2]*5));}
      await page.close();console.log(`PASS: ${kind} actual offline waveform, two audible notes, expected pitch/timing, no clipping or trailing sound`);
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
