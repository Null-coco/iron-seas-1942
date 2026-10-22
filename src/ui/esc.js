// HTML 转义（UI 文本安全）
export function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"\']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
