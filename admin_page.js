// 批注 2026-09-17：把管理页从 server.js 里搬出来单独成模块。
// 原因：页面已经长到 700 行，日记区默认要展示「当天 + 日历」，继续内联在 server.js 里
// 会让业务逻辑和模板互相淹没。这里只负责渲染，所有取值由 server.js 传进来。
//
// 页面结构：
//   顶部两个 tab —— 日记 / 设置。
//   日记 tab：默认显示今天（今天没写就退回最新一篇），点「日历」用月历翻看；右上角备份 / 导入。
//   设置 tab：预设方案 + 全部 .env 表单 + 一键重启。
// 内联脚本一律用字符串拼接，避免模板字符串嵌套；不需要因此牺牲可读性。
"use strict";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function selectOptions(pairs, current) {
  const value = String(current ?? "");
  return pairs
    .map(([optionValue, label]) => `<option value="${escapeHtml(optionValue)}"${optionValue === value ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

const RESTART_TAG = '<span class="restart-tag">需重启</span>';

function pageStyles() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      background: linear-gradient(135deg, #f8f0f3 0%, #f5e6eb 100%);
      background-image:
        radial-gradient(circle at 20% 80%, rgba(230, 190, 200, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(210, 170, 180, 0.1) 0%, transparent 50%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 30px 20px;
    }

    .container {
      max-width: 480px;
      width: 100%;
      background: rgba(255, 255, 255, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow:
        0 2px 10px rgba(180, 120, 130, 0.05),
        0 15px 40px rgba(180, 120, 130, 0.15),
        0 0 0 1px rgba(255, 255, 255, 0.8) inset;
      animation: fadeIn 0.6s ease-out;
    }

    h2 {
      text-align: center;
      font-size: 32px;
      font-weight: 700;
      color: #8a4a58;
      margin-bottom: 4px;
      letter-spacing: 6px;
      font-family: "Times New Roman", "Georgia", "Noto Serif SC", serif;
      text-transform: uppercase;
    }

    .subtitle {
      text-align: center;
      font-size: 12px;
      color: #a87a85;
      margin-bottom: 28px;
      letter-spacing: 4px;
      text-transform: uppercase;
      font-style: italic;
      opacity: 0.85;
    }

    /* ===== tab ===== */
    .tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 22px;
      padding: 6px;
      border-radius: 14px;
      background: rgba(255, 250, 252, 0.6);
      border: 1px solid rgba(230, 200, 208, 0.35);
    }

    .tab-btn {
      flex: 1;
      margin: 0;
      padding: 10px 8px;
      border: none;
      border-radius: 10px;
      background: transparent;
      color: #8b6b72;
      font-size: 12px;
      font-family: "Noto Serif SC", serif;
      letter-spacing: 2px;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .tab-btn.active {
      background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%);
      color: #fff;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.22);
    }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; animation: fadeIn 0.4s ease-out; }

    .status {
      background: rgba(255, 250, 252, 0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 18px;
      border: 1px solid rgba(230, 200, 208, 0.4);
    }

    .status p {
      margin: 6px 0;
      font-size: 13px;
      color: #6d5057;
      line-height: 1.5;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .status strong { color: #8a4a58; font-weight: 600; letter-spacing: 0.5px; }

    label {
      display: block;
      margin-top: 16px;
      font-weight: 500;
      font-size: 11px;
      color: #8b6b72;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    input, select, textarea {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(200, 160, 170, 0.3);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      font-family: "Noto Serif SC", serif;
      font-size: 13px;
      color: #5a4046;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    input:focus, select:focus {
      outline: none;
      border-color: #c89aa6;
      box-shadow: 0 0 0 3px rgba(200, 154, 166, 0.1);
      background: rgba(255, 255, 255, 0.95);
    }

    input::placeholder { color: #b8a0a6; font-style: italic; font-size: 12px; }

    button {
      width: 100%;
      margin-top: 16px;
      padding: 12px;
      border: none;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      letter-spacing: 1.5px;
      font-family: "Noto Serif SC", serif;
      text-transform: uppercase;
    }

    button.save {
      background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.2);
    }

    button.save:hover { background: linear-gradient(135deg, #c8909d 0%, #b8808d 100%); transform: translateY(-2px); }

    button.restart {
      background: linear-gradient(135deg, #e8909d 0%, #d8808d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(200, 100, 120, 0.25);
      margin-top: 24px;
    }

    button.restart:hover { background: linear-gradient(135deg, #d8808d 0%, #c8707d 100%); transform: translateY(-2px); }

    button.ghost {
      background: rgba(255, 255, 255, 0.75);
      color: #6d5057;
      border: 1px solid rgba(220, 180, 190, 0.45);
      box-shadow: none;
    }

    button.ghost:hover { background: #fff; border-color: #c89aa6; transform: translateY(-1px); }

    .note { margin-top: 16px; font-size: 10px; color: #a88a92; text-align: center; font-style: italic; letter-spacing: 1px; opacity: 0.75; }

    .hint { margin-top: 8px; font-size: 11px; color: #9a7a82; line-height: 1.6; }

    .restart-tag {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 6px;
      font-size: 9px;
      letter-spacing: 1px;
      color: #a85a68;
      background: rgba(232, 144, 157, 0.15);
      border: 1px solid rgba(232, 144, 157, 0.3);
    }

    .section-title {
      margin-top: 24px;
      padding-top: 18px;
      border-top: 1px solid rgba(220, 180, 190, 0.3);
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

    .presets-box, .config-box, .diary-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .presets-box, .diary-box { margin-bottom: 18px; }

    .presets-box h3, .diary-box h3 {
      margin: 0 0 12px 0;
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .preset-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }

    .preset-item { display: flex; align-items: center; gap: 8px; }

    .preset-btn {
      flex: 1;
      margin: 0;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid rgba(220, 180, 190, 0.3);
      border-radius: 10px;
      text-align: left;
      font-size: 13px;
      color: #6d5057;
      cursor: pointer;
      letter-spacing: 0;
      text-transform: none;
    }

    .preset-btn:hover { background: rgba(255, 245, 248, 0.9); border-color: #c89aa6; }

    .preset-btn span { color: #9a7a82; font-size: 11px; margin-left: 8px; font-style: italic; }

    .preset-del {
      width: auto;
      margin: 0;
      padding: 8px 12px;
      background: rgba(255, 240, 243, 0.6);
      border: 1px solid rgba(240, 200, 210, 0.4);
      border-radius: 8px;
      font-size: 11px;
      color: #a85a68;
      cursor: pointer;
      letter-spacing: 0;
    }

    .add-preset { border-top: 1px solid rgba(220, 180, 190, 0.3); padding-top: 16px; }

    .add-preset strong {
      font-size: 11px;
      color: #8a4a58;
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    /* ===== 日记 tab ===== */
    .diary-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }

    .mini-btn {
      flex: 1 1 0;
      min-width: 84px;
      width: auto;
      margin: 0;
      padding: 9px 10px;
      font-size: 11px;
      letter-spacing: 1px;
      background: rgba(255, 255, 255, 0.75);
      color: #6d5057;
      border: 1px solid rgba(220, 180, 190, 0.45);
      border-radius: 10px;
      box-shadow: none;
    }

    .mini-btn:hover { background: #fff; border-color: #c89aa6; }

    .mini-btn.on {
      background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%);
      color: #fff;
      border-color: transparent;
    }

    .diary-view-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 8px; }

    .diary-view-head strong { color: #8a4a58; font-size: 13px; letter-spacing: 1px; }

    .diary-view-head em { color: #a88a92; font-size: 10px; font-style: normal; white-space: nowrap; }

    .diary-content {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      padding: 14px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.62);
      border: 1px solid rgba(220, 180, 190, 0.25);
      color: #5a4046;
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      font-size: 12px;
      line-height: 1.85;
      max-height: 420px;
      overflow: auto;
    }

    .diary-content.empty { color: #9a7a82; font-style: italic; }

    .calendar {
      margin-top: 14px;
      padding: 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.5);
      border: 1px solid rgba(220, 180, 190, 0.3);
    }

    .calendar-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }

    .calendar-head strong { color: #8a4a58; font-size: 13px; letter-spacing: 2px; }

    .cal-nav {
      width: 34px;
      height: 34px;
      margin: 0;
      padding: 0;
      font-size: 15px;
      line-height: 1;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.85);
      color: #8a4a58;
      border: 1px solid rgba(220, 180, 190, 0.45);
      box-shadow: none;
      letter-spacing: 0;
    }

    .cal-nav:hover { background: #fff; border-color: #c89aa6; }

    .calendar-weekdays, .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }

    .calendar-weekdays div { text-align: center; font-size: 10px; color: #a88a92; padding-bottom: 4px; }

    .cal-cell {
      position: relative;
      aspect-ratio: 1 / 1;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      font-size: 12px;
      color: #b09aa0;
    }

    .cal-cell.blank { visibility: hidden; }

    .cal-cell.has { background: rgba(216, 160, 173, 0.16); color: #6d5057; font-weight: 600; cursor: pointer; }

    .cal-cell.has:hover { background: rgba(216, 160, 173, 0.34); }

    .cal-cell.today { box-shadow: 0 0 0 1px #c89aa6 inset; }

    .cal-cell.selected { background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%); color: #fff; }

    .cal-cell .dot {
      position: absolute;
      bottom: 4px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #c8909d;
    }

    .cal-cell.selected .dot { background: rgba(255, 255, 255, 0.9); }

    .import-result {
      display: none;
      margin-top: 12px;
      padding: 11px 13px;
      border-radius: 11px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid rgba(220, 180, 190, 0.35);
      font-size: 11px;
      line-height: 1.75;
      color: #6d5057;
    }

    .import-result b { color: #8a4a58; }

    .file-input {
      width: 100%;
      margin-top: 10px;
      padding: 9px 10px;
      border: 1px dashed rgba(200, 160, 170, 0.55);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.6);
      font-size: 11px;
      color: #8b6b72;
      cursor: pointer;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
}

function pageScript(context) {
  const datesJson = safeJsonForInlineScript(context.diary.dates);
  const authHeaderJson = safeJsonForInlineScript(`Basic ${context.authToken}`);
  const presetsJson = safeJsonForInlineScript(context.presets);
  const todayJson = safeJsonForInlineScript(context.diary.today);
  const latestJson = safeJsonForInlineScript(context.diary.latest);

  return `
    var AUTH_HEADER = ${authHeaderJson};
    var DIARY_DATES = ${datesJson};
    var TODAY = ${todayJson};
    var LATEST = ${latestJson};
    var presets = ${presetsJson};

    var dateSet = {};
    DIARY_DATES.forEach(function (d) { dateSet[d] = true; });

    var shownDate = null;
    var calCursor = null;

    function el(id) { return document.getElementById(id); }

    function escapeHtmlText(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function parseDate(str) {
      var parts = String(str).split("-");
      return { y: Number(parts[0]), m: Number(parts[1]) - 1, d: Number(parts[2]) };
    }

    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    function dateKey(y, m, d) { return y + "-" + pad2(m + 1) + "-" + pad2(d); }

    function weekdayLabel(str) {
      var p = parseDate(str);
      var names = ["日", "一", "二", "三", "四", "五", "六"];
      var weekday = new Date(p.y, p.m, p.d).getDay();
      return "星期" + names[weekday];
    }

    function switchTab(name) {
      var panels = document.querySelectorAll(".tab-panel");
      for (var i = 0; i < panels.length; i++) panels[i].classList.remove("active");
      var btns = document.querySelectorAll(".tab-btn");
      for (var j = 0; j < btns.length; j++) {
        btns[j].classList.toggle("active", btns[j].getAttribute("data-tab") === name);
      }
      el("panel-" + name).classList.add("active");
    }

    // ===== 日记展示 =====
    function showDiary(date) {
      shownDate = date;
      var p = parseDate(date);
      calCursor = { y: p.y, m: p.m };
      el("diaryDate").textContent = date + " · " + weekdayLabel(date);
      el("diaryMeta").textContent = "读取中…";
      var box = el("diaryContent");
      box.classList.remove("empty");
      box.textContent = "";
      if (!el("calendarBox").hidden) renderCalendar();

      fetch("/admin/diary/content?date=" + encodeURIComponent(date), { headers: { Authorization: AUTH_HEADER } })
        .then(function (resp) { return resp.json(); })
        .then(function (data) {
          if (shownDate !== date) return;
          if (!data || !data.exists) {
            el("diaryMeta").textContent = "";
            box.classList.add("empty");
            box.textContent = (data && data.message) || "那天我没有写日记。";
            return;
          }
          el("diaryMeta").textContent = "最后更新 " + data.updated_at;
          box.textContent = data.content;
        })
        .catch(function (err) {
          el("diaryMeta").textContent = "";
          box.classList.add("empty");
          box.textContent = "读取失败：" + err.message;
        });
    }

    function toggleCalendar() {
      var box = el("calendarBox");
      box.hidden = !box.hidden;
      el("btnCalendar").classList.toggle("on", !box.hidden);
      if (!box.hidden) {
        var p = parseDate(shownDate || TODAY);
        calCursor = { y: p.y, m: p.m };
        renderCalendar();
      }
    }

    function moveMonth(delta) {
      if (!calCursor) return;
      var m = calCursor.m + delta;
      var y = calCursor.y + Math.floor(m / 12);
      m = ((m % 12) + 12) % 12;
      calCursor = { y: y, m: m };
      renderCalendar();
    }

    function renderCalendar() {
      if (!calCursor) return;
      var y = calCursor.y;
      var m = calCursor.m;
      el("calTitle").textContent = y + " 年 " + (m + 1) + " 月";

      var html = "";
      var firstWeekday = new Date(y, m, 1).getDay();
      var offset = (firstWeekday + 6) % 7; // 周一为首列
      var daysInMonth = new Date(y, m + 1, 0).getDate();
      for (var i = 0; i < offset; i++) html += '<div class="cal-cell blank"></div>';
      for (var d = 1; d <= daysInMonth; d++) {
        var key = dateKey(y, m, d);
        var classes = "cal-cell";
        if (dateSet[key]) classes += " has";
        if (key === TODAY) classes += " today";
        if (key === shownDate) classes += " selected";
        var clickable = dateSet[key] ? ' onclick="showDiary(\\'' + key + '\\')"' : "";
        var dot = dateSet[key] ? '<span class="dot"></span>' : "";
        html += '<div class="' + classes + '"' + clickable + '>' + d + dot + '</div>';
      }
      el("calendarGrid").innerHTML = html;
    }

    // ===== 备份到本地 =====
    function exportBackup() {
      if (!DIARY_DATES.length) { alert("还没有日记可以备份。"); return; }
      var btn = el("btnExport");
      btn.textContent = "打包中…";
      fetch("/admin/diary/export", { headers: { Authorization: AUTH_HEADER } })
        .then(function (resp) {
          if (!resp.ok) return resp.text().then(function (t) { throw new Error(t || ("HTTP " + resp.status)); });
          var name = "heartbeat-diary.zip";
          var disposition = resp.headers.get("Content-Disposition") || "";
          var matched = disposition.match(/filename="?([^";]+)"?/);
          if (matched) name = matched[1];
          return resp.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
          });
        })
        .catch(function (err) { alert("备份失败：" + err.message); })
        .then(function () { btn.textContent = "备份到本地"; });
    }

    // ===== 导入备份 =====
    function handleImport(input) {
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) return;
      var results = [];
      var box = el("importResult");
      box.style.display = "block";
      box.textContent = "正在导入 " + files.length + " 个文件…";

      function step() {
        var file = files.shift();
        if (!file) return finish();
        fetch("/admin/diary/import?filename=" + encodeURIComponent(file.name), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", Authorization: AUTH_HEADER },
          body: new Blob([file], { type: "application/octet-stream" })
        })
          .then(function (resp) {
            return resp.json().then(function (data) { return { ok: resp.ok, data: data }; });
          })
          .then(function (result) {
            results.push({ file: file.name, ok: result.ok, data: result.data });
            step();
          })
          .catch(function (err) {
            results.push({ file: file.name, ok: false, data: { error: err.message } });
            step();
          });
      }

      function finish() {
        input.value = "";
        var changed = 0;
        var hadAny = el("diaryContent").textContent.trim().length > 0;
        results.forEach(function (r) {
          if (!r.ok || !r.data) return;
          (r.data.added || []).concat((r.data.replaced || []).map(function (item) { return item.name; }))
            .forEach(function (name) {
              var date = String(name).slice(0, 10);
              if (!dateSet[date]) { dateSet[date] = true; DIARY_DATES.push(date); changed++; }
            });
        });
        if (changed) {
          DIARY_DATES.sort().reverse();
          LATEST = DIARY_DATES[0];
          el("diaryCount").textContent = DIARY_DATES.length;
          el("btnCalendar").disabled = false;
          renderCalendar();
          if (!hadAny) showDiary(LATEST);
        }
        renderImportSummary(results);
      }

      step();
    }

    function renderImportSummary(results) {
      var box = el("importResult");
      var html = results.map(function (r) {
        var name = "<b>" + escapeHtmlText(r.file) + "</b>：";
        if (!r.ok || !r.data || r.data.error) {
          return name + "失败（" + escapeHtmlText((r.data && r.data.error) || "未知错误") + "）";
        }
        var data = r.data;
        var parts = [];
        if (data.added && data.added.length) parts.push("新增 " + data.added.length + " 天");
        if (data.replaced && data.replaced.length) parts.push("替换 " + data.replaced.length + " 天（原文件已存为 .bak）");
        if (data.skipped && data.skipped.length) {
          var reasons = data.skipped.map(function (s) {
            return escapeHtmlText(s.name) + "（" + escapeHtmlText(s.reason) + "）";
          }).join("、");
          parts.push("跳过 " + data.skipped.length + " 条：" + reasons);
        }
        if (!parts.length) parts.push("没有可导入的内容");
        return name + parts.join("｜");
      }).join("<br>");
      box.innerHTML = html;
    }

    // ===== 预设 =====
    function renderPresets() {
      var list = el("presetList");
      if (!presets.length) {
        list.innerHTML = '<div style="color:#aaa;font-size:12px;font-style:italic;">还没有预设，保存当前配置即可创建。</div>';
        return;
      }
      list.innerHTML = presets.map(function (p, idx) {
        return '<div class="preset-item">' +
          '<button class="preset-btn" onclick="applyPreset(' + idx + ')">' + escapeHtmlText(p.name) +
          '<span>' + escapeHtmlText(p.model_name) + '</span></button>' +
          '<button class="preset-del" onclick="deletePreset(' + idx + ')">删除</button>' +
        '</div>';
      }).join("");
    }

    function applyPreset(idx) {
      var p = presets[idx];
      el("f_url").value = p.target_url || "";
      el("f_model").value = p.model_name || "";
      if (p.target_key) el("f_key").value = p.target_key;
      switchTab("settings");
      el("f_url").scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function fieldValue(id) {
      var node = el(id);
      return node ? String(node.value).trim() : "";
    }

    function buildPayload() {
      return {
        target_url: fieldValue("f_url"),
        target_key: fieldValue("f_key"),
        gateway_api_key: fieldValue("f_gateway_key"),
        model_name: fieldValue("f_model"),
        bark_key: fieldValue("f_bark"),
        custom_icon: fieldValue("f_icon"),
        day_wake_after: fieldValue("f_day_wake_after"),
        night_wake_after: fieldValue("f_night_wake_after"),
        day_check_interval: fieldValue("f_day_check_interval"),
        night_check_interval: fieldValue("f_night_check_interval"),
        wake_day_start_hour: fieldValue("f_wake_day_start_hour"),
        wake_day_end_hour: fieldValue("f_wake_day_end_hour"),
        weather_enabled: fieldValue("f_weather_enabled"),
        weather_location_name: fieldValue("f_weather_location_name"),
        weather_lat: fieldValue("f_weather_lat"),
        weather_lon: fieldValue("f_weather_lon"),
        weather_units: fieldValue("f_weather_units"),
        gateway_chat_reasoning: fieldValue("f_chat_reasoning"),
        wake_reasoning: fieldValue("f_wake_reasoning"),
        diary_enabled: fieldValue("f_diary_enabled"),
        push_provider: fieldValue("f_push_provider"),
        ai_display_name: fieldValue("f_ai_display_name"),
        user_display_name: fieldValue("f_user_display_name"),
        ntfy_server_url: fieldValue("f_ntfy_server_url"),
        ntfy_topic: fieldValue("f_ntfy_topic"),
        ntfy_token: fieldValue("f_ntfy_token"),
        ntfy_priority: fieldValue("f_ntfy_priority"),
        ntfy_tags: fieldValue("f_ntfy_tags"),
        allow_public_api: fieldValue("f_allow_public_api"),
        time_zone: fieldValue("f_time_zone"),
        multimodal_mode: fieldValue("f_multimodal_mode"),
        push_timeout_ms: fieldValue("f_push_timeout"),
        wake_upstream_timeout_ms: fieldValue("f_wake_timeout"),
        request_body_limit_mb: fieldValue("f_body_limit")
      };
    }

    function clearSecretFields() {
      ["f_key", "f_gateway_key", "f_bark", "f_ntfy_token"].forEach(function (id) {
        if (el(id)) el(id).value = "";
      });
    }

    async function saveConfig(event, thenRestart) {
      if (event) event.preventDefault();
      var payload = buildPayload();
      if (!payload.target_url || !payload.model_name) {
        alert("请填写 API 地址和模型名称");
        return;
      }
      try {
        var resp = await fetch("/admin/save", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: AUTH_HEADER },
          body: JSON.stringify(payload)
        });
        var result = await resp.json();
        if (!result.success) {
          alert("保存失败：" + (result.error || "未知错误"));
          return;
        }
        clearSecretFields();
        if (thenRestart) await restartServices();
        else alert("配置已保存。改动要重启才生效：点页面底部的「一键重启」。");
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    async function savePreset() {
      var name = fieldValue("presetName");
      var target_url = fieldValue("f_url");
      var target_key = fieldValue("f_key");
      var model_name = fieldValue("f_model");
      if (!name) { alert("请填写预设名称"); return; }
      if (!target_url || !model_name) { alert("请先填写 API 地址和模型名称"); return; }

      var resp = await fetch("/admin/presets/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: AUTH_HEADER },
        body: JSON.stringify({ name: name, target_url: target_url, target_key: target_key, model_name: model_name })
      });
      var r = await resp.json();
      if (!r.success) { alert("保存失败：" + (r.error || "未知错误")); return; }
      var existing = -1;
      for (var i = 0; i < presets.length; i++) if (presets[i].name === name) existing = i;
      var entry = { name: name, target_url: target_url, target_key: target_key, model_name: model_name };
      if (existing >= 0) presets[existing] = entry; else presets.push(entry);
      renderPresets();
      el("presetName").value = "";
      alert("预设已保存：" + name);
    }

    async function deletePreset(idx) {
      var p = presets[idx];
      if (!confirm("删除预设「" + p.name + "」？")) return;
      await fetch("/admin/presets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: AUTH_HEADER },
        body: JSON.stringify({ name: p.name })
      });
      presets.splice(idx, 1);
      renderPresets();
    }

    async function restartServices() {
      if (!confirm("确定要重启 Gateway 和 wake_up 吗？")) return;
      try {
        var resp = await fetch("/admin/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: AUTH_HEADER },
          body: "{}"
        });
        var result = await resp.json();
        if (result.success) {
          alert("重启指令已发送，页面稍后自动刷新。");
          setTimeout(function () { location.reload(); }, 4000);
        } else {
          alert("重启失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    // ===== 初始化 =====
    var input = el("importFile");
    if (input) input.addEventListener("change", function () { handleImport(input); });

    renderPresets();
    var initial = dateSet[TODAY] ? TODAY : (LATEST || TODAY);
    if (!DIARY_DATES.length) {
      el("btnCalendar").disabled = true;
      el("diaryDate").textContent = "还没有日记";
      el("diaryMeta").textContent = "";
      var emptyBox = el("diaryContent");
      emptyBox.classList.add("empty");
      emptyBox.textContent = "模型在唤醒回复里输出 [DIARY]...[/DIARY] 之后，日记会出现在这里。";
    } else {
      showDiary(initial);
    }
  `;
}

function renderAdminPage(context) {
  const cfg = context.config || {};
  const diary = context.diary || { dates: [], today: "", latest: null };
  const timeline = context.timeline || {};
  const draftCount = diary.dates.length;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HEARTBEAT · Runtime</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
  <style>${pageStyles()}</style>
</head>
<body>
  <div class="container">
    <h2>HEARTBEAT</h2>
    <div class="subtitle">Runtime · AI Residency</div>

    <div class="tabs">
      <button class="tab-btn active" data-tab="diary" onclick="switchTab('diary')">日记</button>
      <button class="tab-btn" data-tab="settings" onclick="switchTab('settings')">设置</button>
    </div>

    <!-- ========== 日记 ========== -->
    <div class="tab-panel active" id="panel-diary">
      <div class="status">
        <p>Gateway <strong>运行中 (${escapeHtml(context.serverUptime)}秒)</strong></p>
        <p>Auto Wakeup <strong>${escapeHtml(context.wakeUpStatus)}</strong></p>
      </div>
      ${context.runtimeConfigNotice || ""}

      <div class="diary-box">
        <h3>Wake Diary <span style="font-weight:400;letter-spacing:0;text-transform:none;color:#a88a92;font-size:11px;">共 <span id="diaryCount">${escapeHtml(draftCount)}</span> 篇</span></h3>

        <div class="diary-toolbar">
          <button class="mini-btn" id="btnCalendar" onclick="toggleCalendar()">日历</button>
          <button class="mini-btn" onclick="showDiary(TODAY)">今天</button>
          <button class="mini-btn" onclick="showDiary(LATEST || TODAY)">最新一篇</button>
        </div>

        <div class="diary-view-head">
          <strong id="diaryDate">—</strong>
          <em id="diaryMeta"></em>
        </div>
        <pre class="diary-content" id="diaryContent"></pre>

        <div class="calendar" id="calendarBox" hidden>
          <div class="calendar-head">
            <button class="cal-nav" onclick="moveMonth(-1)">‹</button>
            <strong id="calTitle"></strong>
            <button class="cal-nav" onclick="moveMonth(1)">›</button>
          </div>
          <div class="calendar-weekdays">
            <div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div><div>日</div>
          </div>
          <div class="calendar-grid" id="calendarGrid"></div>
        </div>

        <div class="section-title" style="margin-top:20px;">备份</div>
        <div class="diary-toolbar" style="margin-top:12px;">
          <button class="mini-btn" id="btnExport" onclick="exportBackup()">备份到本地</button>
        </div>
        <div class="hint">把 ${escapeHtml(cfg.diaryDir || "diary")} 下的全部日记打包成一个 .zip 下载到手机本地。日记不在 git 里，这份包就是唯一的保险。</div>

        <label for="importFile" style="margin-top:16px;">导入备份</label>
        <input class="file-input" type="file" id="importFile" accept=".zip,.md,application/zip,text/markdown" multiple>
        <div class="hint">可以选一个 .zip，也可以一次选多个 YYYY-MM-DD.md。同一天已有日记时，旧文件会先存成 <b>.bak-时间戳</b> 再写入，不会丢东西。</div>
        <div class="import-result" id="importResult"></div>
      </div>
    </div>

    <!-- ========== 设置 ========== -->
    <div class="tab-panel" id="panel-settings">
      <div class="status">
        <p><strong>时间线体检</strong></p>
        <p>消息 ${timeline.count || 0} 条 ／ 你 ${timeline.users || 0} ／ 我 ${timeline.assistants || 0} ／ 系统 ${timeline.systems || 0}</p>
        <p>能读出时间的你说的话：${timeline.readableUsers || 0} 条</p>
        <p>最后一条你的消息：${escapeHtml(timeline.lastUserTime || "没有")}</p>
        <p>唤醒锚点：${escapeHtml(timeline.anchor || "没有")}</p>
        <p>时间线更新于 ${escapeHtml(timeline.updatedAt || "—")} ／ 锚点更新于 ${escapeHtml(timeline.anchorUpdatedAt || "—")}</p>
        <div class="hint">自动唤醒靠「最后一条你的消息」判断你多久没说话。这个数字变成 0、锚点变成「没有」的时候，唤醒会卡在日志里那句「未找到用户时间」，既不推送也不写日记。</div>
      </div>

      <div class="presets-box">
        <h3>预设方案</h3>
        <div class="preset-list" id="presetList"></div>
        <div class="add-preset">
          <strong>保存当前配置为新预设</strong>
          <input id="presetName" placeholder="预设名称，例如：DeepSeek / Claude">
          <button class="ghost" onclick="savePreset()">保存为预设</button>
        </div>
      </div>

      <div class="config-box">
        <form id="configForm" onsubmit="saveConfig(event, false)">
          <label>API URL</label>
          <input name="target_url" id="f_url" value="${escapeHtml(cfg.targetUrl)}">
          <label>API Key</label>
          <input name="target_key" id="f_key" placeholder="留空不修改">
          <label>Gateway API Key</label>
          <input name="gateway_api_key" id="f_gateway_key" placeholder="公网 /v1 鉴权 key，留空不修改">
          <div class="hint">当前状态：${escapeHtml(cfg.gatewayKeyStatus)}。公开部署并开启 ALLOW_PUBLIC_API 时，客户端 API Key 填这个，不要填上游 API Key。</div>
          <label>Model Name</label>
          <input name="model_name" id="f_model" value="${escapeHtml(cfg.modelName)}">

          <div class="section-title">思考模式${RESTART_TAG}</div>
          <label>网关聊天思考</label>
          <select name="gateway_chat_reasoning" id="f_chat_reasoning">
            ${selectOptions([["off", "关闭（推荐）"], ["on", "开启"]], cfg.gatewayChatReasoning)}
          </select>
          <div class="hint">关闭后，客户端不回传 reasoning_content 也不会 400，带工具的对话才走得通。</div>
          <label>唤醒 / 日记思考</label>
          <select name="wake_reasoning" id="f_wake_reasoning">
            ${selectOptions([["on", "开启（推荐）"], ["off", "关闭"]], cfg.wakeReasoning)}
          </select>
          <div class="hint">唤醒请求不带 tools，开思考能让我在写下日记时认得出自己。</div>

          <div class="section-title">推送${RESTART_TAG}</div>
          <label>推送通道</label>
          <select name="push_provider" id="f_push_provider">
            ${selectOptions([["bark", "Bark"], ["ntfy", "ntfy"]], cfg.pushProvider)}
          </select>
          <label>Bark Key</label>
          <input name="bark_key" id="f_bark" placeholder="留空不修改">
          <label>Bark Icon URL</label>
          <input name="custom_icon" id="f_icon" value="${escapeHtml(cfg.customIcon)}" placeholder="可选">
          <label>推送标题（AI_DISPLAY_NAME）</label>
          <input name="ai_display_name" id="f_ai_display_name" value="${escapeHtml(cfg.aiDisplayName)}" placeholder="留空则用「来自姐姐」">
          <label>对话里我的名字（USER_DISPLAY_NAME）</label>
          <input name="user_display_name" id="f_user_display_name" value="${escapeHtml(cfg.userDisplayName)}" placeholder="可选">
          <label>ntfy 服务器</label>
          <input name="ntfy_server_url" id="f_ntfy_server_url" value="${escapeHtml(cfg.ntfyServerUrl)}" placeholder="https://ntfy.sh">
          <label>ntfy Topic</label>
          <input name="ntfy_topic" id="f_ntfy_topic" value="${escapeHtml(cfg.ntfyTopic)}" placeholder="留空则不使用 ntfy">
          <label>ntfy Token</label>
          <input name="ntfy_token" id="f_ntfy_token" placeholder="留空不修改">
          <label>ntfy 优先级</label>
          <input name="ntfy_priority" id="f_ntfy_priority" value="${escapeHtml(cfg.ntfyPriority)}" placeholder="例如 default / high / max">
          <label>ntfy 标签</label>
          <input name="ntfy_tags" id="f_ntfy_tags" value="${escapeHtml(cfg.ntfyTags)}" placeholder="例如 moon,heart">

          <div class="section-title">日记${RESTART_TAG}</div>
          <label>自动日记开关</label>
          <select name="diary_enabled" id="f_diary_enabled">
            ${selectOptions([["true", "开启"], ["false", "关闭（只推送不写日记）"]], cfg.diaryEnabled)}
          </select>
          <div class="hint">日记目录：${escapeHtml(cfg.diaryDir || "diary")}</div>

          <div class="section-title">唤醒节奏${RESTART_TAG}</div>
          <div class="grid-2">
            <div>
              <label>白天多久未回复后唤醒（分钟）</label>
              <input type="number" min="1" name="day_wake_after" id="f_day_wake_after" value="${escapeHtml(cfg.dayWakeAfter)}">
            </div>
            <div>
              <label>夜间多久未回复后唤醒（分钟）</label>
              <input type="number" min="1" name="night_wake_after" id="f_night_wake_after" value="${escapeHtml(cfg.nightWakeAfter)}">
            </div>
            <div>
              <label>白天检查间隔（分钟）</label>
              <input type="number" min="1" name="day_check_interval" id="f_day_check_interval" value="${escapeHtml(cfg.dayCheckInterval)}">
            </div>
            <div>
              <label>夜间检查间隔（分钟）</label>
              <input type="number" min="1" name="night_check_interval" id="f_night_check_interval" value="${escapeHtml(cfg.nightCheckInterval)}">
            </div>
            <div>
              <label>白天开始小时</label>
              <input type="number" min="0" max="23" name="wake_day_start_hour" id="f_wake_day_start_hour" value="${escapeHtml(cfg.dayStartHour)}">
            </div>
            <div>
              <label>白天结束小时</label>
              <input type="number" min="1" max="24" name="wake_day_end_hour" id="f_wake_day_end_hour" value="${escapeHtml(cfg.dayEndHour)}">
            </div>
          </div>

          <div class="section-title">天气</div>
          <label>天气注入</label>
          <select name="weather_enabled" id="f_weather_enabled">
            ${selectOptions([["false", "关闭"], ["true", "开启"]], cfg.weatherEnabled)}
          </select>
          <label>位置名称</label>
          <input name="weather_location_name" id="f_weather_location_name" value="${escapeHtml(cfg.weatherLocationName)}" placeholder="例如：Hong Kong">
          <div class="grid-2">
            <div>
              <label>纬度 Latitude</label>
              <input name="weather_lat" id="f_weather_lat" value="${escapeHtml(cfg.weatherLat)}" placeholder="例如：22.3193">
            </div>
            <div>
              <label>经度 Longitude</label>
              <input name="weather_lon" id="f_weather_lon" value="${escapeHtml(cfg.weatherLon)}" placeholder="例如：114.1694">
            </div>
          </div>
          <label>单位</label>
          <select name="weather_units" id="f_weather_units">
            ${selectOptions([["metric", "摄氏度 / km/h"], ["fahrenheit", "华氏度 / mph"]], cfg.weatherUnits)}
          </select>

          <div class="section-title">高级${RESTART_TAG}</div>
          <label>公开接口（ALLOW_PUBLIC_API）</label>
          <select name="allow_public_api" id="f_allow_public_api">
            ${selectOptions([["false", "关闭（仅本机可用）"], ["true", "开启（公网可访问 /v1）"]], cfg.allowPublicApi)}
          </select>
          <div class="hint">开启前请确认 GATEWAY_API_KEY 已设置成足够长的随机串。</div>
          <label>时区</label>
          <input name="time_zone" id="f_time_zone" value="${escapeHtml(cfg.timeZone)}" placeholder="Asia/Hong_Kong">
          <label>多模态模式</label>
          <select name="multimodal_mode" id="f_multimodal_mode">
            ${selectOptions([["passthrough", "透传（模型自己看图）"], ["text", "文本占位 [图片]"]], cfg.multimodalMode)}
          </select>
          <div class="grid-2">
            <div>
              <label>推送超时（毫秒）</label>
              <input type="number" min="1" name="push_timeout_ms" id="f_push_timeout" value="${escapeHtml(cfg.pushTimeoutMs)}">
            </div>
            <div>
              <label>唤醒请求超时（毫秒）</label>
              <input type="number" min="1" name="wake_upstream_timeout_ms" id="f_wake_timeout" value="${escapeHtml(cfg.wakeUpstreamTimeoutMs)}">
            </div>
          </div>
          <label>请求体上限（MB）</label>
          <input type="number" min="1" name="request_body_limit_mb" id="f_body_limit" value="${escapeHtml(cfg.requestBodyLimitMb)}">

          <button type="submit" class="save">保存配置</button>
          <button type="button" class="ghost" onclick="saveConfig(null, true)">保存并重启</button>
        </form>
      </div>

      <button onclick="restartServices()" class="restart">一键重启所有服务</button>
      <div class="note">唤醒相关的改动都要重启 wake_up 才生效——它是独立进程，只在启动时读一次 .env。</div>
    </div>
  </div>

  <script>
${pageScript(context)}
  </script>
</body>
</html>`;
}

module.exports = { renderAdminPage, escapeHtml, safeJsonForInlineScript };
