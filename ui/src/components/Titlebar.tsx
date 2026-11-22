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
  connectedCount: number;
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
  connectedCount,
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
      className="vela-titlebar flex h-[58px] shrink-0 items-center justify-between border-b px-3"
      style={{
        backgroundColor: theme.bgBase,
        borderColor: theme.border,
      }}
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-3">
        <button
          onClick={onToggleSidebar}
          title="Toggle Sidebar (Ctrl+B)"
          className="vela-brand flex shrink-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-[14px] font-semibold tracking-[-0.04em] transition-colors hover:bg-white/6"
          style={{ color: theme.textPrimary }}
        >
          <span className="vela-brand-symbol flex h-7 w-7 items-center justify-center rounded-[10px]" style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}><PanelLeft className="h-4 w-4" strokeWidth={1.8} /></span>
          <span>Vela</span>
        </button>

        <div role="tablist" aria-label="Connections" className="vela-tablist flex min-w-0 items-center gap-1 overflow-x-auto py-1">
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
                role="tab"
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                aria-label={`${s.title}, ${s.state}`}
                onClick={() => onSelectTab(s.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectTab(s.id);
                  } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const offset = e.key === "ArrowRight" ? 1 : -1;
                    const next = sessions[(sessions.findIndex((tab) => tab.id === s.id) + offset + sessions.length) % sessions.length];
                    onSelectTab(next.id);
                    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-session-tab="${next.id}"]`)?.focus());
                  }
                }}
                data-session-tab={s.id}
                className="group flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-xl border px-3 text-xs transition-colors"
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
                <span className="max-w-[150px] truncate font-medium">{s.title}</span>
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
                  className="rounded-md p-1 opacity-60 transition-opacity hover:bg-white/10 hover:opacity-100"
                  title="Close session"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          <button
            onClick={onNewTab}
            title="New connection"
            aria-label="New connection"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-white/8"
            style={{ color: theme.textMuted }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div data-tauri-drag-region className="h-8 min-w-[24px] flex-1" />
      </div>

      {/* Right actions: Command Palette, Split View, Broadcast Input, Window Controls */}
      <div className="flex shrink-0 items-center gap-1">
        {connectedCount > 1 && (
          <>
            <button
              onClick={onToggleBroadcast}
              title="Broadcast keyboard input to all open terminals"
              className="flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] transition-colors hover:bg-white/6"
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
              className="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:bg-white/6"
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
          className="vela-command-button mr-2 flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[11px] transition-colors hover:bg-white/6"
          style={{
            backgroundColor: theme.bgSurface,
            borderColor: theme.border,
            color: theme.textMuted,
          }}
        >
          <Search className="h-3 w-3" />
          <span>Search commands</span>
          <kbd
            className="rounded-md border px-1.5 py-0.5 text-[10px]"
            style={{ backgroundColor: theme.bgBase, color: theme.textMuted, borderColor: theme.border }}
          >
            Ctrl+K
          </kbd>
        </button>

        <button
          onClick={() => void appWindow.minimize()}
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-white/8"
          style={{ color: theme.textMuted }}
          title="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void appWindow.toggleMaximize()}
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-white/8"
          style={{ color: theme.textMuted }}
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          onClick={() => void appWindow.close()}
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-red-500/20"
          style={{ color: theme.textMuted }}
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
