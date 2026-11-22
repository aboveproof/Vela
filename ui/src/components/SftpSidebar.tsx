import { useEffect, useState } from "react";
import {
  CornerLeftUp,
  Download,
  Eye,
  EyeOff,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  Link2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { formatBytes, type AppSettings, type RemoteEntry, type SessionTab, type ThemeTokens } from "../types";

interface SftpSidebarProps {
  session: SessionTab | null;
  settings: AppSettings;
  theme: ThemeTokens;
  selectedPath: string | null;
  onSelectEntry: (entry: RemoteEntry) => void;
  onOpenEntry: (entry: RemoteEntry) => void;
  onNavigate: (path: string) => void;
  onGoUp: () => void;
  onRefresh: () => void;
  onDownloadSelected: () => void;
  onUploadPicker: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onDeleteSelected: () => void;
  onToggleHidden: () => void;
  onToggleFollowCd: (v: boolean) => void;
  onToggleMonitoring: (v: boolean) => void;
  onMiddleClickEntry: (entry: RemoteEntry) => void;
  onItemContextMenu: (entry: RemoteEntry, x: number, y: number) => void;
  onBgContextMenu: (x: number, y: number) => void;
}

export function SftpSidebar({
  session,
  settings,
  theme,
  selectedPath,
  onSelectEntry,
  onOpenEntry,
  onNavigate,
  onGoUp,
  onRefresh,
  onDownloadSelected,
  onUploadPicker,
  onNewFolder,
  onNewFile,
  onDeleteSelected,
  onToggleHidden,
  onToggleFollowCd,
  onToggleMonitoring,
  onMiddleClickEntry,
  onItemContextMenu,
  onBgContextMenu,
}: SftpSidebarProps) {
  const [pathDraft, setPathDraft] = useState(session?.sftpPath ?? "/");

  useEffect(() => {
    setPathDraft(session?.sftpPath ?? "/");
  }, [session?.sftpPath]);

  if (!session) {
    return (
      <div className="px-1 py-3 text-xs" style={{ color: theme.textMuted }}>
        Connect to an SSH host to browse files.
      </div>
    );
  }

  const visibleEntries = session.sftpEntries.filter(
    (e) => settings.show_hidden_files || !e.name.startsWith("."),
  );

  const toolBtn =
    "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/8";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* MobaXterm-style SFTP toolbar */}
      <div className="flex items-center gap-0.5">
        <button onClick={onGoUp} title="Parent directory" className={toolBtn}>
          <CornerLeftUp className="h-3.5 w-3.5" style={{ color: theme.warning }} />
        </button>
        <button onClick={onDownloadSelected} title="Download selected" className={toolBtn}>
          <Download className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
        </button>
        <button onClick={onUploadPicker} title="Upload to current folder" className={toolBtn}>
          <Upload className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
        </button>
        <button onClick={onRefresh} title="Refresh" className={toolBtn}>
          <RefreshCw className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
        </button>
        <button onClick={onNewFolder} title="New directory" className={toolBtn}>
          <FolderPlus className="h-3.5 w-3.5" style={{ color: theme.warning }} />
        </button>
        <button onClick={onNewFile} title="New empty file" className={toolBtn}>
          <FilePlus className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
        </button>
        <button onClick={onDeleteSelected} title="Delete selected" className={toolBtn}>
          <Trash2 className="h-3.5 w-3.5" style={{ color: theme.danger }} />
        </button>
        <div className="flex-1" />
        <button
          onClick={onToggleHidden}
          title={settings.show_hidden_files ? "Hide dotfiles" : "Show dotfiles"}
          className={toolBtn}
        >
          {settings.show_hidden_files ? (
            <Eye className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
          ) : (
            <EyeOff className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
          )}
        </button>
      </div>

      {/* Editable path bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pathDraft.trim()) onNavigate(pathDraft.trim());
        }}
      >
        <input
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          className="w-full rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none"
          style={{
            backgroundColor: theme.bgBase,
            borderColor: theme.border,
            color: theme.textPrimary,
          }}
        />
      </form>

      {/* Column headers */}
      <div
        className="flex items-center justify-between rounded-md border px-2.5 py-1 text-[11px]"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
          color: theme.textMuted,
        }}
      >
        <span>Name</span>
        <span>Size</span>
      </div>

      {/* File list (right-clicking empty area opens background context menu) */}
      <div
        className="min-h-0 flex-1 overflow-y-auto pr-0.5"
        onContextMenu={(e) => {
          e.preventDefault();
          onBgContextMenu(e.clientX, e.clientY);
        }}
      >
        {session.sftpPath !== "/" && (
          <div
            onClick={onGoUp}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-white/6"
            style={{ color: theme.textPrimary }}
          >
            <CornerLeftUp className="h-3.5 w-3.5 shrink-0" style={{ color: theme.warning }} />
            <span>..</span>
          </div>
        )}

        {visibleEntries.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs" style={{ color: theme.textMuted }}>
            Empty directory
          </div>
        ) : (
          visibleEntries.map((entry) => {
            const isSelected = selectedPath === entry.path;
            return (
              <div
                key={entry.path}
                onClick={() => onSelectEntry(entry)}
                onDoubleClick={() => onOpenEntry(entry)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onMiddleClickEntry(entry);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelectEntry(entry);
                  onItemContextMenu(entry, e.clientX, e.clientY);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors"
                style={{
                  backgroundColor: isSelected ? theme.bgElevated : "transparent",
                  color: theme.textPrimary,
                }}
              >
                {entry.kind === "directory" ? (
                  <Folder
                    className="h-3.5 w-3.5 shrink-0 fill-current"
                    style={{ color: theme.warning }}
                  />
                ) : entry.kind === "symlink" ? (
                  <Link2 className="h-3.5 w-3.5 shrink-0" style={{ color: theme.accent }} />
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0" style={{ color: theme.textMuted }} />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums" style={{ color: theme.textMuted }}>
                  {formatBytes(entry.size, entry.kind === "directory")}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* MobaXterm bottom checkboxes */}
      <div
        className="space-y-1.5 rounded-lg border px-2.5 py-2 text-[11px]"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
          color: theme.textPrimary,
        }}
      >
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={settings.follow_terminal_folder}
            onChange={(e) => onToggleFollowCd(e.target.checked)}
            className="rounded accent-zinc-300"
          />
          <span>Follow terminal folder</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={settings.remote_monitoring}
            onChange={(e) => onToggleMonitoring(e.target.checked)}
            className="rounded accent-zinc-300"
          />
          <span>Remote monitoring</span>
        </label>
      </div>
    </div>
  );
}
