import { deflateRawSync, inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { providerModelSchema } from "@/lib/validation";
import {
  MAX_AI_PROVIDER_MODELS,
  type AiProvider,
  type AiProviderFailureCode,
} from "@/lib/types";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 32;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const HEADERS = [
  "model",
  "kind",
  "dimensions",
  "priority",
  "reasoningEffort",
  "enabled",
  "timeoutSeconds",
  "cooldownSeconds",
  "cooldownOn",
] as const;

export type PortableProviderModel = Omit<
  AiProvider,
  | "id"
  | "providerGroupId"
  | "name"
  | "type"
  | "baseUrl"
  | "apiKeyEnv"
  | "availabilityStatus"
  | "createdAt"
  | "updatedAt"
  | "groupEnabled"
  | "proxyUrlEnv"
  | "unavailableCode"
  | "unavailableReason"
  | "recoverySuggestion"
  | "unavailableAt"
  | "lastCheckedAt"
  | "recoveredAt"
  | "cooldownUntil"
  | "archivedAt"
  | "rateLimit"
>;

function fail(message: string): never {
  throw new Error(message);
}

function normalizeModels(value: unknown): PortableProviderModel[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_AI_PROVIDER_MODELS
  )
    fail(`模型文件必须包含 1-${MAX_AI_PROVIDER_MODELS} 个模型。`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const parsed = providerModelSchema.safeParse(item);
    if (!parsed.success) fail(`第 ${index + 1} 个模型字段无效。`);
    const model = parsed.data;
    const key = `${model.kind}:${model.model.toLowerCase()}`;
    if (seen.has(key)) fail(`文件内存在重复模型：${model.model}。`);
    seen.add(key);
    return {
      kind: model.kind,
      model: model.model,
      ...(model.dimensions === undefined
        ? {}
        : { dimensions: model.dimensions }),
      priority: model.priority,
      ...(model.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: model.reasoningEffort }),
      enabled: model.enabled,
      ...(model.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: model.timeoutSeconds }),
      cooldownSeconds: model.cooldownSeconds,
      cooldownOn: model.cooldownOn,
    };
  });
}

export function parseProviderModelsJson(text: string): PortableProviderModel[] {
  if (Buffer.byteLength(text, "utf8") > MAX_UPLOAD_BYTES)
    fail("导入文件超过 2 MB 限制。");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("JSON 文件格式无效。");
  }
  if (
    !value ||
    typeof value !== "object" ||
    ("version" in value && value.version !== 1)
  )
    fail("不支持的模型文件版本。");
  return normalizeModels((value as { models?: unknown }).models ?? value);
}

function xmlEscape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
}

function xmlUnescape(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) =>
      ({
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      })[entity]!,
  );
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value, 0);
  return result;
}
function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    locals.push(local);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(8),
        u16(0),
        u16(0),
        u32(crc),
        u32(compressed.length),
        u32(entry.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const centralData = Buffer.concat(central);
  return Buffer.concat([
    ...locals,
    centralData,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralData.length),
    u32(offset),
    u16(0),
  ]);
}

export function createProviderModelsXlsx(
  models: PortableProviderModel[],
): Buffer {
  const rows = [
    HEADERS.map(
      (header) => `<c t="inlineStr"><is><t>${xmlEscape(header)}</t></is></c>`,
    ).join(""),
  ];
  for (const model of models) {
    const values: Array<string | number | boolean> = [
      model.model,
      model.kind,
      model.dimensions ?? "",
      model.priority,
      model.reasoningEffort ?? "",
      model.enabled,
      model.timeoutSeconds ?? "",
      model.cooldownSeconds ?? "",
      (model.cooldownOn ?? []).join(","),
    ];
    rows.push(
      values
        .map((value) =>
          typeof value === "number"
            ? `<c><v>${value}</v></c>`
            : typeof value === "boolean"
              ? `<c t="b"><v>${value ? 1 : 0}</v></c>`
              : `<c t="inlineStr"><is><t>${xmlEscape(String(value))}</t></is></c>`,
        )
        .join(""),
    );
  }
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, index) => `<row r="${index + 1}">${row}</row>`).join("")}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="models" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    { name: "xl/workbook.xml", data: Buffer.from(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]);
}

function unzip(data: Buffer): Map<string, Buffer> {
  if (data.length > MAX_UPLOAD_BYTES) fail("导入文件超过 2 MB 限制。");
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > data.length) fail("XLSX 文件结构无效。");
  const count = data.readUInt16LE(eocd + 10);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES || centralOffset >= data.length)
    fail("XLSX 文件条目数量无效。");
  const result = new Map<string, Buffer>();
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50)
      fail("XLSX 中央目录无效。");
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (
      !name ||
      name.includes("..") ||
      name.startsWith("/") ||
      result.has(name)
    )
      fail("XLSX 包含不安全或重复条目。");
    if (flags & 1) fail("不支持加密的 XLSX 文件。");
    if (
      size > MAX_UNCOMPRESSED_BYTES ||
      (total += size) > MAX_UNCOMPRESSED_BYTES ||
      localOffset + 30 > data.length
    )
      fail("XLSX 解压后体积超限。");
    if (data.readUInt32LE(localOffset) !== 0x04034b50)
      fail("XLSX 本地目录无效。");
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > data.length) fail("XLSX 压缩数据不完整。");
    const compressed = data.subarray(start, end);
    let content: Buffer;
    try {
      content =
        method === 0
          ? Buffer.from(compressed)
          : method === 8
            ? inflateRawSync(compressed, {
                maxOutputLength: MAX_UNCOMPRESSED_BYTES,
              })
            : fail("XLSX 使用了不支持的压缩方式。");
    } catch {
      fail("XLSX 解压失败。");
    }
    if (content.length !== size) fail("XLSX 解压大小校验失败。");
    if (crc32(content) !== data.readUInt32LE(cursor + 16))
      fail("XLSX 内容校验失败。");
    result.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function cellValue(cell: string, sharedStrings: string[]): string {
  const type = /\bt="([^"]+)"/.exec(cell)?.[1];
  const value =
    type === "inlineStr"
      ? (/<t[^>]*>([\s\S]*?)<\/t>/.exec(cell)?.[1] ?? "")
      : (/<v[^>]*>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? "");
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  return xmlUnescape(value);
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/i.exec(reference)?.[0].toUpperCase() ?? "";
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

export function parseProviderModelsXlsx(data: Buffer): PortableProviderModel[] {
  const files = unzip(data);
  const sheet = files.get("xl/worksheets/sheet1.xml");
  if (!sheet) fail("XLSX 缺少首个工作表。");
  const sharedStrings = [
    ...(files
      .get("xl/sharedStrings.xml")
      ?.toString("utf8")
      .matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g) ?? []),
  ].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((item) => xmlUnescape(item[1]))
      .join(""),
  );
  const rows = [
    ...sheet.toString("utf8").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g),
  ].map((match) => {
    const cells: string[] = [];
    for (const cellMatch of match[1].matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g,
    )) {
      const attributes = cellMatch[1] ?? cellMatch[3] ?? "";
      const reference = /\br="([^"]+)"/.exec(attributes)?.[1];
      const index = reference ? columnIndex(reference) : cells.length;
      while (cells.length <= index) cells.push("");
      cells[index] = cellValue(cellMatch[0], sharedStrings);
    }
    return cells;
  });
  if (rows.length < 2) fail("XLSX 至少需要一行模型数据。");
  if (rows[0].join("\u0000") !== HEADERS.join("\u0000"))
    fail(`XLSX 首行必须是：${HEADERS.join(", ")}。`);
  return normalizeModels(
    rows.slice(1).map((row, index) => {
      if (row.length !== HEADERS.length) fail(`第 ${index + 2} 行列数无效。`);
      return {
        model: row[0],
        kind: row[1],
        dimensions: row[2] ? Number(row[2]) : undefined,
        priority: row[3] ? Number(row[3]) : undefined,
        reasoningEffort: row[4] || undefined,
        enabled:
          row[5] === ""
            ? undefined
            : row[5] === "1" || row[5].toLowerCase() === "true",
        timeoutSeconds: row[6] ? Number(row[6]) : undefined,
        cooldownSeconds: row[7] ? Number(row[7]) : undefined,
        cooldownOn: row[8]
          ? (row[8].split(",").filter(Boolean) as AiProviderFailureCode[])
          : undefined,
      };
    }),
  );
}

export function modelsForTransfer(
  models: AiProvider[],
): PortableProviderModel[] {
  return models.map((model) => ({
    kind: model.kind,
    model: model.model,
    ...(model.dimensions === undefined ? {} : { dimensions: model.dimensions }),
    priority: model.priority,
    ...(model.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: model.reasoningEffort }),
    enabled: model.enabled,
    ...(model.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: model.timeoutSeconds }),
    ...(model.cooldownSeconds === undefined
      ? {}
      : { cooldownSeconds: model.cooldownSeconds }),
    ...(model.cooldownOn === undefined ? {} : { cooldownOn: model.cooldownOn }),
  }));
}
