// Mechanically refresh the isolated UI proposal from the actual label renderer.
// Only generated marker blocks in the prototype are written. Production files are read-only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(repo,'label-print.html'),'utf8').replace(/\r\n/g,'\n');
const printDoc=fs.readFileSync(path.join(repo,'label-print-document.js'),'utf8').replace(/\r\n/g,'\n');
const file=path.join(repo,'prototypes/label-touch-packaging-proposals.html');
const original=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
function takeFunction(name){
  const start=source.indexOf(`    function ${name}(`);
  assert(start>=0,`Missing ${name}`);
  const end=source.indexOf('\n    function ',start+1);
  assert(end>start,`Missing boundary after ${name}`);
  return source.slice(start,end).trim();
}
const functions=['buildLabelBody','otherMarkHtml','inferMeatType','formatIngredients','crossFacilityNotice'].map(takeFunction).join('\n\n');
const defaults=source.match(/const DEFAULTS = \{[\s\S]*?\n    \};/)[0];
const haccp=fs.readFileSync(path.join(repo,'HACCP2.png'));
const recycle=fs.readFileSync(path.join(repo,'assets/other-recycle.svg'));
const hash=crypto.createHash('sha256').update(functions).update(haccp).update(recycle).digest('hex');
const js=`
  // Actual label renderer and unchanged logo bytes. Source SHA-256: ${hash}
  const actualLabelPreview=(()=>{
    ${defaults}
    function html(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
    function haccpMarkSrc(){return ${JSON.stringify('data:image/png;base64,'+haccp.toString('base64'))};}
    function otherMarkSrc(){return ${JSON.stringify('data:image/svg+xml;base64,'+recycle.toString('base64'))};}
    ${functions}
    return data=>buildLabelBody(data);
  })();
  `;
// The CSS template contains interpolation braces; use the rule's terminating newline instead.
const line=printDoc.split('\n').find(line=>line.trim().startsWith('.print-label,.lbl-label { width:'));
assert(line,'Missing actual label page style');
const css=line.slice(line.indexOf('{')+1,line.lastIndexOf('}')).replaceAll('${contentWidth}','67').replaceAll('${height}','100');
assert(!css.includes('${'),'Unresolved label dimensions');
function replaceMarker(text,type,contents){
  const start=`/* PROPOSAL-LABEL-${type}:START */`,end=`/* PROPOSAL-LABEL-${type}:END */`;
  const a=text.indexOf(start),b=text.indexOf(end,a);
  assert(a>=0&&b>a,`Missing ${type} marker`);
  return text.slice(0,a+start.length)+'\n'+contents+text.slice(b);
}
let output=replaceMarker(original,'JS',js);
output=replaceMarker(output,'CSS',`  #dbmt-packaging-proposals .dp-actual-label {${css}}\n  `);
assert(Buffer.byteLength(output)<1_000_000,'Keep inline proposal below 1 MB');
if(process.argv.includes('--check'))assert.equal(original,output,'Run node tools/build-label-proposal-preview.cjs to refresh the actual label preview');
else fs.writeFileSync(file,output,'utf8');
console.log(`PASS: ${process.argv.includes('--check')?'verified':'refreshed'} exact label renderer / artwork snapshot (${Buffer.byteLength(output)} bytes)`);
