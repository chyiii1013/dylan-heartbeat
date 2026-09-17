const fs = require("fs");
const { writeJsonAtomicSync } = require("./runtime_paths");

// ========================
// 用户最后说话的时刻（唤醒锚点）
// ========================
// 批注 2026-09-17：wake_up 过去只能从时间线正文里正则挖时间戳，来判断
// 「用户多久没说话了」。但时间线是每次请求重建的：只要有一次请求里没有
// 真实用户消息（例如只有一条以 <system> 开头的注入，或一次工具续写），
// 历史 user 就会被整体抹掉。此后 wake_up 每一轮都卡在「未找到用户时间」，
// 推送和日记一起断，而且不会自愈——2026-09-16 那次就是这么断的。
//
// 这里把锚点独立出来，三件事合起来治本：
//   ① 护栏：请求里确实有用户说的话，才允许重建时间线；
//   ② 顺手：每次存盘把最后一条 user 消息的时刻写进 last_user_time.json；
//   ③ 兜底：wake_up 先读锚点文件，读不到才回退到挖正文。
// 正文被搞乱也不会再让唤醒失明。

const TIMESTAMP_RE = /（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/;

function hasParseableTimestamp(value) {
  return TIMESTAMP_RE.test(String(value == null ? "" : value));
}

// 「用户真的说了话」：非空，且不是以 <system> 开头的系统规则注入。
function hasRealUserContent(texts) {
  return (Array.isArray(texts) ? texts : []).some(text => {
    const value = String(text == null ? "" : text).trim();
    return value.length > 0 && !value.startsWith("<system>");
  });
}

function defaultGetText(msg) {
  const content = msg && msg.content;
  return typeof content === "string" ? content : "";
}

// 从时间线倒着找最新一条能解析出时间的 user 消息。
// parseTimestamp 由调用方注入（要按配置时区把墙上时间转成真实 Date）。
function lastUserTimeFromMessages(messages, parseTimestamp, getText = defaultGetText) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (!msg || msg.role !== "user") continue;
    if (typeof parseTimestamp !== "function") return null;
    const date = parseTimestamp(getText(msg));
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  return null;
}

// 时间线和锚点各说一个时刻时，取更晚的那个：锚点比时间线旧就听时间线的。
function pickLatestDate(a, b) {
  const left = a instanceof Date && !Number.isNaN(a.getTime()) ? a : null;
  const right = b instanceof Date && !Number.isNaN(b.getTime()) ? b : null;
  if (left && right) return left.getTime() >= right.getTime() ? left : right;
  return left || right || null;
}

function readAnchor(anchorPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(anchorPath, "utf-8"));
    const value = raw && (raw.iso || raw.at);
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function writeAnchor(anchorPath, date, meta = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const payload = { iso: date.toISOString(), at: date.getTime(), ...meta };
  writeJsonAtomicSync(anchorPath, payload);
  return payload;
}

module.exports = {
  TIMESTAMP_RE,
  hasParseableTimestamp,
  hasRealUserContent,
  lastUserTimeFromMessages,
  pickLatestDate,
  readAnchor,
  writeAnchor
};
