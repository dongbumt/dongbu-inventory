// For existing print/backend regression fixtures. The new live UI suite tests
// touch entry itself; these fixtures set its canonical form values directly.
exports.setOuter=async(page,weight,copies)=>page.evaluate(({weight,copies})=>{
  if(weight!==undefined){
    const select=document.getElementById('print-weight'),custom=document.getElementById('print-weight-custom');
    if([...select.options].some(o=>o.value===String(weight))&&String(weight)!=='')select.value=String(weight);
    else{select.value='custom';custom.value=String(weight);}
    custom.hidden=select.value!=='custom';select.dispatchEvent(new Event('change'));
  }
  if(copies!==undefined){const el=document.getElementById('print-copies');el.value=String(copies);el.dispatchEvent(new Event('input'));}
  DBMTLabelTouch.sync();
},{weight,copies});
