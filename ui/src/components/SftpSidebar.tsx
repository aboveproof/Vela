import { useEffect, useState } from "react";
import {
  Bookmark,
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
  Search,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import {
  formatBytes,
  type AppSettings,
  type RemoteEntry,
  type SessionTab,
  type ThemeTokens,
} from "../types";

interface SftpSidebarProps {
  session: SessionTab | null;
  bookmarks: string[];
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
  onToggleBookmark: (path: string) => void;
  onToggleFollowCd: (v: boolean) => void;
  onToggleMonitoring: (v: boolean) => void;
  onMiddleClickEntry: (entry: RemoteEntry) => void;
  onItemContextMenu: (entry: RemoteEntry, x: number, y: number) => void;
  onBgContextMenu: (x: number, y: number) => void;
}

export function SftpSidebar({
  session,
  bookmarks,
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
  onToggleBookmark,
  onToggleFollowCd,
  onToggleMonitoring,
  onMiddleClickEntry,
  onItemContextMenu,
  onBgContextMenu,
}: SftpSidebarProps) {
  const [pathDraft, setPathDraft] = useState(session?.sftpPath ?? "/");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setPathDraft(session?.sftpPath ?? "/");
    setFilter("");
  }, [session?.sftpPath, session?.id]);

  if (!session) {
    return (
      <div className="px-1 py-3 text-xs" style={{ color: theme.textMuted }}>
        Connect to an SSH host to browse files.
      </div>
    );
  }

  const isBookmarked = bookmarks.includes(session.sftpPath);
  const query = filter.trim().toLowerCase();
  const visibleEntries = session.sftpEntries.filter((e) => {
    if (!settings.show_hidden_files && e.name.startsWith(".")) return false;
    if (query && !e.name.toLowerCase().includes(query)) return false;
    return true;
  });

  const toolBtn =
    "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/8";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* SFTP icon toolbar */}
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

      {/* Editable path bar + pin bookmark star */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pathDraft.trim()) onNavigate(pathDraft.trim());
        }}
        className="flex items-center gap-1"
      >
        <input
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none"
          style={{
            backgroundColor: theme.bgBase,
            borderColor: theme.border,
            color: theme.textPrimary,
          }}
        />
        {session.profileId && (
          <button
            type="button"
            onClick={() => onToggleBookmark(session.sftpPath)}
            title={isBookmarked ? "Remove bookmark" : "Pin directory bookmark"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-white/6"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: isBookmarked ? theme.warning : theme.textMuted,
            }}
          >
            <Star className={`h-3.5 w-3.5 ${isBookmarked ? "fill-current" : ""}`} />
          </button>
        )}
      </form>

      {/* Pinned directory bookmarks strip */}
      {bookmarks.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {bookmarks.map((bm) => {
            const label = bm === "/" ? "/" : bm.split("/").filter(Boolean).pop() ?? bm;
            const isCurrent = session.sftpPath === bm;
            return (
              <button
                key={bm}
                type="button"
                onClick={() => onNavigate(bm)}
                title={bm}
                className="flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-white/8"
                style={{
                  backgroundColor: isCurrent ? theme.bgElevated : theme.bgBase,
                  borderColor: theme.border,
                  color: isCurrent ? theme.textPrimary : theme.textMuted,
                }}
              >
                <Bookmark className="h-2.5 w-2.5 shrink-0" style={{ color: theme.warning }} />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Instant filename filter */}
      <div
        className="flex items-center gap-1.5 rounded-lg border px-2 py-1"
        style={{ backgroundColor: theme.bgBase, borderColor: theme.border }}
      >
        <Search className="h-3 w-3 shrink-0" style={{ color: theme.textMuted }} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files..."
          className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
          style={{ color: theme.textPrimary }}
        />
      </div>

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

      {/* File list */}
      <div
        className="min-h-0 flex-1 overflow-y-auto pr-0.5"
        onContextMenu={(e) => {
          e.preventDefault();
          onBgContextMenu(e.clientX, e.clientY);
        }}
      >
        {session.sftpPath !== "/" && !query && (
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
            {query ? "No matching files" : "Empty directory"}
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

      {/* Bottom checkboxes */}
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
