import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Columns2,
  Copy,
  Minus,
  PanelLeft,
  Plus,
  Radio,
  Search,
  Square,
  X,
} from "lucide-react";
import type { SessionTab, ThemeTokens } from "../types";

interface TitlebarProps {
  sessions: SessionTab[];
  activeSessionId: string | null;
  splitSessionId: string | null;
  broadcastEnabled: boolean;
  theme: ThemeTokens;
  onToggleSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onOpenPalette: () => void;
  onToggleSplit: () => void;
  onToggleBroadcast: () => void;
}

export function Titlebar({
  sessions,
  activeSessionId,
  splitSessionId,
  broadcastEnabled,
  theme,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onOpenPalette,
  onToggleSplit,
  onToggleBroadcast,
}: TitlebarProps) {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const sync = () => {
      void appWindow.isMaximized().then((m) => {
        if (!cancelled) setIsMaximized(m);
      });
    };
    sync();

    void appWindow.onResized(() => sync()).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [appWindow]);

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center justify-between border-b px-2"
      style={{
        backgroundColor: theme.bgBase,
        borderColor: theme.border,
      }}
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1.5">
        <button
          onClick={onToggleSidebar}
          title="Toggle Sidebar (Ctrl+B)"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-white/6"
          style={{ color: theme.textPrimary }}
        >
          <PanelLeft className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
          <span>Vela</span>
        </button>

        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {sessions.map((s) => {
            const active = s.id === activeSessionId;
            const isSplit = s.id === splitSessionId;
            const dotColor =
              s.state === "connected"
                ? theme.success
                : s.state === "connecting"
                  ? theme.warning
                  : theme.danger;

            return (
              <div
                key={s.id}
                onClick={() => onSelectTab(s.id)}
                className="group flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1 text-xs transition-colors"
                style={{
                  backgroundColor: active
                    ? theme.bgElevated
                    : isSplit
                      ? theme.bgSurface
                      : "transparent",
                  borderColor: active || isSplit ? theme.border : "transparent",
                  color: active || isSplit ? theme.textPrimary : theme.textMuted,
                }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
                <span className="max-w-[140px] truncate">{s.title}</span>
                {s.tunnels.length > 0 && (
                  <span
                    className="rounded px-1 text-[9px] tabular-nums"
                    style={{ backgroundColor: theme.bgBase, color: theme.success }}
                    title={`${s.tunnels.length} active tunnel(s)`}
                  >
                    {s.tunnels.length}T
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(s.id);
                  }}
                  className="rounded p-0.5 opacity-60 transition-opacity hover:bg-white/10 hover:opacity-100"
                  title="Close session"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          <button
            onClick={onNewTab}
            title="New Session"
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-white/8"
            style={{ color: theme.textMuted }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div data-tauri-drag-region className="h-8 min-w-[24px] flex-1" />
      </div>

      {/* Right actions: Command Palette, Split View, Broadcast Input, Window Controls */}
      <div className="flex items-center gap-1">
        {sessions.length > 1 && (
          <>
            <button
              onClick={onToggleBroadcast}
              title="Broadcast keyboard input to all open terminals"
              className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-white/6"
              style={{
                backgroundColor: broadcastEnabled ? theme.bgElevated : "transparent",
                borderColor: broadcastEnabled ? theme.warning : "transparent",
                color: broadcastEnabled ? theme.warning : theme.textMuted,
              }}
            >
              <Radio className="h-3 w-3" />
              <span>{broadcastEnabled ? "Broadcast ON" : "Broadcast"}</span>
            </button>

            <button
              onClick={onToggleSplit}
              title="Toggle Side-by-Side Split View"
              className="flex h-7 w-7 items-center justify-center rounded-md border transition-colors hover:bg-white/6"
              style={{
                backgroundColor: splitSessionId ? theme.bgElevated : "transparent",
                borderColor: splitSessionId ? theme.border : "transparent",
                color: splitSessionId ? theme.textPrimary : theme.textMuted,
              }}
            >
              <Columns2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}

        <button
          onClick={onOpenPalette}
          title="Command Palette (Ctrl+K)"
          className="mr-1 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-white/6"
          style={{
            backgroundColor: theme.bgSurface,
            borderColor: theme.border,
            color: theme.textMuted,
          }}
        >
          <Search className="h-3 w-3" />
          <span>Command</span>
          <kbd
            className="rounded px-1 text-[10px]"
            style={{ backgroundColor: theme.bgBase, color: theme.textMuted }}
          >
            Ctrl+K
          </kbd>
        </button>

        <button
          onClick={() => void appWindow.minimize()}
          className="flex h-7 w-8 items-center justify-center rounded-md transition-colors hover:bg-white/8"
          style={{ color: theme.textMuted }}
          title="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void appWindow.toggleMaximize()}
          className="flex h-7 w-8 items-center justify-center rounded-md transition-colors hover:bg-white/8"
          style={{ color: theme.textMuted }}
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          onClick={() => void appWindow.close()}
          className="flex h-7 w-8 items-center justify-center rounded-md transition-colors hover:bg-red-500/20"
          style={{ color: theme.textMuted }}
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
