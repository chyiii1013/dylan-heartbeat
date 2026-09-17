require("dotenv").config({ quiet: true });

const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");
const {
  PROJECT_DIR,
  ensureDataDir,
  runtimeDirectory,
  runtimeFile,
  writeJsonAtomicSync
} = require("./runtime_paths");
const { isSpecialEventContent, isNoPushPlaceholderEvent } = require("./special_events");
const {
  hasParseableTimestamp,
  hasRealUserContent,
  lastUserTimeFromMessages,
  readAnchor,
  writeAnchor
} = require("./last_user_anchor");
const { decideRequestAccess } = require("./network_access");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");
const {
  isValidDiaryName,
  listDiaryFiles,
  readDiaryText,
  formatBackupStamp,
  buildZip,
  readZipEntries,
  importDiaryEntries
} = require("./diary_store");
const { renderAdminPage } = require("./admin_page");

const DEFAULT_BODY_LIMIT_MB = 50;

function readBodyLimitBytes() {
  const configured = Number(process.env.REQUEST_BODY_LIMIT_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BODY_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

const app = Fastify({
  logger: true,
  bodyLimit: readBodyLimitBytes()
});

app.register(require("@fastify/formbody"));

// 批注 2026-09-17：日记导入把文件当原始二进制体上传（页面用 fetch 直接 POST File），
// 这样不需要 @fastify/multipart，Termux 上不必再装新依赖。text/plain 已由 Fastify 内置注册，
// 这里只补二进制与 markdown 几个类型，统一按 Buffer 收。
app.addContentTypeParser(
  ["application/octet-stream", "application/zip", "application/x-zip-compressed", "application/x-zip", "text/markdown"],
  { parseAs: "buffer" },
  (req, body, done) => done(null, body)
);

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIME_ZONE = resolveTimeZone();
const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);
// 批注 2026-08-10：默认路径仍是项目目录，保护本机/VPS 旧部署；Railway 挂载 Volume 后
// DATA_DIR（或平台提供的 RAILWAY_VOLUME_MOUNT_PATH）统一承载时间线、时间戳、预设和日记。
const DATA_DIR = ensureDataDir();
const TIMELINE_FILE = runtimeFile("enhanced_messages.json");
const TIMESTAMP_DB_FILE = runtimeFile("message_timestamps.json");
// 批注 2026-09-17：唤醒锚点独立成文件，wake_up 不再只靠从时间线正文挖时间戳。
const LAST_USER_TIME_FILE = runtimeFile("last_user_time.json");
// 批注 2026-07-17：管理页保存 .env 后要让 PM2 刷新进程环境；保留原进程名，
// 只补 --update-env，避免用户改完推送配置却继续运行旧值。
const DEFAULT_RESTART_COMMAND = "pm2 restart gateway wake-up --update-env";

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function configuredModelName() {
  // 批注 2026-07-15：/v1/models 要暴露部署者实际配置的模型名；
  // 不能继续硬编码示例模型，否则 Kelivo 模型选择会和真实上游不一致。
  return String(process.env.MODEL_NAME || "gateway-model").trim() || "gateway-model";
}

// ========================
// 多模态消息处理
// ========================
function shouldForwardMultimodalContent() {
  // 批注 2026-07-15：默认把 Kelivo 的图片 content 数组原样交给视觉模型；
  // 如果上游不是多模态模型，部署者仍可显式设 MULTIMODAL_MODE=text 退回旧的 [图片] 占位模式。
  const mode = (process.env.MULTIMODAL_MODE || "passthrough").trim().toLowerCase();
  return !["text", "plain", "placeholder", "false", "off", "0"].includes(mode);
}

function isDataImageUrl(value) {
  return typeof value === "string" && /^data:image\//i.test(value);
}

function isImageContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.image_url) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("image");
}

function isFileContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.file) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("file");
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return "[文件]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return "[文件]";
  return "[非文本内容]";
}

function normalizeMessageForTimeline(msg) {
  return { ...msg, content: normalizeContentToText(msg.content) };
}

function prepareMessageForLLM(msg) {
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") return { ...msg, content: normalizeContentToText(msg.content) };
  if (typeof msg.content === "string") return msg;

  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) return msg;

  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return { ...msg, content: textContent };
}

function sanitizeForLog(value) {
  if (typeof value === "string") {
    if (isDataImageUrl(value)) {
      const commaIndex = value.indexOf(",");
      const prefix = commaIndex >= 0 ? value.slice(0, commaIndex + 1) : value.slice(0, 40);
      return `${prefix}[base64 image omitted]`;
    }
    if (value.length > 1000) return `${value.slice(0, 1000)}... [truncated ${value.length - 1000} chars]`;
    return value;
  }

  if (Array.isArray(value)) return value.map(sanitizeForLog);

  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeForLog(child);
    }
    return sanitized;
  }

  return value;
}

function summarizeMessageForLog(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : [msg?.content];
  const textChars = parts.reduce((sum, part) => sum + getTextFromContentPart(part).length, 0);
  return {
    role: msg?.role || "",
    content_type: Array.isArray(msg?.content) ? "multimodal" : typeof msg?.content,
    text_chars: textChars || normalizeContentToText(msg?.content).length,
    image_parts: parts.filter(isImageContentPart).length,
    file_parts: parts.filter(isFileContentPart).length,
    tool_calls: Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0
  };
}

function summarizeMessagesForLog(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let imageParts = 0;
  let fileParts = 0;
  let textChars = 0;
  for (const msg of list) {
    const item = summarizeMessageForLog(msg);
    roles[item.role] = (roles[item.role] || 0) + 1;
    imageParts += item.image_parts;
    fileParts += item.file_parts;
    textChars += item.text_chars;
  }
  return { total: list.length, roles, text_chars: textChars, image_parts: imageParts, file_parts: fileParts };
}

// 批注 2026-09-17：escapeHtml / safeJsonForInlineScript 随管理页模板一起搬进 admin_page.js。

// ========================
// 读取 timeline
// ========================
function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try { return fs.readJsonSync(TIMELINE_FILE); } catch { return []; }
}

// ========================
// 保存 timeline（保留 SP）
// ========================
function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  writeJsonAtomicSync(TIMELINE_FILE, final);
}

// ========================
// 时间线体检（给管理页看）
// ========================
// 批注 2026-09-17：唤醒是靠「最后一条用户消息」判断用户多久没说话的。
// 用户消息为 0 时唤醒会永久卡死，而这件事以前只在 pm2 日志里看得见。
// 把体检结果直接摆到管理页，一眼就能看出链子有没有断。
function readTimelineStats() {
  const stats = {
    count: 0,
    users: 0,
    assistants: 0,
    systems: 0,
    readableUsers: 0,
    lastUserTime: null,
    anchor: null,
    anchorUpdatedAt: null,
    updatedAt: null
  };

  try {
    const list = loadTimeline();
    stats.count = list.length;
    for (const msg of list) {
      const text = normalizeContentToText(msg.content);
      if (msg.role === "user") {
        stats.users += 1;
        if (hasParseableTimestamp(text)) stats.readableUsers += 1;
      } else if (msg.role === "assistant") {
        stats.assistants += 1;
      } else if (msg.role === "system") {
        stats.systems += 1;
      }
    }
    const lastUser = lastUserTimeFromMessages(
      list,
      parseTimestampLabel,
      msg => normalizeContentToText(msg.content)
    );
    if (lastUser) stats.lastUserTime = formatDateTimeInTimeZone(lastUser, TIME_ZONE);
  } catch {}

  if (fs.existsSync(TIMELINE_FILE)) {
    stats.updatedAt = formatDateTimeInTimeZone(fs.statSync(TIMELINE_FILE).mtime, TIME_ZONE);
  }

  const anchorDate = readAnchor(LAST_USER_TIME_FILE);
  if (anchorDate) stats.anchor = formatDateTimeInTimeZone(anchorDate, TIME_ZONE);
  if (fs.existsSync(LAST_USER_TIME_FILE)) {
    stats.anchorUpdatedAt = formatDateTimeInTimeZone(fs.statSync(LAST_USER_TIME_FILE).mtime, TIME_ZONE);
  }

  return stats;
}

// ========================
// 提取时间戳（支持多种格式）
// ========================
function parseTimestampLabel(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  // 批注 2026-07-30：Kelivo 写进消息前缀的是用户配置时区的墙上时间；
  // 公网/Railway 不能按服务器 UTC 解析，否则时间线和自动唤醒都会被推迟。
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function stripLeadingTimestamp(content) {
  // 批注 2026-07-15：兼容 Kelivo 有时把日期和时间贴在一起的前缀；
  // 旧格式 "YYYY-MM-DD HH:mm" 继续保留，新格式 "YYYY-MM-DDHH:mm" 不再导致时间记忆/排序失效。
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function extractTimestamp(content) {
  return parseTimestampLabel(content);
}

// ========================
// 时间戳记忆库
// ========================
function loadTimestampDB() {
  if (!fs.existsSync(TIMESTAMP_DB_FILE)) return {};
  try { return fs.readJsonSync(TIMESTAMP_DB_FILE); } catch { return {}; }
}

function saveTimestampDB(db) {
  writeJsonAtomicSync(TIMESTAMP_DB_FILE, db);
}

function makeFingerprint(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = raw.trim().slice(0, 150);
  return `${msg.role}::${content}`;
}

function makeFingerprintStripped(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = stripLeadingTimestamp(raw).slice(0, 150);
  return `${msg.role}::${content}`;
}

function extractTimestampWithMemory(msg, tsDB) {
  const fromContent = extractTimestamp(normalizeContentToText(msg.content));
  if (fromContent) return fromContent;
  const fp = makeFingerprint(msg);
  if (tsDB[fp]) return new Date(tsDB[fp]);
  const fpStripped = makeFingerprintStripped(msg);
  if (tsDB[fpStripped]) return new Date(tsDB[fpStripped]);
  return null;
}

// ========================
// 消息判断
// ========================
function isSpecialEvent(msg) {
  if (msg.role !== "assistant") return false;
  return isSpecialEventContent(normalizeContentToText(msg.content));
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

function isSystemRule(msg) {
  if (msg.role === "system") return true;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return true;
  return false;
}

// ========================
// 构建 Timeline
// ========================
function buildTimeline(kelivoMessages, tsDB) {
  const oldTimeline = loadTimeline();
  const newSystemMessages = kelivoMessages
    .filter(msg => msg.role === "system")
    .map(normalizeMessageForTimeline);
  const latestSP = newSystemMessages.length > 0 ? newSystemMessages[newSystemMessages.length - 1] : null;
  const oldSP = oldTimeline.find(msg => msg.role === "system");

  const newRealMessages = kelivoMessages
    .filter(isRealMessageForTimeline)
    .map(normalizeMessageForTimeline);

  const oldSpecialEvents = oldTimeline.filter(isSpecialEvent).sort((a, b) => {
    const timeA = extractTimestampWithMemory(a, tsDB);
    const timeB = extractTimestampWithMemory(b, tsDB);
    if (timeA && timeB) return timeA - timeB;
    return 0;
  });

  const merged = [...newRealMessages];
  for (const event of oldSpecialEvents) {
    const eventTime = extractTimestampWithMemory(event, tsDB);
    if (!eventTime) { merged.push(event); continue; }
    let inserted = false;
    for (let i = 0; i < merged.length; i++) {
      const msgTime = extractTimestampWithMemory(merged[i], tsDB);
      if (msgTime && msgTime >= eventTime) {
        merged.splice(i, 0, event);
        inserted = true;
        break;
      }
    }
    if (!inserted) merged.push(event);
  }

  const seen = new Set();
  const unique = merged.filter(msg => {
    const key = JSON.stringify({ role: msg.role, content: msg.content });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result = [];
  if (latestSP) result.push({ ...latestSP, position: 0 });
  else if (oldSP) result.push({ ...oldSP, position: 0 });

  let realPos = 1;
  const finalMessages = [];
  let pendingSpecial = [];
  for (const msg of unique) {
    if (isSpecialEvent(msg)) {
      pendingSpecial.push(msg);
    } else {
      if (pendingSpecial.length > 0) {
        const prevRealPos = realPos - 1;
        const step = 1 / (pendingSpecial.length + 1);
        for (let i = 0; i < pendingSpecial.length; i++) {
          finalMessages.push({ ...pendingSpecial[i], position: parseFloat((prevRealPos + step * (i + 1)).toFixed(4)) });
        }
        pendingSpecial = [];
      }
      finalMessages.push({ ...msg, position: realPos });
      realPos++;
    }
  }
  if (pendingSpecial.length > 0) {
    const lastRealPos = realPos - 1;
    for (let i = 0; i < pendingSpecial.length; i++) {
      finalMessages.push({ ...pendingSpecial[i], position: parseFloat((lastRealPos + 0.3 * (i + 1)).toFixed(4)) });
    }
  }

  result.push(...finalMessages);
  return result;
}

// ========================
// 兜底补时间戳（治本唤醒误判）
// ========================
// 批注 2026-08-31：wake_up.js 从 user 消息内容里挖英文数字格式时间戳
// （YYYY-MM-DD HH:mm）来定位"最后一条用户消息"。RikkaHub 注入的是中文日期
// （2026年8月31日），它认不出，且该注入时有时无；一旦认不出最新那条 user
// 消息的时间，它就会回退到更早消息，把"最后活动时间"算错 → 误触发唤醒。
// 这里在时间线存盘前，用服务器当前时刻给最新一条 user 消息补一个英文时间戳
// 前缀，保证 wake_up 永远认得出最新锚点。只改存进时间线的副本，不影响发给
// 模型的内容。
function ensureLastUserHasTimestamp(messages, now = new Date()) {
  // 与 wake_up.js parseTimelineTimestamp 等价的可解析判定
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = normalizeContentToText(m.content);
    const parsed = parseTimestampLabel(text);
    // 批注 2026-09-17：返回值就是这个锚点——已带可解析时间戳就用它，
    // 否则补一个并返回当前时刻。补不出任何 user 消息则返回 null。
    if (parsed) return parsed;
    m.content = `${formatDateTimeInTimeZone(now, TIME_ZONE)} ${text}`.trim();
    return now;
  }
  return null;
}

// ========================
// 追加特殊事件
// ========================
function appendSpecialEvent(content) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = { role: "assistant", content, position: maxPos + 0.5 };
  timeline.push(newEvent);
  saveTimeline(timeline);
  // 批注 2026-07-15：特殊事件可能包含推送正文；日志只记录长度，避免公开部署时泄漏私密内容。
  console.log(`\n已记录特殊事件 (position ${newEvent.position}, chars ${normalizeContentToText(content).length})\n`);
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

let wakeUpLastHeartbeat = null;

// ========================
// 预设方案
// ========================
const PRESETS_FILE = runtimeFile("presets.json");
// .env 是启动配置而不是运行数据；继续固定在代码目录，Railway 则始终以 Variables 为权威来源。
const ENV_FILE = path.join(PROJECT_DIR, ".env");
const PREFERRED_ENV_ORDER = [
  "TARGET_API_URL",
  "TARGET_API_KEY",
  "GATEWAY_API_KEY",
  "MODEL_NAME",
  "GATEWAY_CHAT_REASONING",
  "WAKE_REASONING",
  "AI_DISPLAY_NAME",
  "USER_DISPLAY_NAME",
  "BARK_KEY",
  "CUSTOM_ICON_URL",
  "ALLOW_PUBLIC_API",
  "PUSH_PROVIDER",
  "NTFY_SERVER_URL",
  "NTFY_TOPIC",
  "NTFY_TOKEN",
  "NTFY_PRIORITY",
  "NTFY_TAGS",
  "DIARY_ENABLED",
  "DIARY_DIR",
  "DATA_DIR",
  "PUSH_TIMEOUT_MS",
  "WAKE_UPSTREAM_TIMEOUT_MS",
  "REQUEST_BODY_LIMIT_MB",
  "MULTIMODAL_MODE",
  "DAY_WAKE_AFTER_MINUTES",
  "NIGHT_WAKE_AFTER_MINUTES",
  "DAY_CHECK_INTERVAL_MINUTES",
  "NIGHT_CHECK_INTERVAL_MINUTES",
  "WAKE_DAY_START_HOUR",
  "WAKE_DAY_END_HOUR",
  "WEATHER_ENABLED",
  "WEATHER_LOCATION_NAME",
  "WEATHER_LAT",
  "WEATHER_LON",
  "WEATHER_UNITS",
  "PORT",
  "GATEWAY_BASE_URL",
  "TIME_ZONE",
  "RESTART_COMMAND",
  "ADMIN_USER",
  "ADMIN_PASSWORD"
];

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try { return fs.readJsonSync(PRESETS_FILE); } catch { return []; }
}

function savePresets(presets) {
  writeJsonAtomicSync(PRESETS_FILE, presets);
}

function wantsJsonResponse(req) {
  const contentType = req.headers["content-type"] || "";
  const accept = req.headers.accept || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function loadEnvFileObject() {
  const result = {};
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  } catch {}
  return result;
}

function serializeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

function writeEnvUpdates(updates) {
  const merged = { ...loadEnvFileObject(), ...updates };
  const orderedKeys = [
    ...PREFERRED_ENV_ORDER.filter(key => Object.prototype.hasOwnProperty.call(merged, key)),
    ...Object.keys(merged)
      .filter(key => !PREFERRED_ENV_ORDER.includes(key))
      .sort()
  ];
  const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

function readRestartCommand() {
  return readEnvValue("RESTART_COMMAND") || DEFAULT_RESTART_COMMAND;
}

// ========================
// 安全：管理页走 Basic Auth，/v1 按公开开关鉴权，内部写接口只允许同进程容器 localhost
// ========================
app.addHook("onRequest", (req, reply, done) => {
  const requestPath = req.url.split("?")[0];
  const ip = String(req.ip || req.connection.remoteAddress || "");
  const headerKey = String(req.headers["x-gateway-api-key"] || req.headers["x-api-key"] || "").trim();
  const access = decideRequestAccess({
    path: requestPath,
    ip,
    isRailway: IS_RAILWAY_RUNTIME,
    allowPublicApi: readBooleanEnv("ALLOW_PUBLIC_API", false),
    configuredKey: readEnvValue("GATEWAY_API_KEY"),
    authorization: req.headers.authorization,
    headerKey
  });
  if (access.allow) return done();
  if (access.authRejected) {
    // 批注 2026-07-30：Kelivo 可能在模型探测或旧预设里继续带错 key；
    // 只记路径和 header 类型，帮助排查缓存/重复请求，绝不把任意密钥写入日志。
    console.warn(JSON.stringify({
      event: "gateway_auth_rejected",
      path: requestPath,
      auth_source: access.authSource || "missing"
    }));
  }
  reply.code(access.status || 403).send(access.status === 401 ? { error: access.error } : access.error);
});

app.get("/healthz", async () => ({ status: "ok" }));

// ========================
// Models
// ========================
app.get("/v1/models", async (req, reply) => {
  reply.send({
    object: "list",
    data: [{ id: configuredModelName(), object: "model", created: 0, owned_by: "gateway" }]
  });
});

// ========================
// Chat Completions
// ========================
app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    // 批注 2026-07-15：公开部署时日志不能默认写入完整上下文；
    // 这里只保留请求摘要，避免 system prompt、记忆和聊天正文进入 pm2 日志。
    console.log(JSON.stringify({
      event: "kelivo_request",
      model: body?.model || "",
      stream: body?.stream === true,
      messages: summarizeMessagesForLog(body?.messages || [])
    }));

    const kelivoMessages = body.messages || [];
    const oldTimeline = loadTimeline();

    const tsDB = loadTimestampDB();
    let tsDBDirty = false;
    for (const msg of kelivoMessages) {
      if (msg.role === "system") continue;
      if (msg.role === "tool") continue;
      const ts = extractTimestamp(normalizeContentToText(msg.content));
      if (!ts) continue;
      const fp = makeFingerprint(msg);
      const fpStripped = makeFingerprintStripped(msg);
      if (!tsDB[fp]) { tsDB[fp] = ts.toISOString(); tsDBDirty = true; }
      if (!tsDB[fpStripped]) { tsDB[fpStripped] = ts.toISOString(); tsDBDirty = true; }
    }
    if (tsDBDirty) saveTimestampDB(tsDB);

    // 批注 2026-09-17：护栏——请求里没有「用户真的说了话」，就不是一轮对话，
    // 不许拿它重建时间线。以前一次只有 <system> 注入（或纯工具续写）的请求，
    // 就能把历史 user 消息整体抹掉，wake_up 从此永远「未找到用户时间」，
    // 不推送、不写日记，而且不会自愈。
    const incomingUserTexts = kelivoMessages
      .filter(msg => msg.role === "user")
      .map(msg => normalizeContentToText(msg.content));

    if (!hasRealUserContent(incomingUserTexts)) {
      console.log(JSON.stringify({
        event: "timeline_rebuild_skipped",
        reason: "no_real_user_message",
        incoming: summarizeMessagesForLog(kelivoMessages)
      }));
    } else {
      const finalTimeline = buildTimeline(kelivoMessages, tsDB);
      // 批注 2026-08-31：存盘前给最新 user 消息兜底补英文时间戳，治本唤醒误判。
      const lastUserTime = ensureLastUserHasTimestamp(finalTimeline);
      saveTimeline(finalTimeline);
      // 批注 2026-09-17：顺手把锚点写进独立文件。时间线再怎么被玩家端重建，
      // 这份「用户最后说话的时刻」都不会跟着丢。
      if (lastUserTime) {
        writeAnchor(LAST_USER_TIME_FILE, lastUserTime, { source: "chat" });
      }
    }

    // Kelivo 发图时 content 常是数组。默认原样透传给视觉模型；
    // 如上游不支持图片，可设置 MULTIMODAL_MODE=text 退回文本占位。
    const llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);

    // 批注 2026-08-31：修复「网关把自动唤醒占位当成回复」。
    // 特殊事件里的「自动唤醒：本次未发送推送｜原因：…」是系统状态占位，不是 AI 对用户说的话。
    // 把它注入对话历史，会让模型误以为回复就该长这样，于是把占位格式直接当成对用户的回复吐出来。
    // 因此：①「本次未发送推送」的占位永远剔除，绝不注入对话（它是状态日志，不是对话内容）；
    // ②默认不再向对话注入任何唤醒/推送特殊事件（旁路状态本就不该进对话）。
    // 若想保留「模型知道自己刚发了推送」的连续性，可在 .env 设 INJECT_WAKE_EVENTS_TO_CHAT=true，
    // 此时也只会注入真正推送出去的事件（占位仍被上面的过滤器挡下）。
    const injectWakeEvents = readBooleanEnv("INJECT_WAKE_EVENTS_TO_CHAT", false);
    const oldEvents = stripPosition(
      oldTimeline
        .filter(isSpecialEvent)
        .filter(e => !isNoPushPlaceholderEvent(normalizeContentToText(e.content)))
        .filter(e => injectWakeEvents)
        .sort((a, b) => {
          const timeA = extractTimestampWithMemory(a, tsDB);
          const timeB = extractTimestampWithMemory(b, tsDB);
          if (timeA && timeB) return timeA - timeB;
          return 0;
        })
    );

    console.log("本次注入的特殊事件数量:", oldEvents.length);

    for (const event of oldEvents) {
      const eventTime = extractTimestampWithMemory(event, tsDB);
      if (!eventTime) { llmMessages.push(event); continue; }
      let inserted = false;
      for (let i = 0; i < llmMessages.length; i++) {
        const msgTime = extractTimestampWithMemory(llmMessages[i], tsDB);
        if (msgTime && msgTime >= eventTime) {
          llmMessages.splice(i, 0, event);
          inserted = true;
          break;
        }
      }
      if (!inserted) llmMessages.push(event);
    }



    console.log(JSON.stringify({
      event: "llm_forward_summary",
      messages: summarizeMessagesForLog(llmMessages)
    }));

    // ---- 自动修复不完整的 tool 调用（双向清理） ----
    // 第一遍：标记需要移除的索引
    const removeSet = new Set();

    // 检查 assistant tool_calls 是否完整
    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") {
          followingTools.push(nxt);
        } else {
          break;
        }
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      const complete = expectedIds.every(id => foundIds.includes(id));
      if (!complete) {
        // 标记这条 assistant 为移除，同时标记它后面的所有 tool 消息也移除
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") {
            removeSet.add(j);
          } else {
            break;
          }
        }
        console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
      }
    }

    // 检查孤立 tool 消息（前面没有对应的 tool_calls）
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      // 向前查找最近的 assistant
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          // 检查这个 tool_call_id 是否在 assistant 的 tool_calls 中
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) {
            hasMatchingToolCalls = true;
          }
          break;
        } else if (prev.role === "tool") {
          continue; // 继续向前找
        } else {
          break; // 遇到 user 或其他消息，停止
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
      }
    }

    // 按索引从大到小删除，避免索引错乱
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    if (!TARGET_API_URL || !process.env.TARGET_API_KEY) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" });
    }

    const requestedStream = body?.stream === true;

    const requestBody = { ...body, messages: llmMessages };

    // 批注 2026-08-31：网关聊天路径默认关闭 DeepSeek 思考模式。
    // RikkaHub 聊天/工具调用会携带 tools，思考模式下 DeepSeek 强制要求回传
    // reasoning_content，而 RikkaHub 不回传 → 报 400、消息发不出去。
    // 需要网关聊天也思考时可设 GATEWAY_CHAT_REASONING=on
    // （届时工具调用可能因 reasoning_content 未回传而报错）。
    if ((process.env.GATEWAY_CHAT_REASONING || "off").trim().toLowerCase() === "off") {
      requestBody.thinking = { type: "disabled" };
    }

    // 请求模型
    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    // 批注 2026-07-11：Kelivo 关闭 stream 时需要收到普通 JSON；只在请求或上游确认为 SSE 时才按流式直通。
    if (!shouldStreamResponse) {
      const responseText = await response.text();
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(responseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
    reply.raw.end();
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 内部接口：记录唤醒事件
// ========================
app.post("/internal/wake-event", async (req, reply) => {
  try {
    const { content } = req.body;
    if (!content) return reply.code(400).send({ error: "content is required" });
    appendSpecialEvent(content);
    reply.send({ success: true });
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 读取 .env 值
// ========================
function readEnvValue(key) {
  // 批注 2026-07-30：Railway Variables 是云端部署的权威配置源；
  // 容器内 .env 只作兜底，避免管理页保存出的临时文件覆盖平台变量。
  if (IS_RAILWAY_RUNTIME && process.env[key]) return process.env[key];
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return process.env[key] || "";
}

function readEnvValueOrDefault(key, fallback) {
  const value = readEnvValue(key);
  return value === "" ? fallback : value;
}

function normalizePositiveInteger(value, key, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeHour(value, key, fallback, min, max) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= min && n <= max) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeBooleanString(value, key, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return "true";
  if (["false", "0", "no", "off"].includes(raw)) return "false";
  return readEnvValueOrDefault(key, fallback);
}

function normalizeWeatherUnits(value) {
  return String(value || "").trim().toLowerCase() === "fahrenheit" ? "fahrenheit" : "metric";
}

function diaryDirectoryPath() {
  const configured = readEnvValueOrDefault("DIARY_DIR", "diary");
  return runtimeDirectory(configured, "diary");
}

// 批注 2026-09-17：日记的列举/读取搬到 diary_store.js，管理页不再一次性渲染全部正文。

// ========================
// HTTP Basic Auth
// ========================
function basicAuth(req, reply, done) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
    return;
  }
  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  if (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    done();
  } else {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
  }
}

// ========================
// 管理页面 GET /admin
// ========================
// 批注 2026-09-17：页面本体搬到 admin_page.js，这里只负责收集状态与配置。
// 日记区不再一次性渲染全部正文，只把「有日记的日期」交给页面，正文按天按需拉取。
function diaryDateInTimeZone() {
  const parts = getDatePartsInTimeZone(new Date(), TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeOnOff(value, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return "on";
  if (["false", "0", "no", "off"].includes(raw)) return "off";
  return fallback;
}

function normalizePushProvider(value) {
  return String(value || "").trim().toLowerCase() === "ntfy" ? "ntfy" : "bark";
}

function normalizeTimeZone(value) {
  const fallback = readEnvValueOrDefault("TIME_ZONE", "Asia/Shanghai");
  const candidate = String(value || "").trim();
  if (!candidate) return fallback;
  try {
    // 交给 Intl 判断这个时区名到底存不存在，避免把打错的时区写进 .env。
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return fallback;
  }
}

app.get("/admin", { preHandler: basicAuth }, async (req, reply) => {
  const serverUptime = Math.floor(process.uptime());
  const wakeUpStatus = wakeUpLastHeartbeat
    ? `在线（上次心跳: ${formatDateTimeInTimeZone(new Date(wakeUpLastHeartbeat), TIME_ZONE)}）`
    : "离线或未启动";

  const diaryFiles = listDiaryFiles(diaryDirectoryPath());
  const authToken = Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString("base64");
  const runtimeConfigNotice = IS_RAILWAY_RUNTIME
    ? `<div class="hint">Railway 检测到：此页面保存的是当前容器的 .env。Railway Variables 会优先提供运行时配置，且未挂载 Volume 的文件会在重新部署后丢失；请在 Railway Variables 修改唤醒数值并重新部署。</div>`
    : "";

  reply.type("text/html").send(renderAdminPage({
    serverUptime,
    wakeUpStatus,
    runtimeConfigNotice,
    authToken,
    presets: loadPresets(),
    timeline: readTimelineStats(),
    diary: {
      dates: diaryFiles.map(file => file.date),
      today: diaryDateInTimeZone(),
      latest: diaryFiles.length ? diaryFiles[0].date : null
    },
    config: {
      targetUrl: readEnvValue("TARGET_API_URL"),
      modelName: readEnvValue("MODEL_NAME"),
      customIcon: readEnvValue("CUSTOM_ICON_URL"),
      gatewayKeyStatus: readEnvValue("GATEWAY_API_KEY") ? "已配置" : "未配置",
      gatewayChatReasoning: normalizeOnOff(readEnvValueOrDefault("GATEWAY_CHAT_REASONING", "off"), "off"),
      wakeReasoning: normalizeOnOff(readEnvValueOrDefault("WAKE_REASONING", "on"), "on"),
      diaryEnabled: normalizeBooleanString(readEnvValueOrDefault("DIARY_ENABLED", "true"), "DIARY_ENABLED", "true"),
      diaryDir: readEnvValueOrDefault("DIARY_DIR", "diary"),
      pushProvider: normalizePushProvider(readEnvValueOrDefault("PUSH_PROVIDER", "bark")),
      aiDisplayName: readEnvValue("AI_DISPLAY_NAME"),
      userDisplayName: readEnvValue("USER_DISPLAY_NAME"),
      ntfyServerUrl: readEnvValueOrDefault("NTFY_SERVER_URL", "https://ntfy.sh"),
      ntfyTopic: readEnvValue("NTFY_TOPIC"),
      ntfyPriority: readEnvValue("NTFY_PRIORITY"),
      ntfyTags: readEnvValue("NTFY_TAGS"),
      allowPublicApi: normalizeBooleanString(readEnvValueOrDefault("ALLOW_PUBLIC_API", "false"), "ALLOW_PUBLIC_API", "false"),
      timeZone: readEnvValueOrDefault("TIME_ZONE", TIME_ZONE),
      multimodalMode: readEnvValueOrDefault("MULTIMODAL_MODE", "passthrough").toLowerCase() === "text" ? "text" : "passthrough",
      pushTimeoutMs: readEnvValueOrDefault("PUSH_TIMEOUT_MS", "15000"),
      wakeUpstreamTimeoutMs: readEnvValueOrDefault("WAKE_UPSTREAM_TIMEOUT_MS", "300000"),
      requestBodyLimitMb: readEnvValueOrDefault("REQUEST_BODY_LIMIT_MB", "50"),
      dayWakeAfter: readEnvValueOrDefault("DAY_WAKE_AFTER_MINUTES", "60"),
      nightWakeAfter: readEnvValueOrDefault("NIGHT_WAKE_AFTER_MINUTES", "120"),
      dayCheckInterval: readEnvValueOrDefault("DAY_CHECK_INTERVAL_MINUTES", "10"),
      nightCheckInterval: readEnvValueOrDefault("NIGHT_CHECK_INTERVAL_MINUTES", "120"),
      dayStartHour: readEnvValueOrDefault("WAKE_DAY_START_HOUR", "10"),
      dayEndHour: readEnvValueOrDefault("WAKE_DAY_END_HOUR", "24"),
      weatherEnabled: readEnvValueOrDefault("WEATHER_ENABLED", "false"),
      weatherLocationName: readEnvValue("WEATHER_LOCATION_NAME"),
      weatherLat: readEnvValue("WEATHER_LAT"),
      weatherLon: readEnvValue("WEATHER_LON"),
      weatherUnits: readEnvValueOrDefault("WEATHER_UNITS", "metric")
    }
  }));
});

// ========================
// 日记：按天读取 / 备份 / 导入
// ========================
// 批注 2026-09-17：日记不在 git 里（.gitignore 忽略 diary/），所以「备份到本地」是唯一
// 的异地副本手段。导出用自己写的 stored zip（标准格式、不加依赖）；导入只认
// YYYY-MM-DD.md，冲突时先留 .bak 再写。
app.get("/admin/diary/content", { preHandler: basicAuth }, async (req, reply) => {
  const date = String((req.query && req.query.date) || "").trim();
  if (!isValidDiaryName(`${date}.md`)) {
    return reply.code(400).send({ error: "日期格式应为 YYYY-MM-DD" });
  }

  const dir = diaryDirectoryPath();
  const name = `${date}.md`;
  const text = readDiaryText(dir, name);
  if (text === null) {
    return reply.send({ date, exists: false, message: "那天我没有写日记。" });
  }

  let updatedAt = "";
  try {
    updatedAt = formatDateTimeInTimeZone(fs.statSync(path.join(dir, name)).mtime, TIME_ZONE);
  } catch {}

  reply.send({ date, exists: true, content: text, size: Buffer.byteLength(text, "utf-8"), updated_at: updatedAt });
});

app.get("/admin/diary/export", { preHandler: basicAuth }, async (req, reply) => {
  const dir = diaryDirectoryPath();
  // 压缩包内按日期从旧到新排列，解压出来就是一条时间线。
  const files = listDiaryFiles(dir).reverse();
  if (!files.length) {
    return reply.code(404).send({ error: "还没有日记可以备份" });
  }

  const entries = files.map(file => ({
    name: file.name,
    content: readDiaryText(dir, file.name) || "",
    date: new Date(file.updated_at)
  }));
  const archive = buildZip(entries);
  const stamp = formatBackupStamp(new Date());
  console.log(`\n📦 日记备份：${entries.length} 个文件，${archive.length} 字节\n`);

  reply
    .header("Content-Type", "application/zip")
    .header("Content-Disposition", `attachment; filename="heartbeat-diary-${stamp}.zip"`)
    .send(archive);
});

app.post("/admin/diary/import", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const filename = String((req.query && req.query.filename) || "backup.zip").trim();
    const buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(String(req.body ?? ""), "utf-8");
    if (!buffer.length) {
      return reply.code(400).send({ error: "没有收到文件内容" });
    }

    const entries = /\.zip$/i.test(filename)
      ? readZipEntries(buffer)
      : [{ name: filename, content: buffer }];

    const summary = importDiaryEntries(diaryDirectoryPath(), entries);
    console.log(`\n📥 日记导入：${filename}｜新增 ${summary.added.length} 天｜替换 ${summary.replaced.length} 天｜跳过 ${summary.skipped.length} 条\n`);

    reply.send({ success: true, ...summary });
  } catch (err) {
    reply.code(400).send({ error: err.message || String(err) });
  }
});

// ========================
// 管理保存 POST /admin/save
// ========================
app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const {
      target_url,
      target_key,
      gateway_api_key,
      model_name,
      bark_key,
      custom_icon,
      gateway_chat_reasoning,
      wake_reasoning,
      diary_enabled,
      push_provider,
      ai_display_name,
      user_display_name,
      ntfy_server_url,
      ntfy_topic,
      ntfy_token,
      ntfy_priority,
      ntfy_tags,
      allow_public_api,
      time_zone,
      multimodal_mode,
      push_timeout_ms,
      wake_upstream_timeout_ms,
      request_body_limit_mb,
      day_wake_after,
      night_wake_after,
      day_check_interval,
      night_check_interval,
      wake_day_start_hour,
      wake_day_end_hour,
      weather_enabled,
      weather_location_name,
      weather_lat,
      weather_lon,
      weather_units
    } = req.body || {};

    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "target_url / model_name 必填" });
    }

    // 批注 2026-06-26：公开版把唤醒策略和天气信息开放到管理页；保存时做轻量校验，避免空值把运行中的唤醒节奏写坏。
    // 批注 2026-07-15：GATEWAY_API_KEY 是公开 /v1 的客户端鉴权 key，不能和上游 TARGET_API_KEY 混在一起展示或返回。
    // 批注 2026-09-17：密钥类字段一律"留空即保留旧值"；ADMIN_USER / ADMIN_PASSWORD 不放进管理页，
    // 且只在能从现有配置里读到值时才回写，避免把 .env 里的管理员账号清空后把自己锁在门外。
    const finalTargetKey = target_key || readEnvValue("TARGET_API_KEY");
    const finalGatewayKey = gateway_api_key || readEnvValue("GATEWAY_API_KEY");
    const finalBarkKey = bark_key || readEnvValue("BARK_KEY");
    const finalNtfyToken = ntfy_token || readEnvValue("NTFY_TOKEN");

    const updates = {
      TARGET_API_URL: target_url,
      TARGET_API_KEY: finalTargetKey,
      GATEWAY_API_KEY: finalGatewayKey,
      MODEL_NAME: model_name,
      BARK_KEY: finalBarkKey,
      CUSTOM_ICON_URL: custom_icon || "",
      GATEWAY_CHAT_REASONING: normalizeOnOff(gateway_chat_reasoning, readEnvValueOrDefault("GATEWAY_CHAT_REASONING", "off")),
      WAKE_REASONING: normalizeOnOff(wake_reasoning, readEnvValueOrDefault("WAKE_REASONING", "on")),
      DIARY_ENABLED: normalizeBooleanString(diary_enabled, "DIARY_ENABLED", "true"),
      PUSH_PROVIDER: normalizePushProvider(push_provider),
      AI_DISPLAY_NAME: String(ai_display_name || "").trim(),
      USER_DISPLAY_NAME: String(user_display_name || "").trim(),
      NTFY_SERVER_URL: String(ntfy_server_url || "").trim() || "https://ntfy.sh",
      NTFY_TOPIC: String(ntfy_topic || "").trim(),
      NTFY_TOKEN: finalNtfyToken,
      NTFY_PRIORITY: String(ntfy_priority || "").trim(),
      NTFY_TAGS: String(ntfy_tags || "").trim(),
      ALLOW_PUBLIC_API: normalizeBooleanString(allow_public_api, "ALLOW_PUBLIC_API", "false"),
      TIME_ZONE: normalizeTimeZone(time_zone),
      MULTIMODAL_MODE: String(multimodal_mode || "").trim().toLowerCase() === "text" ? "text" : "passthrough",
      PUSH_TIMEOUT_MS: normalizePositiveInteger(push_timeout_ms, "PUSH_TIMEOUT_MS", "15000"),
      WAKE_UPSTREAM_TIMEOUT_MS: normalizePositiveInteger(wake_upstream_timeout_ms, "WAKE_UPSTREAM_TIMEOUT_MS", "300000"),
      REQUEST_BODY_LIMIT_MB: normalizePositiveInteger(request_body_limit_mb, "REQUEST_BODY_LIMIT_MB", "50"),
      DAY_WAKE_AFTER_MINUTES: normalizePositiveInteger(day_wake_after, "DAY_WAKE_AFTER_MINUTES", "60"),
      NIGHT_WAKE_AFTER_MINUTES: normalizePositiveInteger(night_wake_after, "NIGHT_WAKE_AFTER_MINUTES", "120"),
      DAY_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(day_check_interval, "DAY_CHECK_INTERVAL_MINUTES", "10"),
      NIGHT_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(night_check_interval, "NIGHT_CHECK_INTERVAL_MINUTES", "120"),
      WAKE_DAY_START_HOUR: normalizeHour(wake_day_start_hour, "WAKE_DAY_START_HOUR", "10", 0, 23),
      WAKE_DAY_END_HOUR: normalizeHour(wake_day_end_hour, "WAKE_DAY_END_HOUR", "24", 1, 24),
      WEATHER_ENABLED: normalizeBooleanString(weather_enabled, "WEATHER_ENABLED", "false"),
      WEATHER_LOCATION_NAME: weather_location_name || "",
      WEATHER_LAT: weather_lat || "",
      WEATHER_LON: weather_lon || "",
      WEATHER_UNITS: normalizeWeatherUnits(weather_units)
    };

    const adminUser = readEnvValue("ADMIN_USER");
    const adminPassword = readEnvValue("ADMIN_PASSWORD");
    if (adminUser) updates.ADMIN_USER = adminUser;
    if (adminPassword) updates.ADMIN_PASSWORD = adminPassword;

    writeEnvUpdates(updates);
    console.log("\n✅ .env 已更新，可通过管理页重启服务\n");

    if (wantsJsonResponse(req)) {
      return reply.send({ success: true });
    }

    reply.type("text/html").send(`<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>已保存</title></head>
<body style="text-align:center;font-family:-apple-system,sans-serif;padding:40px;">
  <h2>✅ 配置已保存</h2>
  <p>现在可以返回管理页，点击重启按钮让新配置生效。</p>
  <a href="/admin">← 返回设置</a>
</body></html>`);
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 保存预设方案
// ========================
app.post("/admin/presets/save", { preHandler: basicAuth }, async (req, reply) => {
  const { name, target_url, target_key, model_name } = req.body || {};
  if (!name || !target_url || !model_name) {
    return reply.code(400).send({ error: "name / target_url / model_name 必填" });
  }
  const presets = loadPresets();
  const existing = presets.findIndex(p => p.name === name);
  const entry = { name, target_url, target_key: target_key || "", model_name };
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 删除预设方案
// ========================
app.post("/admin/presets/delete", { preHandler: basicAuth }, async (req, reply) => {
  const { name } = req.body || {};
  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 心跳接口
// ========================
app.post("/internal/heartbeat", async (req, reply) => {
  wakeUpLastHeartbeat = Date.now();
  reply.send({ status: "ok" });
});

// ========================
// 管理页一键重启
// ========================
app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  const restartCommand = readRestartCommand();

  // 立即回复，避免重启时连接中断
  reply.send({ success: true, output: `重启指令已发送：${restartCommand}` });
  
  // 稍后重启。默认只重启本项目的两个进程；可通过 RESTART_COMMAND 自定义。
  const { exec } = require("child_process");
  exec(restartCommand, (err, stdout, stderr) => {
    if (err) {
      console.error("重启失败:", stderr);
    } else {
      console.log("服务已重启:", stdout);
    }
  });
});

// ========================
// 测试 Bark
// ========================
app.get("/test-bark", { preHandler: basicAuth }, async (req, reply) => {
  const formattedTime = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  appendSpecialEvent(`（${formattedTime} 刚刚给用户发了 Bark：这是一条测试推送。）`);
  reply.send({ success: true });
});

// 批注 2026-08-10：公网测试入口归入 /admin 并沿用 Basic Auth；旧 /test-bark 只保留给本机兼容，
// 避免平台反代把外部请求伪装成私网来源后向时间线写入假事件。
app.get("/admin/test-bark", { preHandler: basicAuth }, async (req, reply) => {
  const formattedTime = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  appendSpecialEvent(`（${formattedTime} 刚刚给用户发了 Bark：这是一条测试推送。）`);
  reply.send({ success: true });
});

// ========================
// 启动服务
// ========================
app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  // 只打印是否配置，不输出 URL、Key、用户名、聊天内容或 Volume 名称。
  console.log(JSON.stringify({
    event: "runtime_config_summary",
    railway: IS_RAILWAY_RUNTIME,
    persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
    target_url_configured: Boolean(TARGET_API_URL),
    target_key_configured: Boolean(process.env.TARGET_API_KEY),
    model_configured: Boolean(process.env.MODEL_NAME),
    gateway_key_configured: Boolean(readEnvValue("GATEWAY_API_KEY")),
    data_dir_ready: fs.existsSync(DATA_DIR)
  }));
  console.log(`✅ Gateway 运行在 ${address}`);
});
