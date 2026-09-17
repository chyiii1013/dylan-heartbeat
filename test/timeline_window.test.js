const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MAX_REAL,
  DEFAULT_MAX_TOTAL,
  findNewestUserIndex,
  selectTimelineWindow
} = require("../timeline_window");

const isSpecial = msg => msg.role === "assistant" && /自动唤醒|发了推送/.test(String(msg.content));
const event = i => ({ role: "assistant", content: `（2026-09-15 0${i}:15 自动唤醒：本次未发送推送）` });
const real = (role, text) => ({ role, content: text });

test("findNewestUserIndex：找最后一条用户消息", () => {
  assert.equal(findNewestUserIndex([]), -1);
  assert.equal(findNewestUserIndex([{ role: "assistant", content: "a" }]), -1);
  assert.equal(
    findNewestUserIndex([{ role: "user", content: "1" }, { role: "assistant", content: "2" }, { role: "user", content: "3" }]),
    2
  );
});

test("复现事故：49 条唤醒事件 + 40 条真实对话 → 对话必须活下来", () => {
  const events = Array.from({ length: 49 }, (_, i) => event(i));
  const conversation = Array.from({ length: 40 }, (_, i) => real(i % 2 ? "assistant" : "user", `第 ${i} 句`));
  // 现场顺序和事故时一样：真实对话在前，事件全被挤到后面
  const timeline = [...conversation, ...events];

  const kept = selectTimelineWindow(timeline, { isSpecial });
  const keptReal = kept.filter(msg => !isSpecial(msg));
  const keptSpecial = kept.filter(isSpecial);

  assert.equal(kept.length, DEFAULT_MAX_TOTAL);
  assert.equal(keptReal.length, DEFAULT_MAX_REAL);
  assert.equal(keptSpecial.length, DEFAULT_MAX_TOTAL - DEFAULT_MAX_REAL);
  // 保留的是最近的那些
  assert.equal(keptReal[keptReal.length - 1].content, "第 39 句");
  assert.equal(keptSpecial[keptSpecial.length - 1].content, event(48).content);
  // 一条用户消息都没有的情况必须消失
  assert.ok(kept.some(msg => msg.role === "user"));
});

test("对话很短时，事件可以多留一些（额度让给事件）", () => {
  const events = Array.from({ length: 49 }, (_, i) => event(i));
  const kept = selectTimelineWindow([real("user", "姐姐在吗"), real("assistant", "在"), ...events], { isSpecial });
  assert.equal(kept.length, DEFAULT_MAX_TOTAL);
  assert.equal(kept.filter(msg => !isSpecial(msg)).length, 2);
  assert.equal(kept.filter(isSpecial).length, DEFAULT_MAX_TOTAL - 2);
});

test("顺序不变：保留的条目按原顺序排列", () => {
  const list = [real("user", "A"), event(1), real("assistant", "B"), event(2), real("user", "C")];
  const kept = selectTimelineWindow(list, { isSpecial });
  assert.deepEqual(kept.map(msg => msg.content), ["A", event(1).content, "B", event(2).content, "C"]);
});

test("只留真实对话时也不会超过上限", () => {
  const conversation = Array.from({ length: 120 }, (_, i) => real("user", `第 ${i} 句`));
  const kept = selectTimelineWindow(conversation, { isSpecial });
  assert.equal(kept.length, DEFAULT_MAX_REAL);
  assert.equal(kept[kept.length - 1].content, "第 119 句");
});

test("空数组和坏输入都安静返回", () => {
  assert.deepEqual(selectTimelineWindow([]), []);
  assert.deepEqual(selectTimelineWindow(null), []);
  assert.deepEqual(selectTimelineWindow(undefined, { isSpecial: null }), []);
});
