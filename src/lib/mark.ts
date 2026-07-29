import { z } from "zod";

export const MAX_MARK_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MARK_EXPORT_BYTES = 100 * 1024 * 1024;

export interface MarkDirectory {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarkFileSummary {
  id: string;
  directoryId: string | null;
  name: string;
  extension: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarkFile extends MarkFileSummary {
  content: string;
}

export interface MarkTrashItem {
  id: string;
  type: "directory" | "file";
  name: string;
  deletedAt: string;
}

export interface MarkWorkspaceSnapshot {
  directories: MarkDirectory[];
  files: MarkFileSummary[];
  trash: MarkTrashItem[];
}

const itemName = z
  .string()
  .trim()
  .min(1, "名称不能为空。")
  .max(100, "目录名称不能超过 100 个字符。")
  .refine(isSafeMarkName, "名称不能包含路径分隔符、控制字符或 '..'。");

const fileName = z
  .string()
  .trim()
  .min(1, "文件名不能为空。")
  .max(180, "文件名不能超过 180 个字符。")
  .refine(isSafeMarkName, "文件名不能包含路径分隔符、控制字符或 '..'。");

const nullableId = z.string().uuid().nullable();

export const markActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createDirectory"),
    name: itemName,
    parentId: nullableId,
  }),
  z.object({
    action: z.literal("renameDirectory"),
    id: z.string().uuid(),
    name: itemName,
  }),
  z.object({
    action: z.literal("updateDirectory"),
    id: z.string().uuid(),
    name: itemName,
    parentId: nullableId,
  }),
  z.object({ action: z.literal("deleteDirectory"), id: z.string().uuid() }),
  z.object({ action: z.literal("restoreDirectory"), id: z.string().uuid() }),
  z.object({ action: z.literal("purgeDirectory"), id: z.string().uuid() }),
  z.object({
    action: z.literal("createFile"),
    name: fileName,
    directoryId: nullableId,
    content: z.string().default(""),
  }),
  z.object({
    action: z.literal("renameFile"),
    id: z.string().uuid(),
    name: fileName,
  }),
  z.object({
    action: z.literal("updateFile"),
    id: z.string().uuid(),
    name: fileName,
    directoryId: nullableId,
    content: z.string(),
  }),
  z.object({ action: z.literal("copyFile"), id: z.string().uuid() }),
  z.object({ action: z.literal("deleteFile"), id: z.string().uuid() }),
  z.object({ action: z.literal("restoreFile"), id: z.string().uuid() }),
  z.object({ action: z.literal("purgeFile"), id: z.string().uuid() }),
]);

export type MarkAction = z.infer<typeof markActionSchema>;

export function isSafeMarkName(value: string) {
  return (
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    !/[\\/\u0000-\u001f\u007f]/.test(value)
  );
}

export function markExtension(name: string) {
  if (name.startsWith(".") && !name.slice(1).includes(".")) {
    return name.slice(1).toLowerCase() || "txt";
  }
  const lastDot = name.lastIndexOf(".");
  return lastDot > 0 && lastDot < name.length - 1
    ? name.slice(lastDot + 1).toLowerCase()
    : "txt";
}

export function markContentSize(content: string) {
  return new TextEncoder().encode(content).byteLength;
}

export function assertMarkContentSize(content: string) {
  const size = markContentSize(content);
  if (size > MAX_MARK_FILE_BYTES) {
    throw new Error("mark_file_too_large");
  }
  return size;
}
