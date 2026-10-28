/* New inner ledger for isolated browser regressions. No backend connection. */
module.exports=function(){
  const logs=[];
  return async function(route){
    const name=route.request().url().split('/').pop();
    if(!['dbmt_label_inner_prints','dbmt_label_save_inner_prints'].includes(name))return false;
    const body=route.request().postDataJSON();
    for(const row of body.p_logs||[]){const i=logs.findIndex(r=>r.id===row.id);if(i<0)logs.push(row);else logs[i]=row;}
    const id=body.p_work_order_id||body.p_logs?.[0].workOrderId,rows=logs.filter(r=>r.workOrderId===id),groups=new Map();
    for(const r of rows.filter(r=>r.status!=='void')){if(!groups.has(r.lot))groups.set(r.lot,{lot:r.lot,count:0,weight:0});const g=groups.get(r.lot);g.count++;g.weight+=r.labelWeight;}
    await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,workOrderId:id,totals:[...groups.values()],logs:rows,nextBeforeId:null})});return true;
  };
};
