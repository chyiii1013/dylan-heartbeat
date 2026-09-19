// ========================
// 工具调用守卫
// ========================
// 批注 2026-09-19：后台唤醒跑在网关和 Termux 上，手里没有任何工具。但注入的
// system prompt 里带着 RikkaHub workspace 的用法（含 DSML 工具调用格式），
// 模型偶尔会照着它去调 `workspace_shell`——那段标记会被当成"想对她说的话"
// 原样推送到她手机上（2026-09-19 早上 06:58 和 08:58 两条推送就是这个）。
//
// 这里做两件事：认出工具调用标记；把标记之后的整块丢掉——标记之前通常是真话，
// 标记之后是它想去干活的动作。宁可这次只推前半句，也不推一整屏 XML。

const TOOL_CALL_START = /<\|+\s*DSML|\|\|\s*DSML\s*\|\||antml:invoke|<function_calls>|<tool_call>|"tool_calls"\s*:/i;

function looksLikeToolCall(text) {
  return TOOL_CALL_START.test(String(text == null ? "" : text));
}

function splitToolCallText(text) {
  const raw = String(text == null ? "" : text);
  const match = raw.match(TOOL_CALL_START);
  if (!match) return { text: raw.trim(), hadToolCall: false };
  return { text: raw.slice(0, match.index).trim(), hadToolCall: true };
}

module.exports = { TOOL_CALL_START, looksLikeToolCall, splitToolCallText };
