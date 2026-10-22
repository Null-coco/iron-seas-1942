import fs from 'node:fs';
import { Land } from '../src/sim/land.js';
const landData = JSON.parse(fs.readFileSync('data/land.json', 'utf8'));
const area = (ring) => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]); return Math.abs(a / 2); };
let totalRings = 0, smallRings = 0, tinyRings = 0, tested = 0, hitOk = 0, segOk = 0;
for (const id of Object.keys(landData.scenarios)) {
  const rings = landData.scenarios[id].rings;
  const land = new Land(landData.scenarios[id]);
  const small = rings.filter((r) => area(r) < 200000);            // < 0.2 km²
  const tiny = rings.filter((r) => area(r) < 20000);              // < 0.02 km²
  totalRings += rings.length; smallRings += small.length; tinyRings += tiny.length;
  for (const r of small) {
    // 取"扫描线中点"作为内部点：质心对凹形小岛可能落在岛外（那是测试方法问题，不是数据问题）
    const ys = r.map((p) => p[1]);
    const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;
    const xs = [];
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j], b = r[i];
      if ((a[1] > yMid) !== (b[1] > yMid)) xs.push(a[0] + (yMid - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    const cx = xs.length >= 2 ? (xs[0] + xs[1]) / 2 : r[0][0];
    const cy = yMid;
    tested++;
    if (land.isLandExact(cx, cy)) hitOk++;
    // 从岛外两侧穿过该岛的线段，必须被判为被遮蔽
    const a = { x: cx - 3000, y: cy }, b = { x: cx + 3000, y: cy };
    if (land.segmentBlocked(a, b)) segOk++;
  }
  if (small.length) console.log(id.padEnd(24) + ' 环 ' + String(rings.length).padStart(3) + ' 其中 <0.2km² ' + String(small.length).padStart(2) + '，<0.02km² ' + tiny.length);
}
console.log('\n合计：环 ' + totalRings + ' 个，其中 <0.2km² 的 ' + smallRings + ' 个，<0.02km² 的 ' + tinyRings + ' 个');
console.log('小岛点判定：' + hitOk + '/' + tested + ' 命中；穿越小岛的视线：' + segOk + '/' + tested + ' 被正确遮蔽');
console.log((hitOk === tested && segOk === tested) ? '✅ 小岛既挡船也挡视线（栅格漏掉的由精确判定兜底）' : '⚠️ 有 ' + (tested - hitOk) + ' 个点判定失败 / ' + (tested - segOk) + ' 个遮蔽失败');
