// 舰船数据库：把 data/ships_*.json 变成可用的查询接口。
export class ShipDatabase {
  constructor() { this.byId = new Map(); this.byClass = new Map(); this.list = []; }
  static fromObject(obj) {
    const db = new ShipDatabase();
    const ships = Array.isArray(obj) ? obj : (obj && obj.ships) || [];
    for (const s of ships) {
      if (!s || !s.id) continue;
      s._id = String(s.id).toLowerCase();
      db.byId.set(s._id, s);
      db.list.push(s);
      const cls = (s.class || s.id).toLowerCase();
      if (!db.byClass.has(cls)) db.byClass.set(cls, []);
      db.byClass.get(cls).push(s);
    }
    return db;
  }
  static fromMany(objs) {
    const db = new ShipDatabase();
    for (const o of objs) {
      const part = ShipDatabase.fromObject(o);
      for (const s of part.list) {
        if (db.byId.has(s._id)) continue;
        db.byId.set(s._id, s); db.list.push(s);
        const cls = (s.class || s.id).toLowerCase();
        if (!db.byClass.has(cls)) db.byClass.set(cls, []);
        db.byClass.get(cls).push(s);
      }
    }
    return db;
  }
  get(id) { if (!id) return null; const k = String(id).toLowerCase(); return this.byId.get(k) || null; }
  byType(t) { return this.list.filter((s) => s.type === t); }
  byNation(n) { return this.list.filter((s) => s.nation === n); }
  // 剧本里 'class:Yamato' / 'id:yamato' 都能解析
  resolve(ref) {
    if (!ref) return null;
    if (typeof ref === 'object') return ref;
    const str = String(ref);
    if (str.startsWith('class:')) {
      const arr = this.byClass.get(str.slice(6).toLowerCase());
      return arr && arr.length ? arr[0] : null;
    }
    if (str.startsWith('id:')) return this.get(str.slice(3));
    return this.get(str) || (this.byClass.get(str.toLowerCase()) || [null])[0];
  }
}
