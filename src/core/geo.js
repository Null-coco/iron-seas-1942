// 局部切平面 ↔ 经纬度。以 origin 为原点，x=东(m)，y=北(m)。
import { DEG } from './util.js';
export class GeoPlane {
  constructor(originLat = 0, originLon = 0) {
    this.lat0 = originLat; this.lon0 = originLon;
    this.mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * DEG * originLat) + 1.175 * Math.cos(4 * DEG * originLat);
    this.mPerDegLon = 111412.84 * Math.cos(DEG * originLat) - 93.5 * Math.cos(3 * DEG * originLat);
  }
  toLatLon(x, y) { return { lat: this.lat0 + y / this.mPerDegLat, lon: this.lon0 + x / this.mPerDegLon }; }
  fromLatLon(lat, lon) { return { x: (lon - this.lon0) * this.mPerDegLon, y: (lat - this.lat0) * this.mPerDegLat }; }
  // 大圆距离（用于剧本录入校验）
  static greatCircleM(a, b) {
    const R = 6371000, dLat = DEG * (b.lat - a.lat), dLon = DEG * (b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(DEG * a.lat) * Math.cos(DEG * b.lat) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
}
