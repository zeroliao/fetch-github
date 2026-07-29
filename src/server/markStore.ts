import crypto from "node:crypto";
import type pg from "pg";
import {
  assertMarkContentSize,
  markExtension,
  MAX_MARK_EXPORT_BYTES,
  type MarkAction,
  type MarkDirectory,
  type MarkFile,
  type MarkFileSummary,
  type MarkWorkspaceSnapshot,
} from "@/lib/mark";
import { createTextZip } from "@/lib/zip";
import { getPool } from "./db";

export class MarkStoreError extends Error {
  constructor(
    public code:
      | "not_found"
      | "conflict"
      | "invalid_parent"
      | "too_large"
      | "empty_export",
    message: string,
  ) {
    super(message);
  }
}

export async function listMarkWorkspace(
  userId: string,
): Promise<MarkWorkspaceSnapshot> {
  const [directories, files, trash] = await Promise.all([
    getPool().query(
      `select id, parent_id, name, created_at, updated_at
       from mark_directories where user_id=$1 and deleted_at is null
       order by lower(name)`,
      [userId],
    ),
    getPool().query(
      `select id, directory_id, name, size_bytes, created_at, updated_at
       from mark_files where user_id=$1 and deleted_at is null
       order by lower(name)`,
      [userId],
    ),
    getPool().query(
      `select id, 'directory' as type, name, deleted_at from mark_directories
       where user_id=$1 and deleted_root=true
       union all
       select id, 'file' as type, name, deleted_at from mark_files
       where user_id=$1 and deleted_root=true
       order by deleted_at desc`,
      [userId],
    ),
  ]);

  return {
    directories: directories.rows.map(mapDirectory),
    files: files.rows.map(mapFileSummary),
    trash: trash.rows.map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      deletedAt: toIso(row.deleted_at),
    })),
  };
}

export async function getMarkFile(
  userId: string,
  id: string,
): Promise<MarkFile | null> {
  const result = await getPool().query(
    `select id, directory_id, name, content, size_bytes, created_at, updated_at
     from mark_files where id=$1 and user_id=$2 and deleted_at is null`,
    [id, userId],
  );
  return result.rows[0] ? mapFile(result.rows[0]) : null;
}

export async function applyMarkAction(userId: string, action: MarkAction) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await runAction(client, userId, action);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    if (isPgUniqueViolation(error)) {
      throw new MarkStoreError("conflict", "同一目录中已存在同名项目。");
    }
    if (error instanceof Error && error.message === "mark_file_too_large") {
      throw new MarkStoreError("too_large", "单个文件内容不能超过 2 MB。");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function exportMarkFile(userId: string, id: string) {
  const file = await getMarkFile(userId, id);
  if (!file) throw new MarkStoreError("not_found", "文件不存在。");
  return { name: file.name, data: Buffer.from(file.content, "utf8") };
}

export async function exportMarkDirectory(
  userId: string,
  directoryId: string | null,
) {
  const [directoriesResult, filesResult] = await Promise.all([
    getPool().query(
      `select id, parent_id, name, created_at, updated_at
       from mark_directories where user_id=$1 and deleted_at is null`,
      [userId],
    ),
    getPool().query(
      `select id, directory_id, name, content, size_bytes, created_at, updated_at
       from mark_files where user_id=$1 and deleted_at is null`,
      [userId],
    ),
  ]);
  const directories = directoriesResult.rows.map(mapDirectory);
  const files = filesResult.rows.map(mapFile);
  const byId = new Map(directories.map((item) => [item.id, item]));
  if (directoryId && !byId.has(directoryId)) {
    throw new MarkStoreError("not_found", "目录不存在。");
  }

  const includedDirectoryIds = new Set<string>();
  for (const directory of directories) {
    if (!directoryId || isDirectoryWithin(directory.id, directoryId, byId)) {
      includedDirectoryIds.add(directory.id);
    }
  }
  const includedFiles = files.filter((file) =>
    directoryId
      ? Boolean(file.directoryId && includedDirectoryIds.has(file.directoryId))
      : true,
  );
  const totalSize = includedFiles.reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );
  if (!includedFiles.length) {
    throw new MarkStoreError("empty_export", "所选目录中没有可导出的文件。");
  }
  if (totalSize > MAX_MARK_EXPORT_BYTES) {
    throw new MarkStoreError("too_large", "目录导出内容不能超过 100 MB。");
  }

  const baseName = directoryId
    ? (byId.get(directoryId)?.name ?? "mark")
    : "mark-all";
  const entries = includedFiles.map((file) => ({
    path: buildExportPath(file, directoryId, byId),
    content: file.content,
    modifiedAt: new Date(file.updatedAt),
  }));
  return { name: `${baseName}.zip`, data: createTextZip(entries) };
}

async function runAction(
  client: pg.PoolClient,
  userId: string,
  action: MarkAction,
) {
  switch (action.action) {
    case "createDirectory": {
      await ensureDirectory(client, userId, action.parentId);
      const id = crypto.randomUUID();
      await client.query(
        `insert into mark_directories (id,user_id,parent_id,name) values ($1,$2,$3,$4)`,
        [id, userId, action.parentId, action.name],
      );
      return { id };
    }
    case "renameDirectory": {
      const result = await client.query(
        `update mark_directories set name=$3,updated_at=now()
         where id=$1 and user_id=$2 and deleted_at is null`,
        [action.id, userId, action.name],
      );
      if (!result.rowCount) throw notFound();
      return { id: action.id };
    }
    case "updateDirectory": {
      await ensureDirectory(client, userId, action.id);
      await ensureDirectory(client, userId, action.parentId);
      if (
        action.parentId &&
        (action.parentId === action.id ||
          (await isDescendant(client, userId, action.id, action.parentId)))
      ) {
        throw new MarkStoreError(
          "invalid_parent",
          "目录不能移动到自身或其子目录中。",
        );
      }
      await client.query(
        `update mark_directories set name=$3,parent_id=$4,updated_at=now()
         where id=$1 and user_id=$2 and deleted_at is null`,
        [action.id, userId, action.name, action.parentId],
      );
      return { id: action.id };
    }
    case "deleteDirectory":
      await markDirectoryDeleted(client, userId, action.id);
      return { id: action.id };
    case "restoreDirectory":
      await restoreDirectory(client, userId, action.id);
      return { id: action.id };
    case "purgeDirectory": {
      const result = await client.query(
        `delete from mark_directories where id=$1 and user_id=$2 and deleted_root=true`,
        [action.id, userId],
      );
      if (!result.rowCount) throw notFound();
      return { id: action.id };
    }
    case "createFile": {
      await ensureDirectory(client, userId, action.directoryId);
      const size = assertMarkContentSize(action.content);
      const id = crypto.randomUUID();
      await client.query(
        `insert into mark_files (id,user_id,directory_id,name,content,size_bytes)
         values ($1,$2,$3,$4,$5,$6)`,
        [id, userId, action.directoryId, action.name, action.content, size],
      );
      return { id };
    }
    case "renameFile": {
      const result = await client.query(
        `update mark_files set name=$3,updated_at=now()
         where id=$1 and user_id=$2 and deleted_at is null`,
        [action.id, userId, action.name],
      );
      if (!result.rowCount) throw notFound();
      return { id: action.id };
    }
    case "updateFile": {
      await ensureDirectory(client, userId, action.directoryId);
      const size = assertMarkContentSize(action.content);
      const result = await client.query(
        `update mark_files set name=$3,directory_id=$4,content=$5,size_bytes=$6,updated_at=now()
         where id=$1 and user_id=$2 and deleted_at is null`,
        [
          action.id,
          userId,
          action.name,
          action.directoryId,
          action.content,
          size,
        ],
      );
      if (!result.rowCount) throw notFound();
      return { id: action.id };
    }
    case "copyFile":
      return copyFile(client, userId, action.id);
    case "deleteFile": {
      const result = await client.query(
        `update mark_files set deleted_at=now(),deleted_root=true,updated_at=now()
         where id=$1 and user_id=$2 and deleted_at is null`,
        [action.id, userId],
      );
      if (!result.rowCount) throw notFound();
      return { id: action.id };
    }
    case "restoreFile": {
      const result = await client.query(
        `update mark_files f set deleted_at=null,deleted_root=false,updated_at=now()
         where f.id=$1 and f.user_id=$2 and f.deleted_root=true
         and (f.directory_id is null or exists (
           select 1 from mark_directories d where d.id=f.directory_id and d.user_id=$2 and d.deleted_at is null
         ))`,
        [action.id, userId],
      );
      if (!result.rowCount)
        throw new MarkStoreError("conflict", "原目录不可用，无法恢复文件。");
      return { id: action.id };
    }
    case "purgeFile": {
      const result = await client.query(
        `delete from mark_files where id=$1 and user_id=$2 and deleted_root=true`,
        [action.id, userId],
      );
      if (!result.rowCount) throw notFound();
      return { id: action.id };
    }
  }
}

async function ensureDirectory(
  client: pg.PoolClient,
  userId: string,
  id: string | null,
) {
  if (!id) return;
  const result = await client.query(
    `select 1 from mark_directories where id=$1 and user_id=$2 and deleted_at is null`,
    [id, userId],
  );
  if (!result.rowCount)
    throw new MarkStoreError("invalid_parent", "所选目录不存在。");
}

async function isDescendant(
  client: pg.PoolClient,
  userId: string,
  rootId: string,
  candidateId: string,
) {
  const result = await client.query(
    `with recursive tree as (
       select id from mark_directories where parent_id=$1 and user_id=$2 and deleted_at is null
       union all
       select d.id from mark_directories d join tree t on d.parent_id=t.id
       where d.user_id=$2 and d.deleted_at is null
     ) select 1 from tree where id=$3`,
    [rootId, userId, candidateId],
  );
  return Boolean(result.rowCount);
}

async function markDirectoryDeleted(
  client: pg.PoolClient,
  userId: string,
  id: string,
) {
  const existing = await client.query(
    `select 1 from mark_directories where id=$1 and user_id=$2 and deleted_at is null`,
    [id, userId],
  );
  if (!existing.rowCount) throw notFound();
  await client.query(
    `with recursive tree as (
       select id from mark_directories where id=$1 and user_id=$2 and deleted_at is null
       union all
       select d.id from mark_directories d join tree t on d.parent_id=t.id
       where d.user_id=$2 and d.deleted_at is null
     ), deleted_files as (
       update mark_files set deleted_at=now(),deleted_root=false,updated_at=now()
       where user_id=$2 and directory_id in (select id from tree) and deleted_at is null
     )
     update mark_directories set deleted_at=now(),deleted_root=(id=$1),updated_at=now()
     where id in (select id from tree)`,
    [id, userId],
  );
}

async function restoreDirectory(
  client: pg.PoolClient,
  userId: string,
  id: string,
) {
  const root = await client.query(
    `select 1 from mark_directories where id=$1 and user_id=$2 and deleted_root=true`,
    [id, userId],
  );
  if (!root.rowCount) throw notFound();
  await client.query(
    `with recursive tree as (
       select id from mark_directories where id=$1 and user_id=$2 and deleted_root=true
       union all
       select d.id from mark_directories d join tree t on d.parent_id=t.id where d.user_id=$2
     ), restored_files as (
       update mark_files set deleted_at=null,deleted_root=false,updated_at=now()
       where user_id=$2 and directory_id in (select id from tree)
     )
     update mark_directories set deleted_at=null,deleted_root=false,updated_at=now()
     where id in (select id from tree)`,
    [id, userId],
  );
}

async function copyFile(client: pg.PoolClient, userId: string, id: string) {
  const result = await client.query(
    `select directory_id,name,content,size_bytes from mark_files
     where id=$1 and user_id=$2 and deleted_at is null`,
    [id, userId],
  );
  const source = result.rows[0];
  if (!source) throw notFound();
  const name = await nextCopyName(
    client,
    userId,
    source.directory_id,
    source.name,
  );
  const copyId = crypto.randomUUID();
  await client.query(
    `insert into mark_files (id,user_id,directory_id,name,content,size_bytes)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      copyId,
      userId,
      source.directory_id,
      name,
      source.content,
      source.size_bytes,
    ],
  );
  return { id: copyId };
}

async function nextCopyName(
  client: pg.PoolClient,
  userId: string,
  directoryId: string | null,
  name: string,
) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 1; index <= 100; index += 1) {
    const candidate = `${base} - 副本${index === 1 ? "" : ` ${index}`}${extension}`;
    const exists = await client.query(
      `select 1 from mark_files where user_id=$1 and directory_id is not distinct from $2
       and lower(name)=lower($3) and deleted_at is null`,
      [userId, directoryId, candidate],
    );
    if (!exists.rowCount) return candidate;
  }
  throw new MarkStoreError("conflict", "无法生成不重复的副本名称。");
}

function mapDirectory(row: Record<string, unknown>): MarkDirectory {
  return {
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    name: String(row.name),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapFileSummary(row: Record<string, unknown>): MarkFileSummary {
  const name = String(row.name);
  return {
    id: String(row.id),
    directoryId: row.directory_id ? String(row.directory_id) : null,
    name,
    extension: markExtension(name),
    sizeBytes: Number(row.size_bytes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapFile(row: Record<string, unknown>): MarkFile {
  return { ...mapFileSummary(row), content: String(row.content) };
}

function isDirectoryWithin(
  id: string,
  rootId: string,
  byId: Map<string, MarkDirectory>,
) {
  let current: MarkDirectory | undefined = byId.get(id);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === rootId) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function buildExportPath(
  file: MarkFile,
  rootId: string | null,
  byId: Map<string, MarkDirectory>,
) {
  const parts: string[] = [];
  let current = file.directoryId ? byId.get(file.directoryId) : undefined;
  const visited = new Set<string>();
  while (current && current.id !== rootId && !visited.has(current.id)) {
    parts.unshift(current.name);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return [...parts, file.name].join("/");
}

function isPgUniqueViolation(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505",
  );
}

function notFound() {
  return new MarkStoreError("not_found", "项目不存在或已被删除。");
}

function toIso(value: unknown) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}
