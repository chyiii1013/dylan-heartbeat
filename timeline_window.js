// ========================
// 时间线的保留窗口
// ========================
// 批注 2026-09-17：saveTimeline 以前是一刀切 slice(-49)。
// 而唤醒事件（「自动唤醒：本次未发送推送」「刚刚给了发了推送」）会一天天攒起来、
// 又总是排在真实对话后面，于是攒到 49 条的那天，整段对话会被挤出时间线：
// 管理页显示「你 0 条 / 我 49 条」，唤醒被叫起来时手里只有一串状态日志，
// 没有一句真的对话——说出来的话当然是驴唇不对马嘴。
//
// 这是慢慢积起来的病，不是突然坏的。所以窗口要分开算：
// 对话是主体（至少留 maxReal 条），事件是装饰（占剩下的额度，最新的优先）。

const DEFAULT_MAX_TOTAL = 49;
const DEFAULT_MAX_REAL = 32;

// 最新一条用户消息在数组里的位置；找不到返回 -1。
function findNewestUserIndex(list) {
  const messages = Array.isArray(list) ? list : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === "user") return i;
  }
  return -1;
}

// 从 messages 里挑出要留下的那些，保持原顺序，总数不超过 maxTotal。
function selectTimelineWindow(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const maxTotal = Number.isFinite(options.maxTotal) ? options.maxTotal : DEFAULT_MAX_TOTAL;
  const maxReal = Number.isFinite(options.maxReal) ? options.maxReal : DEFAULT_MAX_REAL;
  const isSpecial = typeof options.isSpecial === "function" ? options.isSpecial : () => false;

  const real = list.filter(msg => !isSpecial(msg));
  const special = list.filter(msg => isSpecial(msg));

  const keptReal = real.slice(-Math.max(0, maxReal));
  const roomForSpecial = Math.max(0, maxTotal - keptReal.length);
  const keptSpecial = special.slice(-roomForSpecial);

  const keep = new Set([...keptReal, ...keptSpecial]);
  return list.filter(msg => keep.has(msg));
}

module.exports = {
  DEFAULT_MAX_TOTAL,
  DEFAULT_MAX_REAL,
  findNewestUserIndex,
  selectTimelineWindow
};
