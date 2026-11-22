import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  CornerLeftUp,
  Download,
  Eye,
  FilePlus,
  Folder,
  FolderPlus,
  Lock,
  Pencil,
  RefreshCw,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import type { RemoteEntry, SftpDockPosition, ThemeTokens } from "../types";

export type ContextMenuState =
  | { kind: "sftp_item"; entry: RemoteEntry; x: number; y: number }
  | { kind: "sftp_bg"; x: number; y: number }
  | { kind: "terminal"; x: number; y: number };

interface ContextMenuProps {
  menu: ContextMenuState | null;
  sftpPosition: SftpDockPosition;
  theme: ThemeTokens;
  onClose: () => void;
  // SFTP item & bg
  onOpenEntry: (e: RemoteEntry) => void;
  onPreviewEntry: (e: RemoteEntry) => void;
  onDownloadEntry: (e: RemoteEntry) => void;
  onUploadHere: () => void;
  onRenameEntry: (e: RemoteEntry) => void;
  onDeleteEntry: (e: RemoteEntry) => void;
  onCopyPath: (e: RemoteEntry) => void;
  onCopyPathToTerm: (e: RemoteEntry) => void;
  onCdInTerminal: (e: RemoteEntry) => void;
  onChmodEntry: (e: RemoteEntry) => void;
  onGoUp: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onRefresh: () => void;
  onSetPosition: (pos: SftpDockPosition) => void;
  // Terminal
  onTermCopy: () => void;
  onTermCopyAll: () => void;
  onTermPaste: () => void;
  onTermFind: () => void;
  onTermFontDelta: (d: number) => void;
  onTermFontReset: () => void;
  onTermClear: () => void;
  onTermReset: () => void;
  onTermSaveFile: () => void;
  onTermCtrlC: () => void;
  onTermSettings: () => void;
}

export function ContextMenu(props: ContextMenuProps) {
  const { menu, theme, onClose } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, onClose]);

  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    const w = el?.offsetWidth ?? 240;
    const h = el?.offsetHeight ?? 360;
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)),
    });
  }, [menu]);

  if (!menu) return null;

  const itemCls =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-white/8";
  const divEl = <div className="my-1 h-px w-full" style={{ backgroundColor: theme.border }} />;

  return (
    <div
      className="fixed inset-0 z-40"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        className="menu-enter fixed overflow-y-auto rounded-xl border p-1.5 shadow-2xl"
        style={{
          left: pos.left,
          top: pos.top,
          width: 244,
          maxHeight: "calc(100vh - 16px)",
          backgroundColor: theme.bgElevated,
          borderColor: theme.border,
          color: theme.textPrimary,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {menu.kind === "sftp_item" && (
          <>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onOpenEntry(menu.entry);
              }}
            >
              <Folder className="h-3.5 w-3.5" style={{ color: theme.warning }} />
              <span>{menu.entry.kind === "directory" ? "Open folder" : "Open / Edit locally"}</span>
            </button>
            {menu.entry.kind !== "directory" && (
              <button
                className={itemCls}
                onClick={() => {
                  onClose();
                  props.onPreviewEntry(menu.entry);
                }}
              >
                <Eye className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
                <span>Quick preview</span>
              </button>
            )}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onDownloadEntry(menu.entry);
              }}
            >
              <Download className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>Download</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onUploadHere();
              }}
            >
              <Upload className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>Upload here...</span>
            </button>
            {divEl}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onRenameEntry(menu.entry);
              }}
            >
              <Pencil className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>Rename</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onDeleteEntry(menu.entry);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" style={{ color: theme.danger }} />
              <span>Delete</span>
            </button>
            {divEl}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onCopyPath(menu.entry);
              }}
            >
              <Copy className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>Copy file path</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onCopyPathToTerm(menu.entry);
              }}
            >
              <Terminal className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>Copy path to terminal</span>
            </button>
            {menu.entry.kind === "directory" && (
              <button
                className={itemCls}
                onClick={() => {
                  onClose();
                  props.onCdInTerminal(menu.entry);
                }}
              >
                <Terminal className="h-3.5 w-3.5" style={{ color: theme.success }} />
                <span>Open in terminal (cd)</span>
              </button>
            )}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onChmodEntry(menu.entry);
              }}
            >
              <Lock className="h-3.5 w-3.5" style={{ color: theme.warning }} />
              <span>Permissions (chmod)</span>
            </button>
            {divEl}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onNewFolder();
              }}
            >
              <FolderPlus className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>New directory</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onNewFile();
              }}
            >
              <FilePlus className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>New empty file</span>
            </button>
          </>
        )}

        {menu.kind === "sftp_bg" && (
          <>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onGoUp();
              }}
            >
              <CornerLeftUp className="h-3.5 w-3.5" style={{ color: theme.warning }} />
              <span>Parent directory</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onNewFolder();
              }}
            >
              <FolderPlus className="h-3.5 w-3.5" style={{ color: theme.warning }} />
              <span>New directory</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onNewFile();
              }}
            >
              <FilePlus className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>New empty file</span>
            </button>
            {divEl}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onRefresh();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>Refresh current folder</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onUploadHere();
              }}
            >
              <Upload className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
              <span>Upload to current folder</span>
            </button>
            {divEl}
            {(["left", "right", "bottom", "top"] as SftpDockPosition[]).map((pos) => {
              const active = props.sftpPosition === pos;
              return (
                <button
                  key={pos}
                  className={itemCls}
                  onClick={() => {
                    onClose();
                    props.onSetPosition(pos);
                  }}
                >
                  <span className="flex h-3.5 w-3.5 items-center justify-center">
                    {active && <Check className="h-3.5 w-3.5" style={{ color: theme.textPrimary }} />}
                  </span>
                  <span style={{ color: active ? theme.textPrimary : theme.textMuted }}>
                    SSH-browser position: {pos}
                  </span>
                </button>
              );
            })}
          </>
        )}

        {menu.kind === "terminal" && (
          <>
            {[
              ["Copy", "Ctrl+Shift+C", props.onTermCopy],
              ["Copy All", "", props.onTermCopyAll],
              ["Paste", "Shift+Insert", props.onTermPaste],
              ["Find", "Ctrl+Shift+F", props.onTermFind],
            ].map(([label, key, fn]) => (
              <button
                key={label as string}
                className={`${itemCls} justify-between`}
                onClick={() => {
                  onClose();
                  (fn as () => void)();
                }}
              >
                <span>{label as string}</span>
                {key && (
                  <span className="text-[11px]" style={{ color: theme.textMuted }}>
                    {key as string}
                  </span>
                )}
              </button>
            ))}
            {divEl}
            {[
              ["Increase font size", () => props.onTermFontDelta(1)],
              ["Decrease font size", () => props.onTermFontDelta(-1)],
              ["Reset font size", props.onTermFontReset],
            ].map(([label, fn]) => (
              <button
                key={label as string}
                className={itemCls}
                onClick={() => {
                  onClose();
                  (fn as () => void)();
                }}
              >
                <span>{label as string}</span>
              </button>
            ))}
            {divEl}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onTermClear();
              }}
            >
              <span>Clear scrollback</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onTermReset();
              }}
            >
              <span>Reset terminal</span>
            </button>
            <button
              className={`${itemCls} justify-between`}
              onClick={() => {
                onClose();
                props.onTermSaveFile();
              }}
            >
              <span>Save output to file...</span>
              <span className="text-[11px]" style={{ color: theme.textMuted }}>
                Ctrl+Shift+S
              </span>
            </button>
            {divEl}
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onTermCtrlC();
              }}
            >
              <span>Send Ctrl+C (SIGINT)</span>
            </button>
            <button
              className={itemCls}
              onClick={() => {
                onClose();
                props.onTermSettings();
              }}
            >
              <span>Terminal settings...</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
