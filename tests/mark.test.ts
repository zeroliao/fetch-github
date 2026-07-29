import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMarkContentSize,
  isSafeMarkName,
  markActionSchema,
  markContentSize,
  markExtension,
  MAX_MARK_FILE_BYTES,
} from "../src/lib/mark";
import { createTextZip } from "../src/lib/zip";

test("临时文本名称会拒绝路径穿越和路径分隔符", () => {
  assert.equal(isSafeMarkName("需求记录.md"), true);
  assert.equal(isSafeMarkName("../secret.txt"), false);
  assert.equal(isSafeMarkName("folder/file.txt"), false);
  assert.equal(isSafeMarkName("folder\\file.txt"), false);
  assert.equal(
    markActionSchema.safeParse({
      action: "createFile",
      name: "../secret.txt",
      directoryId: null,
      content: "secret",
    }).success,
    false,
  );
});

test("目录和文件重命名 action 只接受安全名称", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    markActionSchema.safeParse({ action: "renameDirectory", id, name: "归档" })
      .success,
    true,
  );
  assert.equal(
    markActionSchema.safeParse({ action: "renameFile", id, name: "notes.md" })
      .success,
    true,
  );
  assert.equal(
    markActionSchema.safeParse({
      action: "renameFile",
      id,
      name: "../notes.md",
    }).success,
    false,
  );
});

test("文本格式和 UTF-8 字节数会被正确识别", () => {
  assert.equal(markExtension("notes.md"), "md");
  assert.equal(markExtension(".env"), "env");
  assert.equal(markExtension("README"), "txt");
  assert.equal(markContentSize("中文"), 6);
  assert.equal(
    assertMarkContentSize("a".repeat(MAX_MARK_FILE_BYTES)),
    MAX_MARK_FILE_BYTES,
  );
  assert.throws(
    () => assertMarkContentSize("a".repeat(MAX_MARK_FILE_BYTES + 1)),
    /mark_file_too_large/,
  );
});

test("目录导出会生成带 UTF-8 文件名和原始文本内容的 ZIP", () => {
  const zip = createTextZip([
    { path: "需求/记录.md", content: "# 临时内容\nhello" },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800);
  const nameLength = zip.readUInt16LE(26);
  const contentLength = zip.readUInt32LE(18);
  assert.equal(
    zip.subarray(30, 30 + nameLength).toString("utf8"),
    "需求/记录.md",
  );
  assert.equal(
    zip
      .subarray(30 + nameLength, 30 + nameLength + contentLength)
      .toString("utf8"),
    "# 临时内容\nhello",
  );
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});
