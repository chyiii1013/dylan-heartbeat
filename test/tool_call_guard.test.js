const test = require("node:test");
const assert = require("node:assert/strict");
const { looksLikeToolCall, splitToolCallText } = require("../tool_call_guard");

const dsmlPush = `<||DSML||calls>
<||DSML||invoke name="workspace_shell"><||DSML||parameter name="command" string="true">ls -la /workspace</||DSML||parameter></||DSML||invoke></||DSML||calls>`;

test("复现事故：2026-09-19 早上那条推送里的 DSML 工具调用", () => {
  assert.equal(looksLikeToolCall(dsmlPush), true);
  const result = splitToolCallText(dsmlPush);
  assert.equal(result.hadToolCall, true);
  assert.equal(result.text, "");
});

test("标记前面的真话要留下", () => {
  const result = splitToolCallText(`我想看看姐姐的日记。\n${dsmlPush}`);
  assert.equal(result.hadToolCall, true);
  assert.equal(result.text, "我想看看姐姐的日记。");
});

test("认得出别的工具调用格式", () => {
  assert.equal(looksLikeToolCall('<tool_call>{"name":"x"}</tool_call>'), true);
  assert.equal(looksLikeToolCall("<function_calls>\n<invoke name=..."), true);
  assert.equal(looksLikeToolCall("antml:invoke name=\"workspace_read_file\""), true);
  assert.equal(looksLikeToolCall('{"tool_calls": [{"id": "1"}]}'), true);
  assert.equal(looksLikeToolCall("||DSML||invoke"), true);
});

test("正常的话一个字都不动", () => {
  const normal = "小狗，五点半了。醒了就哼一声，让我知道你还在。";
  assert.equal(looksLikeToolCall(normal), false);
  const result = splitToolCallText(normal);
  assert.equal(result.hadToolCall, false);
  assert.equal(result.text, normal);
});

test("空输入和坏输入都安静返回", () => {
  assert.deepEqual(splitToolCallText(""), { text: "", hadToolCall: false });
  assert.deepEqual(splitToolCallText(null), { text: "", hadToolCall: false });
  assert.deepEqual(splitToolCallText(undefined), { text: "", hadToolCall: false });
});

test("只有空白的内容会被清成空串", () => {
  assert.equal(splitToolCallText("   \n  ").text, "");
});
