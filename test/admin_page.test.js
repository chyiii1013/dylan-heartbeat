// 批注 2026-09-17：管理页靠内联脚本撑起日历和备份交互，而内联脚本出错时页面只会变成
// 白板、服务端一点反应都没有。这里用一个极小的 DOM 桩把脚本真正跑起来，
// 把「日历排版」这类肉眼看不见的错挡在推送之前。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const { renderAdminPage, escapeHtml, safeJsonForInlineScript } = require("../admin_page");

const SAMPLE_CONTEXT = {
  serverUptime: 90902,
  wakeUpStatus: "在线（上次心跳: 2026-09-17 18:31）",
  runtimeConfigNotice: "",
  authToken: "YWRtaW46cHc=",
  presets: [],
  diary: { dates: ["2026-09-16", "2026-09-15", "2026-09-12"], today: "2026-09-17", latest: "2026-09-16" },
  config: {
    targetUrl: "https://api.example.com/v1/chat/completions",
    modelName: "some-model",
    customIcon: "",
    gatewayKeyStatus: "已配置",
    gatewayChatReasoning: "off",
    wakeReasoning: "on",
    diaryEnabled: "true",
    diaryDir: "diary",
    pushProvider: "bark",
    aiDisplayName: "来自姐姐",
    userDisplayName: "宝宝",
    ntfyServerUrl: "https://ntfy.sh",
    ntfyTopic: "",
    ntfyPriority: "",
    ntfyTags: "",
    allowPublicApi: "false",
    timeZone: "Asia/Hong_Kong",
    multimodalMode: "passthrough",
    pushTimeoutMs: "15000",
    wakeUpstreamTimeoutMs: "300000",
    requestBodyLimitMb: "50",
    dayWakeAfter: "60",
    nightWakeAfter: "120",
    dayCheckInterval: "10",
    nightCheckInterval: "120",
    dayStartHour: "10",
    dayEndHour: "24",
    weatherEnabled: "false",
    weatherLocationName: "",
    weatherLat: "",
    weatherLon: "",
    weatherUnits: "metric"
  }
};

function buildDom() {
  const nodes = new Map();
  function makeNode(id) {
    const classes = new Set();
    return {
      id,
      textContent: "",
      innerHTML: "",
      value: "",
      style: {},
      hidden: false,
      disabled: false,
      files: [],
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name); else classes.delete(name);
          return on;
        }
      },
      addEventListener() {},
      appendChild() {},
      removeChild() {},
      scrollIntoView() {},
      click() {}
    };
  }
  return {
    nodes,
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, makeNode(id));
        return nodes.get(id);
      },
      querySelectorAll() { return []; },
      createElement(tag) { return makeNode(tag); },
      body: { appendChild() {}, removeChild() {} }
    }
  };
}

function runPageScript(context = SAMPLE_CONTEXT) {
  const html = renderAdminPage(context);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "页面里应当有内联脚本");

  const dom = buildDom();
  const sandbox = {
    document: dom.document,
    fetch: () => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({ exists: false }),
      blob: () => Promise.resolve({})
    }),
    alert() {},
    confirm: () => false,
    setTimeout() {},
    Blob: function Blob() {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(scriptMatch[1], sandbox);
  return { html, dom, sandbox };
}

test("渲染出的页面没有模板残留，关键控件齐全", () => {
  const { html } = runPageScript();
  assert.equal(/\$\{[^}]*\}/.test(html), false, "不该漏出未插值的模板占位符");
  assert.match(html, /id="panel-diary"/);
  assert.match(html, /id="panel-settings"/);
  assert.match(html, /id="calendarGrid"/);
  assert.match(html, /id="btnExport"/);
  assert.match(html, /id="importFile"/);
  assert.match(html, /id="f_chat_reasoning"/);
  assert.match(html, /id="f_diary_enabled"/);
  assert.match(html, /id="f_push_provider"/);
  assert.match(html, /id="f_ntfy_topic"/);
  assert.match(html, /id="f_allow_public_api"/);
});

test("配置值写进表单前被转义", () => {
  const context = JSON.parse(JSON.stringify(SAMPLE_CONTEXT));
  context.config.customIcon = '"><script>alert(1)</script>';
  const { html } = runPageScript(context);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("&quot;&gt;&lt;script&gt;"), true);
});

test("日记列表为空时给出空状态，并禁用日历按钮", () => {
  const context = JSON.parse(JSON.stringify(SAMPLE_CONTEXT));
  context.diary = { dates: [], today: "2026-09-17", latest: null };
  const { dom } = runPageScript(context);
  assert.equal(dom.nodes.get("btnCalendar").disabled, true);
  assert.equal(dom.nodes.get("diaryDate").textContent, "还没有日记");
});

test("日历：周一为首列、空白格数量正确、只给有日记的日子打点", () => {
  const { dom, sandbox } = runPageScript();
  sandbox.showDiary("2026-09-16");
  sandbox.renderCalendar();

  const grid = dom.nodes.get("calendarGrid").innerHTML;
  const cells = grid.match(/<div class="cal-cell[^"]*"/g) || [];
  const blanks = grid.match(/<div class="cal-cell blank"/g) || [];
  const hasDiary = grid.match(/cal-cell has/g) || [];

  // 2026-09-01 是周二 -> 周一为首列时前面只有 1 个空白；9 月 30 天
  assert.equal(blanks.length, 1, "九月首日前应只有 1 个空白格");
  assert.equal(cells.length, 1 + 30);
  assert.equal(hasDiary.length, 3, "12 / 15 / 16 三天有日记");
  assert.equal(dom.nodes.get("calTitle").textContent, "2026 年 9 月");
});

test("日历：只有有日记的日期可点，选中态与今天标记都落在对的日子上", () => {
  const { dom, sandbox } = runPageScript();
  sandbox.showDiary("2026-09-16");
  sandbox.renderCalendar();
  const grid = dom.nodes.get("calendarGrid").innerHTML;

  assert.equal(grid.includes("onclick=\"showDiary('2026-09-16')\""), true);
  assert.equal(grid.includes("onclick=\"showDiary('2026-09-14')\""), false);
  assert.match(grid, /class="cal-cell today"[^>]*>17/);
  assert.match(grid, /class="cal-cell has selected"[^>]*>16/);
});

test("日历：跨年翻月不会算错年月", () => {
  const { dom, sandbox } = runPageScript();

  sandbox.showDiary("2026-01-15");
  sandbox.moveMonth(-1);
  assert.equal(dom.nodes.get("calTitle").textContent, "2025 年 12 月");

  sandbox.moveMonth(1);
  assert.equal(dom.nodes.get("calTitle").textContent, "2026 年 1 月");

  sandbox.moveMonth(11);
  assert.equal(dom.nodes.get("calTitle").textContent, "2026 年 12 月");
});

test("默认展示：今天有日记就显示今天，没有就退回最新一篇", () => {
  // 样例里 09-17 还没写日记 -> 应退回 09-16
  const withoutToday = runPageScript();
  assert.equal(withoutToday.dom.nodes.get("diaryDate").textContent.startsWith("2026-09-16"), true);

  // 今天写过了 -> 就显示今天
  const context = JSON.parse(JSON.stringify(SAMPLE_CONTEXT));
  context.diary.dates = ["2026-09-17", "2026-09-16", "2026-09-15"];
  context.diary.latest = "2026-09-17";
  const withToday = runPageScript(context);
  assert.equal(withToday.dom.nodes.get("diaryDate").textContent.startsWith("2026-09-17"), true);
});

test("导入控件只接受预期格式，并且说明了冲突规则", () => {
  const { html } = runPageScript();
  assert.match(html, /accept="\.zip,\.md,application\/zip,text\/markdown"/);
  assert.match(html, /\.bak-时间戳/);
});

test("escapeHtml / safeJsonForInlineScript 两个工具本身可信", () => {
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  const json = safeJsonForInlineScript("</script><script>alert(1)</script>");
  assert.equal(json.includes("</script>"), false);
  assert.equal(JSON.parse(json).includes("</script>"), true);
});

test("admin_page.js 可以独立加载（不依赖 server.js）", () => {
  assert.equal(typeof renderAdminPage, "function");
  assert.equal(fs.existsSync(path.join(__dirname, "..", "admin_page.js")), true);
});
