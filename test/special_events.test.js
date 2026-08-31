const test = require("node:test");
const assert = require("node:assert/strict");
const { isSpecialEventContent, isNoPushPlaceholderEvent } = require("../special_events");

test("accepts real timestamped wake events", () => {
  assert.equal(isSpecialEventContent("（2026-08-10 20:10 自动唤醒：本次未发送推送｜原因：不打扰）"), true);
  assert.equal(isSpecialEventContent("（2026/8/10 20:10:03 刚刚给用户发了Bark推送：标题｜正文）"), true);
  assert.equal(isSpecialEventContent("（2026-08-10 20:10 刚刚给宝宝发了 Bark：测试）"), true);
});

test("does not turn ordinary replies mentioning event words into events", () => {
  assert.equal(isSpecialEventContent("我刚刚给用户发了推送，不过这只是回答里的说明。"), false);
  assert.equal(isSpecialEventContent("2026-08-10 20:10 我觉得‘自动唤醒：本次未发送推送’这句话很奇怪。"), false);
});

// 批注 2026-08-31：修复「网关把自动唤醒占位当成回复」的回归测试。
test("flags '本次未发送推送' placeholders as state logs (never injected into chat)", () => {
  assert.equal(isNoPushPlaceholderEvent("（2026-08-31 05:00 自动唤醒：本次未发送推送｜原因：她凌晨才睡，不吵她）"), true);
  assert.equal(isNoPushPlaceholderEvent("（2026-08-30 23:40 自动唤醒：本次未发送推送）"), true);
  assert.equal(isNoPushPlaceholderEvent("（2026-08-31 05:00 自动唤醒：本次未发送Bark）"), true);
});

test("does not mistake actually-pushed events for no-push placeholders", () => {
  assert.equal(isNoPushPlaceholderEvent("（2026-08-30 18:00 刚刚给用户发了ntfy推送：标题｜正文）"), false);
  assert.equal(isNoPushPlaceholderEvent("（2026-08-10 20:10 刚刚给宝宝发了Bark推送：标题｜正文）"), false);
});
