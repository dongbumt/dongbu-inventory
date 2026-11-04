// Import only barcode-format definitions, never SM users, transactions or scan history.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
function build(folder){
  const files=['01_동부축산유통_WgtFormat_원본.json','02_동부엠티_WgtFormat_원본.json'];
  const rows=files.flatMap(file=>JSON.parse(fs.readFileSync(path.join(folder,file),'utf8').replace(/^\uFEFF/,'')));
  assert.equal(rows.length,383);
  const entries=rows.map(row=>{
    const definition={source:row.SourceCompany,manuId:Number(row.ManuId),name:String(row.ManuFullName||''),shortName:String(row.ManuShortName||''),country:String(row.ManuKorName||''),
      length:Number(row.BarcodeLength),start:Number(row.WgtStartPos),digits:Number(row.WgtLength),decimals:Number(row.WgtDecimal),factor:Number(row.ConvFactor),rounding:Number(row.RoundingDigits),min:Number(row.MinWgt),max:Number(row.MaxWgt)};
    for(const value of Object.values(definition).filter(value=>typeof value==='number'))assert(Number.isFinite(value));
    const company=definition.source==='동부엠티'?'mt':'db',digest=crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    return {key:`sm2:v1:${company}:${definition.manuId}:${digest}`,definition};
  }).sort((a,b)=>a.definition.source.localeCompare(b.definition.source,'ko')||a.definition.manuId-b.definition.manuId);
  assert.equal(new Set(entries.map(row=>row.key)).size,383);
  const condition=row=>{const d=row.definition;return JSON.stringify([d.length,d.start,d.digits,d.decimals,d.factor,d.rounding]);};
  assert.equal(new Set(entries.map(condition)).size,195);
  return '-- SM backup snapshot 2026-08-19, extracted 2026-08-20: 383 source formats / 195 numeric conditions.\n'+
    '-- Keep company-specific ranges and immutable versioned keys; no live SM connection is used.\n'+
    "insert into pda_private.raw_sm_formats(rule_key,definition)\nselect e->>'key',e->'definition' from jsonb_array_elements($catalog$"+JSON.stringify(entries)+'$catalog$::jsonb) e\non conflict(rule_key) do nothing;\n';
}
if(require.main===module){
  const folder=process.argv[2];assert(folder,'Pass the local, previously extracted SM definition folder.');
  process.stdout.write(build(folder));
}
module.exports={build};
