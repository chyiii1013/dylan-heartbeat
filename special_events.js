// 批注 2026-08-10：特殊事件必须从“带时间戳的事件消息开头”识别；
// 普通回答即使讨论了推送、Bark 或自动唤醒，也不能被截成真实事件反复注入。
const SPECIAL_EVENT_PREFIX = /^\s*[（(]\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}(?::\d{2})?\s+(?:自动唤醒：本次未发送(?:\s*(?:Bark|推送))?|刚刚发送了推送|刚刚给(?:宝宝|用户)发了\s*(?:Bark|ntfy)?\s*推送|刚刚给(?:宝宝|用户)发了\s*Bark)(?:[：:｜|）)]|\s|$)/i;

function isSpecialEventContent(content) {
  return SPECIAL_EVENT_PREFIX.test(String(content || ""));
}

// 批注 2026-08-31：识别「本次未发送推送」的状态占位。
// 这类内容（如「（2026-08-31 05:00 自动唤醒：本次未发送推送｜原因：她凌晨才睡，不吵她）」）
// 是系统写给用户看的状态日志，不是 AI 对用户说的话。
// 若把它当作 assistant 历史注入对话，模型会误以为回复就该长这样，从而把占位格式直接当回复输出。
function isNoPushPlaceholderEvent(content) {
  return /自动唤醒[:：]\s*本次未发送/.test(String(content || ""));
}

module.exports = { isSpecialEventContent, SPECIAL_EVENT_PREFIX, isNoPushPlaceholderEvent };
