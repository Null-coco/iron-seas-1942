// 事件总线 + 可回放日志。所有仿真状态变化都从这里出去。
export class EventBus {
  constructor(limit = 20000) { this.handlers = new Map(); this.history = []; this.limit = limit; this.seq = 0; }
  on(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); return () => this.off(type, fn); }
  off(type, fn) { const s = this.handlers.get(type); if (s) s.delete(fn); }
  onAny(fn) { return this.on('*', fn); }
  emit(type, payload = {}) {
    const ev = { seq: ++this.seq, type, t: payload.t !== undefined ? payload.t : null, ...payload };
    this.history.push(ev);
    if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit);
    const s = this.handlers.get(type); if (s) for (const f of s) { try { f(ev); } catch (e) { console.error('[event]', type, e); } }
    const a = this.handlers.get('*'); if (a) for (const f of a) { try { f(ev); } catch (e) { console.error('[event*]', type, e); } }
    return ev;
  }
  // 回放用：取某时间窗事件
  since(seq) { return this.history.filter((e) => e.seq > seq); }
  clear() { this.history.length = 0; this.seq = 0; }
}
