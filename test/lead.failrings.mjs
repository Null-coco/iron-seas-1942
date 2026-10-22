import fs from 'node:fs';
import { Land } from '/Users/zl/coco/naval/src/sim/land.js';
const landData = JSON.parse(fs.readFileSync('/Users/zl/coco/naval/data/land.json','utf8'));
const area=(r)=>{let a=0;for(let i=0,j=r.length-1;i<r.length;j=i++)a+=(r[j][0]*r[i][1]-r[i][0]*r[j][1]);return Math.abs(a/2);};
const buckets={}; const failAreas=[];
for (const id of Object.keys(landData.scenarios)) {
  const rings=landData.scenarios[id].rings, land=new Land(landData.scenarios[id]);
  for (const r of rings) {
    if (area(r)>=200000) continue;
    const ys=r.map(p=>p[1]); const yMid=(Math.min(...ys)+Math.max(...ys))/2;
    const xs=[]; for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[j],b=r[i]; if((a[1]>yMid)!==(b[1]>yMid)) xs.push(a[0]+(yMid-a[1])*(b[0]-a[0])/(b[1]-a[1]));}
    xs.sort((p,q)=>p-q);
    const cx = xs.length>=2 ? (xs[0]+xs[1])/2 : r[0][0];
    if (land.isLandExact(cx, yMid)) continue;
    const a=area(r);
    const k = a<100?'<100m2':(a<1000?'<1000m2':(a<10000?'<1e4m2':'<2e5m2'));
    buckets[k]=(buckets[k]||0)+1;
    if (failAreas.length<5) failAreas.push({id, area:Math.round(a), verts:r.length, span:Math.round(Math.max(...r.map(p=>p[0]))-Math.min(...r.map(p=>p[0])))+'x'+Math.round(Math.max(...ys)-Math.min(...ys))});
  }
}
console.log('点判定失败的环，按面积分布：', JSON.stringify(buckets));
console.log('样例：', JSON.stringify(failAreas));
