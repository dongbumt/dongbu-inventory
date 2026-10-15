(function(){
  'use strict';
  const styles=`
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;width:190mm;margin:10mm auto;}
    .shiplog-page{break-inside:avoid;page-break-inside:avoid;}
    .shiplog-page table{table-layout:fixed;}
    .shiplog-page table:first-of-type th:nth-child(2){width:180px;}
    .shiplog-page table:first-of-type th:nth-child(4){width:120px;}
    .shiplog-page td{overflow-wrap:anywhere;}
    @media print{
      @page{size:A4;margin:10mm;}
      body{width:auto;margin:0;}
      .shiplog-page{margin-bottom:0!important;break-after:page;page-break-after:always;}
      .shiplog-page:last-child{break-after:auto;page-break-after:avoid;}
    }`;

  function paginate(doc,groups,renderPage){
    const measure=doc.createElement('div');
    measure.style.cssText='position:absolute;left:-10000px;top:0;width:190mm;visibility:hidden;';
    const ruler=doc.createElement('div');ruler.style.height='275mm';
    measure.append(ruler);doc.body.append(measure);
    // Leave 2mm inside the A4 printable height for printer rounding differences.
    const maxHeight=ruler.getBoundingClientRect().height;
    const output=[];
    try{
      for(const group of groups){
        const pages=[];
        let offset=0;
        while(offset<group.items.length){
          const pageNo=pages.length+1,items=[];
          const limit=pageNo===1?Math.min(10,group.items.length-offset):group.items.length-offset;
          for(let i=0;i<limit;i++){
            const trial=items.concat(group.items[offset+i]);
            measure.innerHTML=renderPage(group.date,trial,pageNo,2,group.trader,offset);
            if(measure.firstElementChild.getBoundingClientRect().height>maxHeight){
              if(!items.length)throw new Error('제품 정보가 한 페이지를 초과합니다. 제품명과 거래처명의 길이를 확인해주세요.');
              break;
            }
            items.push(group.items[offset+i]);
          }
          pages.push({items,offset});offset+=items.length;
        }
        pages.forEach((page,index)=>output.push(renderPage(group.date,page.items,index+1,pages.length,group.trader,page.offset)));
      }
    }finally{measure.remove();}
    return output.join('');
  }

  async function open({title,groups,renderPage}){
    const popup=window.open('','_blank');
    if(!popup){alert('출력 창을 열 수 없습니다. 브라우저의 팝업 차단을 해제해주세요.');return false;}
    try{
      const doc=popup.document;
      doc.open();doc.write('<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head><body>출고일지를 준비하고 있습니다…</body></html>');doc.close();
      doc.title=title;
      const style=doc.createElement('style');style.textContent=styles;doc.head.append(style);
      await doc.fonts.ready;
      if(popup.closed)return false;
      doc.body.innerHTML=paginate(doc,groups,renderPage);
      doc.documentElement.dataset.printReady='true';
      popup.focus();popup.print();return true;
    }catch(error){
      if(!popup.closed)popup.document.body.textContent='출고일지 출력 준비 실패: '+(error.message||String(error));
      return false;
    }
  }
  window.DBMTShipLogPrint={open};
})();
