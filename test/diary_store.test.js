const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isValidDiaryName,
  diaryDateOf,
  listDiaryFiles,
  readDiaryText,
  formatBackupStamp,
  crc32,
  buildZip,
  readZipEntries,
  importDiaryEntries
} = require("../diary_store");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dylan-diary-"));
}

function writeDiary(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

// 手工造一个 deflate 压缩的 zip，用来验证读取端不只是能吃自己写的 stored 包。
function makeDeflatedZip(name, text) {
  const nameBuffer = Buffer.from(name, "utf-8");
  const raw = Buffer.from(text, "utf-8");
  const deflated = zlib.deflateRawSync(raw);
  const checksum = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);

  const centralBuffer = Buffer.concat([central, nameBuffer]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(local.length + nameBuffer.length + deflated.length, 16);

  return Buffer.concat([local, nameBuffer, deflated, centralBuffer, eocd]);
}

test("只认严格 YYYY-MM-DD.md 的日记名", () => {
  assert.equal(isValidDiaryName("2026-09-17.md"), true);
  assert.equal(isValidDiaryName("2026-09-17.md.bak-20260917-190000"), false);
  assert.equal(isValidDiaryName("2026-9-17.md"), false);
  assert.equal(isValidDiaryName("../2026-09-17.md"), false);
  assert.equal(isValidDiaryName("2026-09-17.txt"), false);
  assert.equal(diaryDateOf("2026-09-17.md"), "2026-09-17");
});

test("列表只给元数据、按日期倒序，且跳过备份与杂物", () => {
  const dir = makeTempDir();
  try {
    writeDiary(dir, "2026-09-14.md", "a");
    writeDiary(dir, "2026-09-16.md", "bb");
    writeDiary(dir, "2026-09-15.md", "ccc");
    writeDiary(dir, "2026-09-15.md.bak-20260917-190000", "旧版");
    writeDiary(dir, "notes.txt", "杂物");
    fs.mkdirSync(path.join(dir, "_backup"));

    const files = listDiaryFiles(dir);
    assert.deepEqual(files.map(f => f.name), ["2026-09-16.md", "2026-09-15.md", "2026-09-14.md"]);
    assert.equal(files[0].size, 2);
    assert.equal(typeof files[0].updated_at, "string");
    assert.equal(Object.prototype.hasOwnProperty.call(files[0], "content"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("读取单个日记时挡掉路径穿越与不合法名字", () => {
  const dir = makeTempDir();
  try {
    writeDiary(dir, "2026-09-16.md", "日记正文");
    assert.equal(readDiaryText(dir, "2026-09-16.md"), "日记正文");
    assert.equal(readDiaryText(dir, "../2026-09-16.md"), null);
    assert.equal(readDiaryText(dir, "sub/2026-09-16.md"), null);
    assert.equal(readDiaryText(dir, "2026-09-17.md"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crc32 与标准实现一致", () => {
  assert.equal(crc32(Buffer.from("123456789", "utf-8")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("buildZip 写出的包能被自己读回，中文不丢", () => {
  const zip = buildZip([
    { name: "2026-09-15.md", content: "## 2026-09-15 22:00\n\n今天的月亮很安静。\n" },
    { name: "2026-09-16.md", content: "## 2026-09-16 07:22\n\n她睡到很晚。\n" }
  ]);

  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "2026-09-15.md");
  assert.equal(entries[0].content.toString("utf-8"), "## 2026-09-15 22:00\n\n今天的月亮很安静。\n");
  assert.equal(entries[1].content.toString("utf-8"), "## 2026-09-16 07:22\n\n她睡到很晚。\n");
});

test("buildZip 空列表产出合法但空的包", () => {
  const entries = readZipEntries(buildZip([]));
  assert.deepEqual(entries, []);
});

test("读取端支持 deflate 压缩的 zip", () => {
  const entries = readZipEntries(makeDeflatedZip("2026-09-10.md", "被压缩过的日记"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content.toString("utf-8"), "被压缩过的日记");
});

test("不是 zip 的输入给出明确报错", () => {
  assert.throws(() => readZipEntries(Buffer.from("这不是压缩包")), /不是有效的 zip 文件/);
});

test("导入：新的一天直接落盘", () => {
  const dir = makeTempDir();
  try {
    const summary = importDiaryEntries(dir, [{ name: "2026-09-12.md", content: "第一行\n" }]);
    assert.deepEqual(summary.added, ["2026-09-12.md"]);
    assert.deepEqual(summary.replaced, []);
    assert.deepEqual(summary.skipped, []);
    assert.equal(fs.readFileSync(path.join(dir, "2026-09-12.md"), "utf-8"), "第一行\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("导入：同一天已存在时先留备份再替换，原文不丢", () => {
  const dir = makeTempDir();
  try {
    writeDiary(dir, "2026-09-12.md", "旧的");
    const summary = importDiaryEntries(dir, [{ name: "2026-09-12.md", content: "新的" }]);

    assert.deepEqual(summary.added, []);
    assert.equal(summary.replaced.length, 1);
    assert.equal(summary.replaced[0].name, "2026-09-12.md");
    assert.match(summary.replaced[0].backup, /^2026-09-12\.md\.bak-\d{8}-\d{6}$/);
    assert.equal(fs.readFileSync(path.join(dir, "2026-09-12.md"), "utf-8"), "新的");
    assert.equal(fs.readFileSync(path.join(dir, summary.replaced[0].backup), "utf-8"), "旧的");
    // 备份文件不会污染日记列表
    assert.deepEqual(listDiaryFiles(dir).map(f => f.name), ["2026-09-12.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("导入：跳过非法文件名、空内容，并报告原因", () => {
  const dir = makeTempDir();
  try {
    const summary = importDiaryEntries(dir, [
      { name: "../2026-09-13.md", content: "穿越" },
      { name: "2026-9-13.md", content: "月份没补零" },
      { name: "2026-09-13.md", content: "   " },
      { name: "README.md", content: "杂物" }
    ]);

    assert.deepEqual(summary.added, []);
    assert.equal(summary.skipped.length, 4);
    assert.equal(summary.total, 4);
    assert.ok(summary.skipped.every(item => item.reason));
    assert.equal(fs.existsSync(path.join(dir, "../2026-09-13.md")), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("导入：zip 里的嵌套路径取 basename 落盘", () => {
  const dir = makeTempDir();
  try {
    const summary = importDiaryEntries(dir, [
      { name: "diary/2026-09-14.md", content: "嵌套路径" },
      { name: "diary\\2026-09-15.md", content: "反斜杠路径" }
    ]);
    assert.deepEqual(summary.added.sort(), ["2026-09-14.md", "2026-09-15.md"]);
    assert.equal(fs.readFileSync(path.join(dir, "2026-09-14.md"), "utf-8"), "嵌套路径");
    assert.equal(fs.readFileSync(path.join(dir, "2026-09-15.md"), "utf-8"), "反斜杠路径");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("导入：同一份备份里重复日期只留最后一份", () => {
  const dir = makeTempDir();
  try {
    const summary = importDiaryEntries(dir, [
      { name: "2026-09-16.md", content: "第一次" },
      { name: "2026-09-16.md", content: "第二次" }
    ]);
    assert.deepEqual(summary.added, ["2026-09-16.md"]);
    assert.equal(summary.skipped.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, "2026-09-16.md"), "utf-8"), "第二次");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("导出后再导入是幂等往返（除备份外无副作用）", () => {
  const dir = makeTempDir();
  const restored = makeTempDir();
  try {
    writeDiary(dir, "2026-09-15.md", "十五号\n");
    writeDiary(dir, "2026-09-16.md", "十六号\n");

    const zip = buildZip(
      listDiaryFiles(dir).reverse().map(file => ({
        name: file.name,
        content: readDiaryText(dir, file.name)
      }))
    );
    const summary = importDiaryEntries(restored, readZipEntries(zip));

    assert.equal(summary.added.length, 2);
    assert.deepEqual(listDiaryFiles(restored).map(f => f.name), ["2026-09-16.md", "2026-09-15.md"]);
    assert.equal(readDiaryText(restored, "2026-09-15.md"), "十五号\n");
    assert.equal(readDiaryText(restored, "2026-09-16.md"), "十六号\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(restored, { recursive: true, force: true });
  }
});

test("备份时间戳是可读的 YYYYMMDD-HHMMSS", () => {
  const stamp = formatBackupStamp(new Date(2026, 8, 17, 19, 5, 3));
  assert.equal(stamp, "20260917-190503");
});
