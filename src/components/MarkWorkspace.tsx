"use client";

import {
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  markExtension,
  type MarkAction,
  type MarkDirectory,
  type MarkFile,
  type MarkFileSummary,
  type MarkWorkspaceSnapshot,
} from "@/lib/mark";
import styles from "./MarkWorkspace.module.css";

const formats = [
  "txt",
  "md",
  "json",
  "yaml",
  "xml",
  "toml",
  "ini",
  "csv",
  "sql",
  "html",
  "css",
  "js",
  "ts",
  "jsx",
  "tsx",
  "py",
  "java",
  "go",
  "rs",
  "sh",
  "ps1",
  "log",
  "env",
];

type DialogState =
  | {
      type: "directory";
      mode: "create" | "rename";
      id?: string;
      name: string;
      parentId: string | null;
    }
  | {
      type: "file";
      mode: "create" | "rename";
      id?: string;
      name: string;
      extension: string;
      directoryId: string | null;
    }
  | null;

type ContextTarget =
  | { type: "root" }
  | { type: "directory"; item: MarkDirectory }
  | { type: "file"; item: MarkFileSummary };

type ContextMenuState = ContextTarget & { x: number; y: number };

export function MarkWorkspace({
  initialData,
}: {
  initialData: MarkWorkspaceSnapshot;
}) {
  const [data, setData] = useState(initialData);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [file, setFile] = useState<MarkFile | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mobilePane, setMobilePane] = useState<"resources" | "editor">(
    "resources",
  );
  const dirty = file ? draftContent !== file.content : false;

  const directoriesByParent = useMemo(
    () => groupDirectories(data.directories),
    [data.directories],
  );
  const filesByDirectory = useMemo(() => groupFiles(data.files), [data.files]);
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return null;
    return {
      directories: data.directories.filter((item) =>
        item.name.toLowerCase().includes(normalizedQuery),
      ),
      files: data.files.filter((item) =>
        item.name.toLowerCase().includes(normalizedQuery),
      ),
    };
  }, [data.directories, data.files, normalizedQuery]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/mark", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const next = (await response.json()) as MarkWorkspaceSnapshot;
    setData(next);
    return next;
  }, []);

  const loadFile = useCallback(async (id: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/mark/files/${id}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await responseError(response));
      const next = (await response.json()) as MarkFile;
      setSelectedFileId(id);
      setFile(next);
      setDraftContent(next.content);
      setMobilePane("editor");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnKey = (event: KeyboardEvent) =>
      event.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [contextMenu]);

  const saveFile = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      await mutate({
        action: "updateFile",
        id: file.id,
        name: file.name,
        directoryId: file.directoryId,
        content: draftContent,
      });
      await refresh();
      setFile({ ...file, content: draftContent });
      setMessage("已保存");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [draftContent, file, refresh]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [saveFile]);

  function canDiscard() {
    return !dirty || window.confirm("当前文件有未保存的修改，确定放弃吗？");
  }

  async function submitDialog() {
    if (!dialog) return;
    setBusy(true);
    setMessage("");
    try {
      if (dialog.type === "directory") {
        const result = await mutate(
          dialog.mode === "create"
            ? {
                action: "createDirectory",
                name: dialog.name,
                parentId: dialog.parentId,
              }
            : { action: "renameDirectory", id: dialog.id!, name: dialog.name },
        );
        await refresh();
        if (dialog.mode === "create" && dialog.parentId) {
          setExpandedIds((current) => new Set(current).add(dialog.parentId!));
        }
        if (dialog.mode === "rename") setMessage("目录已重命名");
        if (dialog.mode === "create")
          setExpandedIds((current) => new Set(current).add(result.id));
      } else {
        const name = withExtension(dialog.name, dialog.extension);
        if (dialog.mode === "create") {
          const result = await mutate({
            action: "createFile",
            name,
            directoryId: dialog.directoryId,
            content: "",
          });
          await refresh();
          if (dialog.directoryId)
            setExpandedIds((current) =>
              new Set(current).add(dialog.directoryId!),
            );
          await loadFile(result.id);
        } else {
          await mutate({ action: "renameFile", id: dialog.id!, name });
          await refresh();
          setFile((current) =>
            current && current.id === dialog.id
              ? { ...current, name }
              : current,
          );
          setMessage("文件已重命名");
        }
      }
      setDialog(null);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteDirectory(directory: MarkDirectory) {
    const fileCount = countFilesWithin(directory.id, data);
    const detail = fileCount ? `，其中包含 ${fileCount} 个文件` : "";
    if (
      !window.confirm(
        `确定将目录“${directory.name}”及其子目录移入回收站${detail}？`,
      )
    )
      return;
    await runMutation({ action: "deleteDirectory", id: directory.id });
    if (
      file?.directoryId &&
      isInside(file.directoryId, directory.id, data.directories)
    )
      clearSelectedFile();
  }

  async function deleteFile(item: MarkFileSummary) {
    if (!window.confirm(`确定将文件“${item.name}”移入回收站吗？`)) return;
    await runMutation({ action: "deleteFile", id: item.id });
    if (selectedFileId === item.id) clearSelectedFile();
  }

  function clearSelectedFile() {
    setSelectedFileId(null);
    setFile(null);
    setDraftContent("");
    setMobilePane("resources");
  }

  async function copyContent() {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(draftContent);
      setMessage("内容已复制");
    } catch {
      setMessage("复制失败，请检查浏览器剪贴板权限。");
    }
  }

  async function runMutation(action: MarkAction) {
    setBusy(true);
    setMessage("");
    try {
      await mutate(action);
      await refresh();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function download(
    type: "file" | "directory",
    id: string | null,
    fallbackName: string,
  ) {
    setBusy(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ type });
      if (id) params.set("id", id);
      const response = await fetch(`/api/mark/export?${params.toString()}`);
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = fallbackName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function openContextMenu(event: React.MouseEvent, target: ContextTarget) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      ...target,
      x: Math.min(event.clientX, window.innerWidth - 196),
      y: Math.min(event.clientY, window.innerHeight - 250),
    });
  }

  function selectFile(item: MarkFileSummary) {
    if (selectedFileId === item.id || !canDiscard()) return;
    void loadFile(item.id);
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <div className={styles.logo}>
            <FileText size={20} />
          </div>
          <div>
            <h1>临时文本</h1>
            <p>
              {data.files.length} 个文件 · {data.directories.length} 个目录
            </p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {message && (
            <span className={styles.message} role="status">
              {message}
            </span>
          )}
          <button
            className={styles.iconButton}
            title="回收站"
            aria-label="回收站"
            onClick={() => setShowTrash(true)}
          >
            <Trash2 size={17} />
            <span className={styles.counter}>{data.trash.length}</span>
          </button>
        </div>
      </header>

      <nav className={styles.mobileTabs} aria-label="工作区视图">
        <button
          className={mobilePane === "resources" ? styles.activeTab : ""}
          onClick={() => setMobilePane("resources")}
        >
          文件
        </button>
        <button
          className={mobilePane === "editor" ? styles.activeTab : ""}
          onClick={() => setMobilePane("editor")}
        >
          编辑
        </button>
      </nav>

      <div className={styles.workspace} data-mobile-pane={mobilePane}>
        <section className={`${styles.pane} ${styles.resourcePane}`}>
          <div className={styles.paneHeader}>
            <h2>文件</h2>
          </div>
          <label className={styles.search}>
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索目录和文件"
              aria-label="搜索目录和文件"
            />
            {query && (
              <button aria-label="清空搜索" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </label>
          <div
            className={styles.resourceTree}
            onContextMenu={(event) => openContextMenu(event, { type: "root" })}
          >
            {searchResults ? (
              <SearchResultList
                directories={searchResults.directories}
                files={searchResults.files}
                selectedFileId={selectedFileId}
                onSelectFile={selectFile}
                onContextMenu={openContextMenu}
              />
            ) : (
              <>
                <div
                  className={styles.resourceRow}
                  onContextMenu={(event) =>
                    openContextMenu(event, { type: "root" })
                  }
                >
                  <span className={styles.rowIndent} />
                  <FolderOpen size={16} />
                  <span className={styles.resourceName}>临时文件</span>
                  <small>{data.files.length + data.directories.length}</small>
                </div>
                <ResourceTree
                  parentId={null}
                  depth={1}
                  directoriesByParent={directoriesByParent}
                  filesByDirectory={filesByDirectory}
                  selectedFileId={selectedFileId}
                  expandedIds={expandedIds}
                  onToggle={(id) =>
                    setExpandedIds((current) => toggleSet(current, id))
                  }
                  onSelectFile={selectFile}
                  onContextMenu={openContextMenu}
                />
              </>
            )}
          </div>
        </section>

        <section className={`${styles.pane} ${styles.editorPane}`}>
          {file ? (
            <>
              <div className={styles.editorToolbar}>
                <strong title={file.name}>{file.name}</strong>
                <div className={styles.editorActions}>
                  <button
                    className={styles.textButton}
                    onClick={() => void copyContent()}
                    disabled={busy}
                  >
                    <Clipboard size={16} />
                    复制
                  </button>
                  <button
                    className={styles.saveButton}
                    onClick={() => void saveFile()}
                    disabled={!dirty || busy}
                  >
                    <Save size={16} />
                    {busy ? "处理中" : dirty ? "保存" : "已保存"}
                  </button>
                </div>
              </div>
              <textarea
                className={styles.editor}
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
                spellCheck={false}
                aria-label="文件内容"
              />
              <footer className={styles.editorStatus}>
                <span>UTF-8</span>
                <span>
                  {formatBytes(
                    new TextEncoder().encode(draftContent).byteLength,
                  )}
                </span>
                <span>{draftContent.split("\n").length} 行</span>
              </footer>
            </>
          ) : (
            <div className={styles.editorEmpty}>
              <FileText size={34} />
              <strong>选择或新建文件</strong>
            </div>
          )}
        </section>
      </div>

      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          busy={busy}
          onClose={() => setContextMenu(null)}
          onCreateDirectory={(parentId) =>
            setDialog({ type: "directory", mode: "create", name: "", parentId })
          }
          onCreateFile={(directoryId) =>
            setDialog({
              type: "file",
              mode: "create",
              name: "未命名",
              extension: "txt",
              directoryId,
            })
          }
          onRenameDirectory={(item) =>
            setDialog({
              type: "directory",
              mode: "rename",
              id: item.id,
              name: item.name,
              parentId: item.parentId,
            })
          }
          onRenameFile={(item) =>
            setDialog({
              type: "file",
              mode: "rename",
              id: item.id,
              name: item.name,
              extension: markExtension(item.name),
              directoryId: item.directoryId,
            })
          }
          onExport={(type, id, name) => void download(type, id, name)}
          onDeleteDirectory={(item) => void deleteDirectory(item)}
          onDeleteFile={(item) => void deleteFile(item)}
        />
      )}
      {dialog && (
        <EditDialog
          dialog={dialog}
          busy={busy}
          onChange={setDialog}
          onClose={() => setDialog(null)}
          onSubmit={() => void submitDialog()}
        />
      )}
      {showTrash && (
        <TrashDialog
          data={data}
          busy={busy}
          onClose={() => setShowTrash(false)}
          onAction={(action) => void runMutation(action)}
        />
      )}
    </main>
  );
}

function ResourceTree(props: {
  parentId: string | null;
  depth: number;
  directoriesByParent: Map<string | null, MarkDirectory[]>;
  filesByDirectory: Map<string | null, MarkFileSummary[]>;
  selectedFileId: string | null;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelectFile: (item: MarkFileSummary) => void;
  onContextMenu: (event: React.MouseEvent, target: ContextTarget) => void;
}) {
  const directories = props.directoriesByParent.get(props.parentId) ?? [];
  const files = props.filesByDirectory.get(props.parentId) ?? [];
  return (
    <>
      {directories.map((directory) => {
        const childCount =
          (props.directoriesByParent.get(directory.id)?.length ?? 0) +
          (props.filesByDirectory.get(directory.id)?.length ?? 0);
        const expanded = props.expandedIds.has(directory.id);
        return (
          <div key={directory.id}>
            <div
              className={styles.resourceRow}
              style={{ paddingLeft: 8 + props.depth * 16 }}
              onContextMenu={(event) =>
                props.onContextMenu(event, {
                  type: "directory",
                  item: directory,
                })
              }
            >
              <button
                className={styles.chevron}
                onClick={() => props.onToggle(directory.id)}
                aria-label={expanded ? "折叠目录" : "展开目录"}
                disabled={!childCount}
              >
                {childCount ? (
                  expanded ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )
                ) : (
                  <span />
                )}
              </button>
              <button
                className={styles.resourceSelect}
                onDoubleClick={() => childCount && props.onToggle(directory.id)}
              >
                {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                <span>{directory.name}</span>
                <small>{childCount}</small>
              </button>
            </div>
            {expanded && (
              <ResourceTree
                {...props}
                parentId={directory.id}
                depth={props.depth + 1}
              />
            )}
          </div>
        );
      })}
      {files.map((item) => (
        <button
          key={item.id}
          className={`${styles.resourceRow} ${styles.fileResourceRow} ${props.selectedFileId === item.id ? styles.selected : ""}`}
          style={{ paddingLeft: 28 + props.depth * 16 }}
          onClick={() => props.onSelectFile(item)}
          onContextMenu={(event) =>
            props.onContextMenu(event, { type: "file", item })
          }
        >
          <span className={styles.fileType}>{item.extension.slice(0, 4)}</span>
          <span className={styles.resourceName}>{item.name}</span>
          <small>{formatBytes(item.sizeBytes)}</small>
        </button>
      ))}
    </>
  );
}

function SearchResultList({
  directories,
  files,
  selectedFileId,
  onSelectFile,
  onContextMenu,
}: {
  directories: MarkDirectory[];
  files: MarkFileSummary[];
  selectedFileId: string | null;
  onSelectFile: (item: MarkFileSummary) => void;
  onContextMenu: (event: React.MouseEvent, target: ContextTarget) => void;
}) {
  if (!directories.length && !files.length)
    return (
      <div className={styles.empty}>
        <Search size={24} />
        <span>没有匹配的目录或文件</span>
      </div>
    );
  return (
    <>
      {directories.map((item) => (
        <div
          key={item.id}
          className={styles.resourceRow}
          onContextMenu={(event) =>
            onContextMenu(event, { type: "directory", item })
          }
        >
          <span className={styles.rowIndent} />
          <Folder size={16} />
          <span className={styles.resourceName}>{item.name}</span>
        </div>
      ))}
      {files.map((item) => (
        <button
          key={item.id}
          className={`${styles.resourceRow} ${styles.fileResourceRow} ${selectedFileId === item.id ? styles.selected : ""}`}
          onClick={() => onSelectFile(item)}
          onContextMenu={(event) =>
            onContextMenu(event, { type: "file", item })
          }
        >
          <span className={styles.rowIndent} />
          <span className={styles.fileType}>{item.extension.slice(0, 4)}</span>
          <span className={styles.resourceName}>{item.name}</span>
          <small>{formatBytes(item.sizeBytes)}</small>
        </button>
      ))}
    </>
  );
}

function ContextMenu(props: {
  state: ContextMenuState;
  busy: boolean;
  onClose: () => void;
  onCreateDirectory: (parentId: string | null) => void;
  onCreateFile: (directoryId: string | null) => void;
  onRenameDirectory: (item: MarkDirectory) => void;
  onRenameFile: (item: MarkFileSummary) => void;
  onExport: (
    type: "file" | "directory",
    id: string | null,
    name: string,
  ) => void;
  onDeleteDirectory: (item: MarkDirectory) => void;
  onDeleteFile: (item: MarkFileSummary) => void;
}) {
  const target = props.state;
  const parentId = target.type === "directory" ? target.item.id : null;
  const run = (action: () => void) => {
    props.onClose();
    action();
  };
  return (
    <div
      className={styles.contextMenu}
      role="menu"
      style={{ left: target.x, top: target.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {target.type !== "file" && (
        <>
          <button
            role="menuitem"
            disabled={props.busy}
            onClick={() => run(() => props.onCreateDirectory(parentId))}
          >
            <FolderPlus size={15} />
            新建目录
          </button>
          <button
            role="menuitem"
            disabled={props.busy}
            onClick={() => run(() => props.onCreateFile(parentId))}
          >
            <FilePlus2 size={15} />
            新建文件
          </button>
          <div className={styles.menuDivider} />
        </>
      )}
      {target.type === "directory" && (
        <button
          role="menuitem"
          disabled={props.busy}
          onClick={() => run(() => props.onRenameDirectory(target.item))}
        >
          <Pencil size={15} />
          重命名
        </button>
      )}
      {target.type === "file" && (
        <button
          role="menuitem"
          disabled={props.busy}
          onClick={() => run(() => props.onRenameFile(target.item))}
        >
          <Pencil size={15} />
          重命名
        </button>
      )}
      <button
        role="menuitem"
        disabled={props.busy}
        onClick={() =>
          run(() =>
            target.type === "file"
              ? props.onExport("file", target.item.id, target.item.name)
              : props.onExport(
                  "directory",
                  target.type === "directory" ? target.item.id : null,
                  `${target.type === "directory" ? target.item.name : "mark-all"}.zip`,
                ),
          )
        }
      >
        <Download size={15} />
        导出
      </button>
      {target.type !== "root" && <div className={styles.menuDivider} />}
      {target.type === "directory" && (
        <button
          role="menuitem"
          className={styles.dangerMenuItem}
          disabled={props.busy}
          onClick={() => run(() => props.onDeleteDirectory(target.item))}
        >
          <Trash2 size={15} />
          删除
        </button>
      )}
      {target.type === "file" && (
        <button
          role="menuitem"
          className={styles.dangerMenuItem}
          disabled={props.busy}
          onClick={() => run(() => props.onDeleteFile(target.item))}
        >
          <Trash2 size={15} />
          删除
        </button>
      )}
    </div>
  );
}

function EditDialog({
  dialog,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  dialog: Exclude<DialogState, null>;
  busy: boolean;
  onChange: (dialog: Exclude<DialogState, null>) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const isDirectory = dialog.type === "directory";
  const title =
    dialog.mode === "rename"
      ? `重命名${isDirectory ? "目录" : "文件"}`
      : `新建${isDirectory ? "目录" : "文件"}`;
  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className={styles.dialog}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className={styles.dialogHeader}>
          <h2>{title}</h2>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>
        <div className={styles.dialogBody}>
          <label>
            <span>{isDirectory ? "目录名称" : "文件名"}</span>
            <input
              autoFocus
              value={dialog.name}
              onChange={(event) =>
                onChange({ ...dialog, name: event.target.value })
              }
            />
          </label>
          {!isDirectory && (
            <label>
              <span>文本格式</span>
              <select
                value={dialog.extension}
                onChange={(event) =>
                  onChange({ ...dialog, extension: event.target.value })
                }
              >
                {formats.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className={styles.dialogFooter}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={busy || !dialog.name.trim()}
          >
            {busy ? "处理中" : "确认"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TrashDialog({
  data,
  busy,
  onClose,
  onAction,
}: {
  data: MarkWorkspaceSnapshot;
  busy: boolean;
  onClose: () => void;
  onAction: (action: MarkAction) => void;
}) {
  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className={`${styles.dialog} ${styles.trashDialog}`}>
        <div className={styles.dialogHeader}>
          <h2>回收站</h2>
          <button
            className={styles.iconButton}
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>
        <div className={styles.trashList}>
          {data.trash.map((item) => (
            <div className={styles.trashRow} key={`${item.type}-${item.id}`}>
              {item.type === "directory" ? (
                <Folder size={17} />
              ) : (
                <FileText size={17} />
              )}
              <span>
                <strong>{item.name}</strong>
                <small>{formatDate(item.deletedAt)}</small>
              </span>
              <button
                className={styles.iconButton}
                title="恢复"
                aria-label={`恢复 ${item.name}`}
                disabled={busy}
                onClick={() =>
                  onAction({
                    action:
                      item.type === "directory"
                        ? "restoreDirectory"
                        : "restoreFile",
                    id: item.id,
                  })
                }
              >
                <ArchiveRestore size={16} />
              </button>
              <button
                className={styles.iconButton}
                title="永久删除"
                aria-label={`永久删除 ${item.name}`}
                disabled={busy}
                onClick={() =>
                  window.confirm(`永久删除“${item.name}”？此操作无法撤销。`) &&
                  onAction({
                    action:
                      item.type === "directory"
                        ? "purgeDirectory"
                        : "purgeFile",
                    id: item.id,
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {!data.trash.length && (
            <div className={styles.empty}>
              <Trash2 size={26} />
              <span>回收站为空</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

async function mutate(action: MarkAction): Promise<{ id: string }> {
  const response = await fetch("/api/mark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : "操作失败，请稍后重试。";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
function toggleSet(current: Set<string>, id: string) {
  const next = new Set(current);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
}
function formatBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function withExtension(name: string, extension: string) {
  const trimmed = name.trim();
  if (
    trimmed.startsWith(".") &&
    !trimmed.slice(1).includes(".") &&
    trimmed.slice(1) === extension
  )
    return trimmed;
  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base || "未命名"}.${extension}`;
}

function groupDirectories(directories: MarkDirectory[]) {
  const map = new Map<string | null, MarkDirectory[]>();
  for (const directory of directories)
    map.set(directory.parentId, [
      ...(map.get(directory.parentId) ?? []),
      directory,
    ]);
  return map;
}

function groupFiles(files: MarkFileSummary[]) {
  const map = new Map<string | null, MarkFileSummary[]>();
  for (const file of files)
    map.set(file.directoryId, [...(map.get(file.directoryId) ?? []), file]);
  return map;
}

function isInside(
  id: string | null,
  rootId: string,
  directories: MarkDirectory[],
) {
  const byId = new Map(directories.map((item) => [item.id, item]));
  let current = id ? byId.get(id) : undefined;
  while (current) {
    if (current.id === rootId) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function countFilesWithin(rootId: string, data: MarkWorkspaceSnapshot) {
  const directoryIds = new Set(
    data.directories
      .filter((item) => isInside(item.id, rootId, data.directories))
      .map((item) => item.id),
  );
  return data.files.filter(
    (item) => item.directoryId && directoryIds.has(item.directoryId),
  ).length;
}
