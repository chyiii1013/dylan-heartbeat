const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  hasParseableTimestamp,
  hasRealUserContent,
  lastUserTimeFromMessages,
  pickLatestDate,
  readAnchor,
  writeAnchor
} = require("../last_user_anchor");

function tmpAnchorPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-"));
  return path.join(dir, "last_user_time.json");
}

test("hasRealUserContent：空串和 <system> 注入都不算用户说话", () => {
  assert.equal(hasRealUserContent([]), false);
  assert.equal(hasRealUserContent([""]), false);
  assert.equal(hasRealUserContent(["   "]), false);
  assert.equal(hasRealUserContent(["<system>记忆库使用策略</system>"]), false);
  assert.equal(hasRealUserContent(["  <system>2026年9月17日</system>"]), false);
});

test("hasRealUserContent：真消息、图片、文件都算用户说话", () => {
  assert.equal(hasRealUserContent(["姐姐在吗"]), true);
  assert.equal(hasRealUserContent(["[图片]"]), true);
  assert.equal(hasRealUserContent(["[文件]"]), true);
  assert.equal(
    hasRealUserContent(["<system>注入</system>", "姐姐我今天好累"]),
    true
  );
});

test("hasParseableTimestamp：认得出英文数字格式，认不出中文日期", () => {
  assert.equal(hasParseableTimestamp("2026-09-17 20:04 姐姐在吗"), true);
  assert.equal(hasParseableTimestamp("（2026-09-17 20:04 姐姐在吗"), true);
  assert.equal(hasParseableTimestamp("2026/9/7 9:05"), true);
  assert.equal(hasParseableTimestamp("2026年9月17日 姐姐在吗"), false);
  assert.equal(hasParseableTimestamp("姐姐在吗"), false);
});

test("lastUserTimeFromMessages：倒着找，跳过挖不出时间的 user 消息", () => {
  const messages = [
    { role: "system", content: "SP" },
    { role: "user", content: "2026-09-15 10:00 老消息" },
    { role: "assistant", content: "2026-09-16 07:22 自动唤醒：本次未发送推送" },
    { role: "user", content: "没有时间戳的消息" }
  ];
  const parsed = lastUserTimeFromMessages(
    messages,
    text => (hasParseableTimestamp(text) ? new Date("2026-09-15T02:00:00.000Z") : null)
  );
  assert.equal(parsed.toISOString(), "2026-09-15T02:00:00.000Z");
});

test("lastUserTimeFromMessages：一条 user 都没有时返回 null", () => {
  const messages = [
    { role: "system", content: "SP" },
    { role: "assistant", content: "（2026-09-16 07:22 自动唤醒：本次未发送推送）" }
  ];
  const parsed = lastUserTimeFromMessages(messages, () => new Date());
  assert.equal(parsed, null);
});

test("lastUserTimeFromMessages：认不出时间戳的解析器不会误报", () => {
  const messages = [{ role: "user", content: "姐姐在吗" }];
  assert.equal(lastUserTimeFromMessages(messages, () => null), null);
});

test("pickLatestDate：锚点旧就听时间线的，时间线瞎了就听锚点的", () => {
  const older = new Date("2026-09-15T02:00:00.000Z");
  const newer = new Date("2026-09-17T12:51:00.000Z");
  assert.equal(pickLatestDate(older, newer).toISOString(), newer.toISOString());
  assert.equal(pickLatestDate(newer, older).toISOString(), newer.toISOString());
  assert.equal(pickLatestDate(null, newer).toISOString(), newer.toISOString());
  assert.equal(pickLatestDate(older, null).toISOString(), older.toISOString());
  assert.equal(pickLatestDate(null, null), null);
  assert.equal(pickLatestDate(new Date("bad"), null), null);
});

test("writeAnchor / readAnchor：往返不丢时刻", () => {
  const anchorPath = tmpAnchorPath();
  const date = new Date("2026-09-17T12:51:05.000Z");
  writeAnchor(anchorPath, date, { source: "chat" });
  const payload = JSON.parse(fs.readFileSync(anchorPath, "utf-8"));
  assert.equal(payload.iso, "2026-09-17T12:51:05.000Z");
  assert.equal(payload.source, "chat");
  assert.equal(readAnchor(anchorPath).toISOString(), date.toISOString());
});

test("readAnchor：文件不存在或内容坏掉都安静返回 null", () => {
  const anchorPath = tmpAnchorPath();
  assert.equal(readAnchor(anchorPath), null);
  fs.writeFileSync(anchorPath, "{ 这不是 json", "utf-8");
  assert.equal(readAnchor(anchorPath), null);
  fs.writeFileSync(anchorPath, JSON.stringify({ iso: "不是时间" }), "utf-8");
  assert.equal(readAnchor(anchorPath), null);
  fs.writeFileSync(anchorPath, JSON.stringify({}), "utf-8");
  assert.equal(readAnchor(anchorPath), null);
});

test("writeAnchor：非法时刻不写盘", () => {
  const anchorPath = tmpAnchorPath();
  assert.equal(writeAnchor(anchorPath, new Date("bad")), null);
  assert.equal(fs.existsSync(anchorPath), false);
});
