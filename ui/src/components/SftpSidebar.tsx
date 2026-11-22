import { useEffect, useState } from "react";
import {
  Bookmark,
  ArrowDownAZ,
  ArrowUpAZ,
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
  type SftpDockPosition,
  type ThemeTokens,
} from "../types";

interface SftpSidebarProps {
  horizontal: boolean;
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
  onSetDockPosition: (position: SftpDockPosition) => void;
  onMiddleClickEntry: (entry: RemoteEntry) => void;
  onItemContextMenu: (entry: RemoteEntry, x: number, y: number) => void;
  onBgContextMenu: (x: number, y: number) => void;
}

export function SftpSidebar({
  horizontal,
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
  onSetDockPosition,
  onMiddleClickEntry,
  onItemContextMenu,
  onBgContextMenu,
}: SftpSidebarProps) {
  const [pathDraft, setPathDraft] = useState(session?.sftpPath ?? "/");
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "size" | "modified">("name");
  const [sortDescending, setSortDescending] = useState(false);

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
  }).sort((a, b) => {
    // Keep folders together, regardless of the chosen sort order.
    if (a.kind === "directory" && b.kind !== "directory") return -1;
    if (b.kind === "directory" && a.kind !== "directory") return 1;
    const comparison = sortBy === "size"
      ? a.size - b.size
      : sortBy === "modified"
        ? (a.modified_epoch ?? 0) - (b.modified_epoch ?? 0)
        : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return (sortDescending ? -1 : 1) * (comparison || a.name.localeCompare(b.name));
  });

  const toolBtn =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-35";

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${horizontal ? "vela-sftp-horizontal" : ""}`}>
      {/* SFTP icon toolbar */}
      <div className="vela-sftp-actions flex shrink-0 items-center gap-0.5 overflow-x-auto" aria-label="File actions">
        <button onClick={onGoUp} title="Parent directory" className={toolBtn}>
          <CornerLeftUp className="h-3.5 w-3.5" style={{ color: theme.warning }} />
        </button>
        <button onClick={onDownloadSelected} disabled={!selectedPath} title="Download selected" aria-label="Download selected file" className={toolBtn}>
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
        <button onClick={onDeleteSelected} disabled={!selectedPath} title="Delete selected" aria-label="Delete selected file" className={toolBtn}>
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
      <div className={`vela-sftp-location flex min-w-0 shrink-0 gap-2 ${horizontal ? "items-center" : "flex-col"}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pathDraft.trim()) onNavigate(pathDraft.trim());
        }}
        className="flex min-w-0 flex-1 items-center gap-1"
      >
        <input
          value={pathDraft}
          aria-label="Remote directory path"
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
        <div className={`flex min-w-0 gap-1 overflow-x-auto ${horizontal ? "max-w-40" : ""}`}>
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
        className={`flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1 ${horizontal ? "w-48 shrink-0" : ""}`}
        style={{ backgroundColor: theme.bgBase, borderColor: theme.border }}
      >
        <Search className="h-3 w-3 shrink-0" style={{ color: theme.textMuted }} />
        <input
          value={filter}
          aria-label="Filter remote files"
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files..."
          className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
          style={{ color: theme.textPrimary }}
        />
      </div>
      </div>

      <div className={`vela-sftp-sort flex shrink-0 items-center gap-2 text-[11px] ${horizontal ? "" : "flex-wrap"}`} style={{ color: theme.textMuted }}>
        <span className={`min-w-0 truncate tabular-nums ${horizontal ? "flex-1" : "w-full"}`}>{visibleEntries.length} {visibleEntries.length === 1 ? "item" : "items"}{selectedPath && visibleEntries.some((entry) => entry.path === selectedPath) ? " · 1 selected" : ""}</span>
        <label className="flex items-center gap-1">
          <span>Sort</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="rounded-lg border px-2 py-1 text-[11px]" style={{ backgroundColor: theme.bgBase, borderColor: theme.border, color: theme.textPrimary }}>
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="modified">Modified</option>
          </select>
        </label>
        <button type="button" onClick={() => setSortDescending((v) => !v)} aria-label={sortDescending ? "Sort ascending" : "Sort descending"} title={sortDescending ? "Descending" : "Ascending"} className={toolBtn}>
          {sortDescending ? <ArrowUpAZ className="h-4 w-4" /> : <ArrowDownAZ className="h-4 w-4" />}
        </button>
        <label className="flex items-center gap-1">
          <span>Dock</span>
          <select value={settings.sftp_position} onChange={(e) => onSetDockPosition(e.target.value as SftpDockPosition)} aria-label="File browser dock position" className="rounded-lg border px-2 py-1 text-[11px]" style={{ backgroundColor: theme.bgBase, borderColor: theme.border, color: theme.textPrimary }}>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="bottom">Bottom</option>
            <option value="top">Top</option>
          </select>
        </label>
      </div>

      {/* Column headers */}
      <div
        className="vela-sftp-columns flex items-center justify-between rounded-md border px-2.5 py-1 text-[11px]"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
          color: theme.textMuted,
        }}
      >
        <span>Name</span>
        <span className="flex gap-2"><span>Size</span>{horizontal && <span className="hidden w-36 text-right sm:block">Modified</span>}</span>
      </div>

      {/* File list */}
      <div
        className="vela-sftp-files min-h-0 flex-1 overflow-y-auto pr-0.5"
        onContextMenu={(e) => {
          e.preventDefault();
          onBgContextMenu(e.clientX, e.clientY);
        }}
      >
        {session.sftpPath !== "/" && !query && (
          <button
            type="button"
            onClick={onGoUp}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/6"
            style={{ color: theme.textPrimary }}
          >
            <CornerLeftUp className="h-3.5 w-3.5 shrink-0" style={{ color: theme.warning }} />
            <span>..</span>
          </button>
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
                role="button"
                tabIndex={0}
                aria-label={`${entry.kind === "directory" ? "Folder" : "File"} ${entry.name}`}
                aria-pressed={isSelected}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpenEntry(entry);
                  if (e.key === " ") { e.preventDefault(); onSelectEntry(entry); }
                }}
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
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-white/5"
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
                {horizontal && <span className="hidden w-36 shrink-0 text-right text-[10px] tabular-nums sm:block" style={{ color: theme.textMuted }}>
                  {entry.modified_epoch ? new Date(entry.modified_epoch * 1000).toLocaleString() : "—"}
                </span>}
              </div>
            );
          })
        )}
      </div>

      {/* Browser options stay accessible without taking space from the file list. */}
      <details
        className="vela-sftp-options shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px]"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
          color: theme.textPrimary,
        }}
      >
        <summary className="cursor-pointer select-none" style={{ color: theme.textMuted }}>Browser options</summary>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
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
      </details>
    </div>
  );
}
