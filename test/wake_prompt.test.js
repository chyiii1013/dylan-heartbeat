const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const promptPath = path.join(__dirname, "..", "wake_prompt.txt");
const hasPrompt = fs.existsSync(promptPath);

// wake_prompt.txt 是本地配置（.gitignore 明确忽略，不走版本控制），
// 干净 clone 后不一定存在；存在才验证占位符契约，避免测试在无该文件的仓库上失败。
test("wake_prompt.txt exists and is non-empty", { skip: !hasPrompt }, () => {
  const text = fs.readFileSync(promptPath, "utf-8");
  assert.ok(text.trim().length > 0);
});

test("wake_prompt.txt keeps all placeholders the builder replaces", { skip: !hasPrompt }, () => {
  const text = fs.readFileSync(promptPath, "utf-8");
  for (const ph of ["${currentTime}", "${diffMinutes}", "${weather}"]) {
    assert.ok(text.includes(ph), `should contain ${ph}`);
  }
  const rendered = text
    .replace(/\$\{currentTime\}/g, "2026-08-31 18:00")
    .replace(/\$\{diffMinutes\}/g, "120")
    .replace(/\$\{weather\}/g, "## 天气信息\n- 位置：Hong Kong");
  assert.ok(!rendered.includes("${"), "rendered prompt should have no leftover placeholders");
});
