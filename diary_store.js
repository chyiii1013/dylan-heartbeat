// 批注 2026-09-17：日记的列举、读取、备份（zip）与导入集中放在这里。
// 设计取舍：
//   1. 不引入第三方压缩依赖。zip 写入用 stored（不压缩）写出标准格式，读取同时支持
//      stored 与 deflate（Node 内置 zlib），目的是让 Termux 部署不需要再 npm install。
//   2. 日记文件名的合法性只由 DIARY_NAME_PATTERN 一条规则决定（严格 YYYY-MM-DD.md），
//      导入时一律取 basename，"../" 之类的路径穿越在名字校验这一步就被挡掉。
//   3. 导入遇到同一天已有日记时先复制一份备份（.bak-YYYYMMDD-HHMMSS），再原子写入新内容，
//      不删任何东西，随时可回滚。
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DIARY_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
// EOCD 注释最长 65535 字节，往回扫这么多没找到就不是 zip。
const ZIP_EOCD_SCAN_BYTES = 65_557 + 22;

function isValidDiaryName(name) {
  return DIARY_NAME_PATTERN.test(String(name || ""));
}

function diaryDateOf(name) {
  return isValidDiaryName(name) ? String(name).slice(0, 10) : "";
}

// 仅列举严格 YYYY-MM-DD.md 的文件：备份文件（.bak-…）和其他杂物不会混进列表。
// 返回按日期倒序（新的在前）的元数据，不含正文——admin 页面因此不再需要一次渲染全部正文。
function listDiaryFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => isValidDiaryName(name))
      .map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return {
          name,
          date: diaryDateOf(name),
          size: stat.size,
          updated_at: stat.mtime.toISOString()
        };
      })
      .filter(entry => fs.statSync(path.join(dir, entry.name)).isFile())
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  } catch {
    return [];
  }
}

// 名字不合法（含任何路径成分）一律当作不存在，避免把目录外的东西读出来。
function readDiaryText(dir, name) {
  if (!isValidDiaryName(name) || path.basename(String(name)) !== String(name)) return null;
  const filePath = path.join(dir, name);
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function formatBackupStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  const safe = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(0);
  return `${safe.getFullYear()}${pad(safe.getMonth() + 1)}${pad(safe.getDate())}`
    + `-${pad(safe.getHours())}${pad(safe.getMinutes())}${pad(safe.getSeconds())}`;
}

// ========================
// zip 写入（stored）
// ========================
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let current = i;
    for (let bit = 0; bit < 8; bit++) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[i] = current;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function toDosDateTime(date) {
  const safe = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(0);
  const year = Math.min(2107, Math.max(1980, safe.getFullYear()));
  return {
    time: (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate()
  };
}

// entries: [{ name, content, date }]，content 可以是字符串或 Buffer。
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const nameBuffer = Buffer.from(String(entry && entry.name ? entry.name : ""), "utf-8");
    const contentBuffer = Buffer.isBuffer(entry && entry.content)
      ? entry.content
      : Buffer.from(String((entry && entry.content) ?? ""), "utf-8");
    const { time, date } = toDosDateTime(entry && entry.date);
    const checksum = crc32(contentBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // bit11：文件名按 UTF-8 解释
    localHeader.writeUInt16LE(0, 8);      // 0 = stored
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contentBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    locals.push(localHeader, nameBuffer, contentBuffer);
    centrals.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + contentBuffer.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

// ========================
// zip 读取（stored + deflate）
// ========================
function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - ZIP_EOCD_SCAN_BYTES);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) return i;
  }
  return -1;
}

// 支持自己导出的 zip，也支持常见的压缩 zip；不支持 zip64（日记量级用不到）。
function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const eocdOffset = findEndOfCentralDirectory(buf);
  if (eocdOffset < 0) throw new Error("不是有效的 zip 文件（找不到中央目录）");

  const total = buf.readUInt16LE(eocdOffset + 10);
  let offset = buf.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let i = 0; i < total; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("zip 中央目录损坏");
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLength).toString("utf-8");
    offset += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("暂不支持 zip64 格式的备份文件");
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`zip 条目损坏：${name}`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.slice(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`zip 使用了不支持的压缩方式（${method}）：${name}`);

    entries.push({ name, content });
  }

  return entries;
}

// ========================
// 导入
// ========================
// 同一天已有日记 -> 先留一份 .bak-<stamp>，再原子替换；不合法的条目只跳过并报告原因。
function importDiaryEntries(dir, entries, options = {}) {
  const stamp = options.stamp || formatBackupStamp(options.now instanceof Date ? options.now : new Date());
  const summary = { total: 0, added: [], replaced: [], skipped: [] };
  const list = Array.isArray(entries) ? entries : [];
  summary.total = list.length;

  // 同一个日期在一份备份里出现多次时只保留最后一份，避免自己覆盖自己。
  const byName = new Map();
  for (const entry of list) {
    const rawName = String((entry && entry.name) || "");
    const base = path.basename(rawName.replace(/\\/g, "/"));
    if (byName.has(base)) {
      summary.skipped.push({ name: rawName, reason: "同一份备份里重复出现，只保留最后一份" });
    }
    byName.set(base, { rawName, entry });
  }

  fs.mkdirSync(dir, { recursive: true });

  for (const { rawName, entry } of byName.values()) {
    const flat = rawName.replace(/\\/g, "/");
    const base = path.basename(flat);
    if (!isValidDiaryName(base) || flat.includes("..")) {
      summary.skipped.push({ name: rawName, reason: "文件名必须是 YYYY-MM-DD.md" });
      continue;
    }
    const text = Buffer.isBuffer(entry && entry.content)
      ? entry.content.toString("utf-8")
      : String((entry && entry.content) ?? "");
    if (!text.trim()) {
      summary.skipped.push({ name: base, reason: "内容为空" });
      continue;
    }

    const target = path.join(dir, base);
    let backup = "";
    if (fs.existsSync(target)) {
      backup = `${base}.bak-${stamp}`;
      fs.copyFileSync(target, path.join(dir, backup));
    }

    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, text, "utf-8");
    fs.renameSync(temporary, target);

    if (backup) summary.replaced.push({ name: base, backup });
    else summary.added.push(base);
  }

  return summary;
}

module.exports = {
  DIARY_NAME_PATTERN,
  isValidDiaryName,
  diaryDateOf,
  listDiaryFiles,
  readDiaryText,
  formatBackupStamp,
  crc32,
  buildZip,
  readZipEntries,
  importDiaryEntries
};
