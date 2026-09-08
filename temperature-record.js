/* Local-only paper detection/cropping and true-size printing. No OCR or generated text. */
(function(root){
  'use strict';
  const html = value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  const defaultCorners=()=>[{x:.1,y:.05},{x:.9,y:.05},{x:.9,y:.95},{x:.1,y:.95}];
  function validCorners(points){
    if(!Array.isArray(points)||points.length!==4||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1))return false;
    let area=0;
    for(let i=0;i<4;i++){
      const a=points[i],b=points[(i+1)%4],c=points[(i+2)%4];
      if((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)<=.0001)return false;
      area+=a.x*b.y-b.x*a.y;
    }
    return area/2>.005;
  }
  async function loadPhoto(file){
    if(!file||file.size>25*1024*1024)throw new Error('사진은 25MB 이하로 선택해주세요.');
    const url=URL.createObjectURL(file),img=new Image();
    try{
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('사진을 열 수 없습니다. JPG 또는 PNG로 다시 촬영해주세요.'));img.src=url;});
      const scale=Math.min(1,3600/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.round(img.naturalWidth*scale);canvas.height=Math.round(img.naturalHeight*scale);
      if(canvas.width<100||canvas.height<100)throw new Error('사진이 너무 작습니다. 더 가까이 촬영해주세요.');
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      return canvas;
    }finally{URL.revokeObjectURL(url);}
  }
  function detectPaper(source){
    const canvas=document.createElement('canvas'),scale=Math.min(1,600/Math.max(source.width,source.height));
    canvas.width=Math.round(source.width*scale);canvas.height=Math.round(source.height*scale);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,canvas.width,canvas.height);
    const w=canvas.width,h=canvas.height,data=ctx.getImageData(0,0,w,h).data,lum=new Uint8Array(w*h),hist=new Uint32Array(256);
    for(let i=0;i<lum.length;i++){lum[i]=Math.round(data[i*4]*.299+data[i*4+1]*.587+data[i*4+2]*.114);hist[lum[i]]++;}
    let count=0,bright=220;
    for(let i=0;i<256;i++){count+=hist[i];if(count>=w*h*.8){bright=i;break;}}
    const threshold=clamp(bright*.68,95,180),seen=new Uint8Array(w*h),queue=new Int32Array(w*h);
    let best=null;const components=[];
    for(let start=0;start<lum.length;start++){
      if(seen[start]||lum[start]<threshold)continue;
      let head=0,tail=1,minX=w,maxX=0,minY=h,maxY=0,minSum=Infinity,maxSum=-Infinity,minDiff=Infinity,maxDiff=-Infinity;
      const corners=[];queue[0]=start;seen[start]=1;
      while(head<tail){
        const p=queue[head++],x=p%w,y=Math.floor(p/w),sum=x+y,diff=x-y;
        minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        if(sum<minSum){minSum=sum;corners[0]={x:x/w,y:y/h};}if(diff>maxDiff){maxDiff=diff;corners[1]={x:x/w,y:y/h};}
        if(sum>maxSum){maxSum=sum;corners[2]={x:x/w,y:y/h};}if(diff<minDiff){minDiff=diff;corners[3]={x:x/w,y:y/h};}
        for(const n of [x>0?p-1:-1,x<w-1?p+1:-1,y>0?p-w:-1,y<h-1?p+w:-1]){
          if(n>=0&&!seen[n]&&lum[n]>=threshold){seen[n]=1;queue[tail++]=n;}
        }
      }
      const ratio=tail/(w*h),touches=Number(minX<2)+Number(minY<2)+Number(maxX>w-3)+Number(maxY>h-3);
      if(ratio<.015||ratio>.9||touches>=2||!validCorners(corners))continue;
      const score=tail*(touches?0.5:1);
      const component={score,corners,minX,maxX,minY,maxY};components.push(component);
      if(!best||score>best.score)best=component;
    }
    // A dark printer band may split one slip into bright components. Merge aligned
    // parts with similar widths, without joining unrelated papers side by side.
    if(best){
      const members=[best];let added=true;
      while(added){added=false;for(const candidate of components){
        if(members.includes(candidate))continue;
        const aWidth=best.maxX-best.minX,bWidth=candidate.maxX-candidate.minX;
        const overlap=Math.min(best.maxX,candidate.maxX)-Math.max(best.minX,candidate.minX);
        const gap=Math.max(candidate.minY-best.maxY,best.minY-candidate.maxY,0);
        if(overlap<Math.min(aWidth,bWidth)*.8||bWidth/aWidth<.65||bWidth/aWidth>1.5||gap>h*.12)continue;
        members.push(candidate);added=true;
        const all=members.flatMap(part=>part.corners),extreme=(fn,direction)=>all.reduce((a,b)=>direction*fn(a)>direction*fn(b)?a:b);
        const joined=[extreme(p=>p.x*w+p.y*h,-1),extreme(p=>p.x*w-p.y*h,1),extreme(p=>p.x*w+p.y*h,1),extreme(p=>p.x*w-p.y*h,-1)];
        best={...best,corners:joined,minX:Math.min(best.minX,candidate.minX),maxX:Math.max(best.maxX,candidate.maxX),minY:Math.min(best.minY,candidate.minY),maxY:Math.max(best.maxY,candidate.maxY)};
      }}
      if(!validCorners(best.corners))best=null;
      // Nearly upright slips often have torn/rounded corners. Enclose the entire
      // paper bounds so a corner guess cannot cut off the last printed line.
      else if(Math.abs(best.corners[0].y-best.corners[1].y)<.04&&Math.abs(best.corners[2].y-best.corners[3].y)<.04){
        const left=Math.max(0,best.minX-1)/w,right=Math.min(w,best.maxX+2)/w,top=Math.max(0,best.minY-1)/h,bottom=Math.min(h,best.maxY+2)/h;
        best.corners=[{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom}];
        // Fit the long paper edges, keeping the torn top/bottom outside the text.
        // This removes side-background padding while correcting mild perspective.
        const edgeRows=[],height=best.maxY-best.minY;
        for(let y=Math.ceil(best.minY+height*.04);y<best.maxY-height*.04;y++){
          let l=best.minX,r=best.maxX;while(l<r&&lum[y*w+l]<threshold)l++;while(r>l&&lum[y*w+r]<threshold)r--;
          if(r-l>(best.maxX-best.minX)*.75)edgeRows.push({y,l,r});
        }
        if(edgeRows.length>height*.4){
          const fit=key=>{let sy=0,sx=0,syy=0,syx=0;for(const row of edgeRows){sy+=row.y;sx+=row[key];syy+=row.y*row.y;syx+=row.y*row[key];}const n=edgeRows.length,b=(n*syx-sy*sx)/(n*syy-sy*sy);return y=>(sx-b*sy)/n+b*y;};
          const l=fit('l'),r=fit('r');
          const fitted=[{x:clamp((l(top*h)-1)/w,0,1),y:top},{x:clamp((r(top*h)+1)/w,0,1),y:top},{x:clamp((r(bottom*h)+1)/w,0,1),y:bottom},{x:clamp((l(bottom*h)-1)/w,0,1),y:bottom}];
          if(validCorners(fitted))best.corners=fitted;
        }
      }
    }
    return {corners:best?.corners||defaultCorners(),detected:!!best};
  }
  function rotatePhoto(source,points){
    const canvas=document.createElement('canvas');canvas.width=source.height;canvas.height=source.width;
    const ctx=canvas.getContext('2d');ctx.translate(canvas.width,0);ctx.rotate(Math.PI/2);ctx.drawImage(source,0,0);
    const rotated=points.map(p=>({x:1-p.y,y:p.x}));
    return {canvas,corners:[rotated[3],rotated[0],rotated[1],rotated[2]]};
  }
  function solve(matrix){
    const size=matrix.length;
    for(let col=0;col<size;col++){
      let pivot=col;
      for(let row=col+1;row<size;row++)if(Math.abs(matrix[row][col])>Math.abs(matrix[pivot][col]))pivot=row;
      if(Math.abs(matrix[pivot][col])<1e-10)throw new Error('기록지 모서리를 다시 맞춰주세요.');
      [matrix[col],matrix[pivot]]=[matrix[pivot],matrix[col]];
      const divisor=matrix[col][col];for(let k=col;k<=size;k++)matrix[col][k]/=divisor;
      for(let row=0;row<size;row++)if(row!==col){const factor=matrix[row][col];for(let k=col;k<=size;k++)matrix[row][k]-=factor*matrix[col][k];}
    }
    return matrix.map(row=>row[size]);
  }
  async function cropPaper(source,points){
    if(!validCorners(points))throw new Error('네 모서리가 서로 엇갈리지 않도록 기록지 테두리에 맞춰주세요.');
    const p=points.map(v=>({x:v.x*(source.width-1),y:v.y*(source.height-1)}));
    const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    const rawWidth=(distance(p[0],p[1])+distance(p[3],p[2]))/2,rawHeight=(distance(p[0],p[3])+distance(p[1],p[2]))/2;
    let width=Math.min(900,Math.round(rawWidth)),height=Math.round(width*rawHeight/rawWidth);
    const factor=Math.min(1,12000/height,Math.sqrt(8000000/(width*height)));width=Math.floor(width*factor);height=Math.floor(height*factor);
    if(width<100||height<100)throw new Error('선택한 기록지가 너무 작습니다. 더 가까이 촬영해주세요.');
    const matrix=[];
    [[0,0],[1,0],[1,1],[0,1]].forEach(([u,v],i)=>{
      matrix.push([u,v,1,0,0,0,-u*p[i].x,-v*p[i].x,p[i].x]);
      matrix.push([0,0,0,u,v,1,-u*p[i].y,-v*p[i].y,p[i].y]);
    });
    const m=solve(matrix),src=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,source.width,source.height).data;
    const out=document.createElement('canvas');out.width=width;out.height=height;
    const ctx=out.getContext('2d'),pixels=ctx.createImageData(width,height);
    for(let y=0;y<height;y++){
      const v=y/(height-1);
      for(let x=0;x<width;x++){
        const u=x/(width-1),den=m[6]*u+m[7]*v+1,sx=clamp((m[0]*u+m[1]*v+m[2])/den,0,source.width-1),sy=clamp((m[3]*u+m[4]*v+m[5])/den,0,source.height-1);
        const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(x0+1,source.width-1),y1=Math.min(y0+1,source.height-1),fx=sx-x0,fy=sy-y0,target=(y*width+x)*4;
        for(let c=0;c<3;c++)pixels.data[target+c]=src[(y0*source.width+x0)*4+c]*(1-fx)*(1-fy)+src[(y0*source.width+x1)*4+c]*fx*(1-fy)+src[(y1*source.width+x0)*4+c]*(1-fx)*fy+src[(y1*source.width+x1)*4+c]*fx*fy;
        pixels.data[target+3]=255;
      }
      if(y%128===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    ctx.putImageData(pixels,0,0);
    let image=out.toDataURL('image/jpeg',.94);
    for(const quality of [.88,.8,.7]){if(image.length<=2796227)break;image=out.toDataURL('image/jpeg',quality);}
    if(image.length>2796227)throw new Error('기록지가 너무 큽니다. 나누어 촬영해주세요.');
    return {image,width,height};
  }
  function buildPrintDocument(record){
    if(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=\r\n]+$/.test(record.image||''))throw new Error('올바른 온도기록지 이미지가 아닙니다.');
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>온도기록지 ${html(record.record_date)} ${html(record.vehicle_no)}</title><style>
      @page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:"Malgun Gothic",sans-serif;background:#eee;color:#111}
      .toolbar{text-align:center;padding:12px;font-size:14px;line-height:1.8}.toolbar button{padding:8px 18px;margin:5px;background:white;border:1px solid #888;border-radius:5px;font:inherit}
      .sheet{width:190mm;height:276mm;margin:0 auto 15px;background:white;break-after:page}.sheet:last-child{break-after:auto}.heading{height:10mm;font-size:9pt;line-height:1.25;padding-top:1mm;overflow-wrap:anywhere}
      .columns{display:grid;grid-template-columns:repeat(3,55mm);gap:8mm}.segment{width:55mm}.caption{height:5mm;font-size:8pt}.cut{position:relative;width:55mm;overflow:hidden;outline:.15mm dashed #999;outline-offset:.4mm}.cut img{position:absolute;left:0;display:block;width:55mm;max-width:none}
      .ruler{display:inline-block;width:55mm;border-top:1px solid #222;font-size:10px}#source{display:none}@media print{html,body{width:190mm;background:white}.toolbar{display:none}.sheet{margin:0}}
    </style></head><body><div class="toolbar">A4 세로 · <strong>배율 100% / 실제 크기</strong>로 출력하세요. ‘페이지에 맞춤’은 해제해주세요.<br>기록지 가로: 5.5cm · 긴 기록지는 폭을 줄이지 않고 나누어 배치합니다.<br><span class="ruler">확인용 기준선: 5.5cm</span><br><button onclick="window.print()">출력</button><button onclick="window.close()">닫기</button></div>
    <div id="metadata" style="display:none">${html([record.record_date,record.vehicle_no,record.employee_name].filter(Boolean).join(' · '))}</div><img id="source" src="${record.image}" alt="온도기록지"><main id="pages"></main><script>
      async function prepare(){
        const source=document.getElementById('source');if(!source.complete)await new Promise((resolve,reject)=>{source.onload=resolve;source.onerror=reject;});
        if(!source.naturalWidth)throw new Error('기록지를 불러올 수 없습니다.');
        const height=55*source.naturalHeight/source.naturalWidth,parts=Math.ceil(height/260),pages=document.getElementById('pages');
        for(let start=0;start<parts;start+=3){
          const sheet=document.createElement('section');sheet.className='sheet';
          const heading=document.createElement('div');heading.className='heading';heading.textContent=document.getElementById('metadata').textContent;
          const ruler=document.createElement('span');ruler.className='ruler';ruler.textContent='55mm 확인선 · 배율 100%';heading.append(document.createElement('br'),ruler);sheet.append(heading);
          const columns=document.createElement('div');columns.className='columns';sheet.append(columns);
          for(let i=start;i<Math.min(start+3,parts);i++){
            const segment=document.createElement('div');segment.className='segment';const caption=document.createElement('div');caption.className='caption';caption.textContent='온도기록지 · '+(i+1)+' / '+parts;
            const cut=document.createElement('div');cut.className='cut';cut.style.height=Math.min(260,height-i*260)+'mm';const image=new Image();image.src=source.src;image.alt='온도기록지 '+(i+1);image.style.top=(-i*260)+'mm';image.style.height=height+'mm';cut.append(image);segment.append(caption,cut);columns.append(segment);
          }pages.append(sheet);
        }
        await Promise.all([...pages.querySelectorAll('img')].map(image=>image.decode()));document.documentElement.dataset.printReady='true';window.focus();window.print();
      }prepare().catch(()=>{document.getElementById('pages').textContent='기록지를 불러오지 못했습니다. 창을 닫고 다시 열어주세요.';});
    </script></body></html>`;
  }
  function openPrint(record){
    const doc=buildPrintDocument(record),popup=root.open('','_blank','width=900,height=900');if(!popup)return false;
    popup.opener=null;popup.document.open();popup.document.write(doc);popup.document.close();return true;
  }
  root.DBMTTemperatureRecord={loadPhoto,detectPaper,cropPaper,rotatePhoto,validCorners,defaultCorners,buildPrintDocument,openPrint};
})(window);
