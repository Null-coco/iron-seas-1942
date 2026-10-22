// 回放播放器：读 world.exportReplay()，按时间轴重建海图（快照插值）。
// 面板节点一次性建好、只改数值，避免重渲染把正在按的按钮换掉（旧版会在同一处反复 innerHTML）。
export class ReplayPlayer {
  constructor(data, chart, onUpdate) {
    this.data = data; this.chart = chart; this.onUpdate = onUpdate || (() => {});
    this.t = 0; this.speed = 1; this.playing = true;
    this.total = Math.max(1, Math.round(data.endedAt || 0));
    this.el = this._panel();
    const host = document.getElementById('chartWrap');
    (host || document.body).appendChild(this.el);
    this._wire();
    this._paint();
  }

  _panel() {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:12px;z-index:12;' +
      'background:linear-gradient(180deg,rgba(14,25,39,.97),rgba(8,14,23,.97));border:1px solid rgba(175,210,248,.34);' +
      'border-radius:9px;padding:9px 12px;box-shadow:0 14px 40px rgba(0,0,0,.6);font:11.5px/1.5 ' +
      'ui-monospace,"SF Mono",Menlo,monospace;color:#b7c9db;min-width:560px;max-width:calc(100% - 24px)';
    const btn = 'height:28px;padding:0 9px;border-radius:6px;background:#152334;border:1px solid rgba(155,195,235,.19);color:#b7c9db;cursor:pointer;font:inherit';
    d.innerHTML =
      '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:7px">' +
        '<b style="color:#f4dfb1;letter-spacing:1.4px;font-size:11px">回放</b>' +
        '<span id="rpT">t=0s</span>' +
        '<span style="color:#617787">总时长 ' + this.total + 's · 事件 ' + ((this.data.events || []).length) + ' 条</span>' +
        '<span style="flex:1"></span>' +
        '<button id="rpClose" style="' + btn + '">退出回放</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<button id="rpPlay" style="width:56px;' + btn + ';border-color:rgba(217,180,120,.4);color:#f4dfb1">暂停</button>' +
        '<input id="rpRange" type="range" min="0" max="' + this.total + '" value="0" style="flex:1;min-width:220px;accent-color:#d9b478">' +
        '<div style="display:flex;gap:4px">' +
          '<button id="rpS" style="' + btn + '">1×</button>' +
          '<button id="rpF" style="' + btn + '">8×</button>' +
          '<button id="rpX" style="' + btn + '">16×</button>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:6px;color:#617787;font-size:10.5px">拖动时间轴回溯。回放显示的是交战当时的<b style="color:#8598ad">已知航迹快照</b>，不是上帝视角。</div>';
    return d;
  }

  _wire() {
    const q = (id) => (this.el.querySelector ? this.el.querySelector('#' + id) : null);
    const range = q('rpRange');
    if (range) range.addEventListener('input', (e) => { this.t = +e.target.value; });
    const play = q('rpPlay');
    if (play) play.addEventListener('click', () => { this.playing = !this.playing; play.textContent = this.playing ? '暂停' : '播放'; });
    const s1 = q('rpS'), s8 = q('rpF'), s16 = q('rpX');
    const mark = (n) => {
      [s1, s8, s16].forEach((b) => { if (b) b.style.borderColor = 'rgba(155,195,235,.19)'; });
      const b = n === 1 ? s1 : n === 8 ? s8 : s16;
      if (b) b.style.borderColor = 'rgba(217,180,120,.6)';
    };
    if (s1) s1.addEventListener('click', () => { this.speed = 1; mark(1); });
    if (s8) s8.addEventListener('click', () => { this.speed = 8; mark(8); });
    if (s16) s16.addEventListener('click', () => { this.speed = 16; mark(16); });
    const c = q('rpClose');
    if (c) c.addEventListener('click', () => this.destroy());
    mark(1);
  }

  _paint() {
    const q = (id) => (this.el && this.el.querySelector ? this.el.querySelector('#' + id) : null);
    const range = q('rpRange');
    if (range && document.activeElement !== range) range.value = Math.round(this.t);
    const tl = q('rpT');
    if (tl) tl.textContent = 't=' + Math.round(this.t) + 's';
  }

  sample() {
    const snaps = this.data.snapshots || [];
    if (!snaps.length) return null;
    let prev = snaps[0], next = snaps[snaps.length - 1];
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].t <= this.t) prev = snaps[i];
      else { next = snaps[i]; break; }
    }
    const f = next.t === prev.t ? 0 : (this.t - prev.t) / (next.t - prev.t);
    const ships = prev.ships.map((s) => {
      const n = next.ships.find((x) => x.id === s.id) || s;
      return { id: s.id, x: s.x + (n.x - s.x) * f, y: s.y + (n.y - s.y) * f, hd: s.hd + (n.hd - s.hd) * f, af: s.af && n.af, list: s.list, name: s.id };
    });
    return { t: this.t, ships, env: prev.env };
  }

  tick(dt) {
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t > this.total) this.t = 0;
    }
    this._paint();
    const snap = this.sample();
    if (snap && this.chart) {
      // 用快照伪造一个只读 state 给海图（回放没有敌情不确定性，展示的是当时的已知航迹快照）
      this.chart.draw({ side: '__REPLAY__', tracks: [], environment: { lightLevel: 0.6 }, ships: snap.ships });
    }
    this.onUpdate(this.t);
  }

  destroy() {
    this.playing = false;
    if (this.el && this.el.remove) this.el.remove();
    this.el = null;
  }
}
