// ============================================================================
// 铁海 1942 — 内联 SVG 图标集
//
// 舰桥界面里所有"图标"都走这里：线性几何图形、currentColor 上色、无 emoji、
// 无外部资源（保持零依赖）。icon(name, size) 返回可直接拼进 innerHTML 的字符串。
//
// 约定：
//   · viewBox 0 0 24 24；fill=none / stroke=currentColor / 线宽 1.8 / 圆头圆角
//   · 尺寸只由 width/height 控制，颜色继承父级 color，方便 CSS 统一调配
//   · 未知 name 回落 panel 图形，绝不返回空串导致布局塌陷
// ============================================================================

const ICONS = {
  // 关闭 / 取消
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  // 舰船：舰体 + 上层建筑 + 桅杆
  ship: '<path d="M3 14.5h18l-2.2 3.8a2 2 0 0 1-1.7 1H6.9a2 2 0 0 1-1.7-1L3 14.5Z"/><path d="M8 14.5V8h4l3 3.5"/><path d="M12 8V4.5"/>',
  // 目标：同心环 + 方位刻度
  target: '<circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="2.4"/><path d="M12 2.5v3.6M12 17.9v3.6M2.5 12h3.6M17.9 12h3.6"/>',
  // 航迹：折线 + 采样点
  track: '<path d="M3.5 17.5l5-7 5.2 3.6 6.8-9"/><circle cx="3.5" cy="17.5" r="1.2"/><circle cx="8.5" cy="10.5" r="1.2"/><circle cx="13.7" cy="14.1" r="1.2"/>',
  // 航向：罗经 + 指针
  course: '<circle cx="12" cy="12" r="8.5"/><path d="M15.6 8.4l-2.4 5.6-5.6 2.4 2.4-5.6 5.6-2.4Z"/>',
  // 航速：车钟表盘
  speed: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4.2-5.4"/><circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none"/>',
  // 开火：爆点
  fire: '<circle cx="12" cy="12" r="2.4"/><path d="M12 3.5v3.4M12 17.1v3.4M3.5 12h3.4M17.1 12h3.4M6 6l2.4 2.4M15.6 15.6L18 18M18 6l-2.4 2.4M8.4 15.6L6 18"/>',
  // 鱼雷：雷体 + 尾鳍
  torpedo: '<rect x="5" y="9.8" width="12" height="4.4" rx="2.2"/><path d="M17 9.8l3.5 2.2-3.5 2.2"/><path d="M5 9.8L3 7.4M5 14.2L3 16.6"/>',
  // 停火：禁止符号
  ceasefire: '<circle cx="12" cy="12" r="8"/><path d="M6.4 6.4l11.2 11.2"/>',
  // 烟幕：烟团
  smoke: '<path d="M7.6 17.5a4.1 4.1 0 0 1-.6-8.1 5.1 5.1 0 0 1 9.9 1.5 3.6 3.6 0 0 1-.5 6.6H7.6Z"/>',
  // 雷达：天线 + 电波
  radar: '<path d="M12 20.5v-6.5"/><path d="M12 14L5.6 9.6"/><circle cx="12" cy="14" r="1.3"/><path d="M7.6 5.4a7.6 7.6 0 0 1 8.8 0"/><path d="M4.6 8.4a11.4 11.4 0 0 1 14.8 0"/>',
  // 探照灯：灯罩 + 光束
  searchlight: '<path d="M9 3.5h6l-1.6 6.5H10.6L9 3.5Z"/><path d="M10.6 10L6 20.5M13.4 10L18 20.5M12 10v3.2"/>',
  // 损管：盾牌 + 对勾
  dc: '<path d="M12 3.2l7 2.9v6c0 4.1-2.9 7.5-7 8.7-4.1-1.2-7-4.6-7-8.7V6.1l7-2.9Z"/><path d="M9.4 12.1l1.9 1.9 3.4-3.6"/>',
  // 撤退：离框箭头
  withdraw: '<path d="M14.5 4.5h3.5A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-3.5"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h8.5"/>',
  // 信号日志：文档 + 行
  log: '<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h4"/>',
  // 面板：分栏窗口
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/><path d="M12.5 9h5M12.5 13h5"/>',
  // 时间 / 回放：时钟
  time: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
  // 暂停：双竖条
  pause: '<path d="M9.2 5.5v13M14.8 5.5v13"/>',
  // 取景：四角框
  frame: '<path d="M4 9V5.8A1.8 1.8 0 0 1 5.8 4H9"/><path d="M15 4h3.2A1.8 1.8 0 0 1 20 5.8V9"/><path d="M20 15v3.2a1.8 1.8 0 0 1-1.8 1.8H15"/><path d="M9 20H5.8A1.8 1.8 0 0 1 4 18.2V15"/>',
  // 观战：眼睛
  spectate: '<path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="2.9"/>',
  // 帮助：问号
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.6a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .9-1 1.6v.4"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/>',
  // 导出：向下箭头 + 托盘
  export: '<path d="M12 3.5v10.5"/><path d="M8 10.2l4 4 4-4"/><path d="M4.5 16.5v2.2A1.8 1.8 0 0 0 6.3 20.5h11.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/>',
  // 战役剧本：折页地图
  scenario: '<path d="M9 3.8L3.5 6.2v13.8L9 17.6l6 2.4 5.5-2.4V3.8L15 6.2 9 3.8Z"/><path d="M9 3.8v13.8M15 6.2v13.8"/>',
  // 命令 / 指挥：旗语旗
  orders: '<path d="M6.5 20.5V3.5"/><path d="M6.5 4.5h11l-2.6 3.8 2.6 3.8h-11"/>',
};

/**
 * 生成内联 SVG 图标。
 * @param {string} name ICONS 里的图标名；未知名回落 panel
 * @param {number} [size=14] 宽高（px）
 * @returns {string} 可直接插入 innerHTML 的 <svg> 字符串
 */
export function icon(name, size = 14) {
  const body = ICONS[name] || ICONS.panel;
  const s = Number(size) > 0 ? Number(size) : 14;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
}
