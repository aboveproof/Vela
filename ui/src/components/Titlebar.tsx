import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, PanelLeft, Plus, Square, X } from "lucide-react";
import type { SessionTab, ThemeTokens } from "../types";

interface TitlebarProps {
  sessions: SessionTab[];
  activeSessionId: string | null;
  theme: ThemeTokens;
  onToggleSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export function Titlebar({
  sessions,
  activeSessionId,
  theme,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: TitlebarProps) {
  const appWindow = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center justify-between border-b px-2"
      style={{
        backgroundColor: theme.bgBase,
        borderColor: theme.border,
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <button
          onClick={onToggleSidebar}
          title="Toggle Sidebar (Ctrl+B)"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-white/5"
          style={{ color: theme.textPrimary }}
        >
          <PanelLeft className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
          <span>Vela</span>
        </button>

        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {sessions.map((s) => {
            const active = s.id === activeSessionId;
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
                  backgroundColor: active ? theme.bgElevated : "transparent",
                  borderColor: active ? theme.border : "transparent",
                  color: active ? theme.textPrimary : theme.textMuted,
                }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
                <span className="max-w-[140px] truncate">{s.title}</span>
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
      </div>

      <div data-tauri-drag-region className="h-full min-w-[40px] flex-1" />

      <div className="flex items-center gap-0.5">
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
          title="Maximize"
        >
          <Square className="h-3 w-3" />
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
