import { useEffect, useState } from "react";
import { THEMES, type AppSettings, type CursorStyle, type ThemeId, type ThemeTokens } from "../types";

interface SettingsPanelProps {
  settings: AppSettings;
  theme: ThemeTokens;
  onUpdateSettings: (next: AppSettings) => void;
}

const FONT_PRESETS: { label: string; value: string | null }[] = [
  { label: "System Default", value: null },
  { label: "Consolas", value: "Consolas" },
  { label: "Cascadia Mono", value: "Cascadia Mono" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Fira Code", value: "Fira Code" },
];

const CURSORS: { label: string; value: CursorStyle }[] = [
  { label: "Beam", value: "beam" },
  { label: "Block", value: "block" },
  { label: "Underline", value: "underline" },
];

const SCROLLBACKS = [
  { label: "5,000", value: 5000 },
  { label: "10,000", value: 10000 },
  { label: "50,000", value: 50000 },
];

export function SettingsPanel({ settings, theme, onUpdateSettings }: SettingsPanelProps) {
  const [customFont, setCustomFont] = useState(settings.terminal_font ?? "");

  useEffect(() => {
    setCustomFont(settings.terminal_font ?? "");
  }, [settings.terminal_font]);

  const chipStyle = (active: boolean) => ({
    backgroundColor: active ? theme.bgElevated : theme.bgBase,
    borderColor: theme.border,
    color: active ? theme.textPrimary : theme.textMuted,
  });

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1 text-xs">
      {/* Font */}
      <section className="space-y-2">
        <div className="font-medium" style={{ color: theme.textPrimary }}>
          Terminal Font
        </div>
        <div className="text-[11px]" style={{ color: theme.textMuted }}>
          Active: {settings.terminal_font ?? "System Default (Monospace)"}
        </div>
        <div className="space-y-1">
          {FONT_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setCustomFont(p.value ?? "");
                onUpdateSettings({ ...settings, terminal_font: p.value });
              }}
              className="flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left transition-colors hover:bg-white/5"
              style={chipStyle(settings.terminal_font === p.value)}
            >
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = customFont.trim();
            onUpdateSettings({ ...settings, terminal_font: trimmed ? trimmed : null });
          }}
          className="flex gap-1.5"
        >
          <input
            value={customFont}
            onChange={(e) => setCustomFont(e.target.value)}
            placeholder="Custom installed font..."
            className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-xs outline-none"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textPrimary,
            }}
          />
          <button
            type="submit"
            className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium"
            style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
          >
            Apply
          </button>
        </form>
      </section>

      {/* Font Size */}
      <section className="space-y-2">
        <div className="font-medium" style={{ color: theme.textPrimary }}>
          Font Size
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              onUpdateSettings({
                ...settings,
                terminal_font_size: Math.max(10, settings.terminal_font_size - 1),
              })
            }
            className="rounded-lg border px-3 py-1 transition-colors hover:bg-white/5"
            style={chipStyle(false)}
          >
            -
          </button>
          <span className="w-12 text-center tabular-nums" style={{ color: theme.textPrimary }}>
            {Math.round(settings.terminal_font_size)} px
          </span>
          <button
            onClick={() =>
              onUpdateSettings({
                ...settings,
                terminal_font_size: Math.min(24, settings.terminal_font_size + 1),
              })
            }
            className="rounded-lg border px-3 py-1 transition-colors hover:bg-white/5"
            style={chipStyle(false)}
          >
            +
          </button>
        </div>
      </section>

      {/* Cursor Style */}
      <section className="space-y-2">
        <div className="font-medium" style={{ color: theme.textPrimary }}>
          Cursor Style
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {CURSORS.map((c) => (
            <button
              key={c.value}
              onClick={() => onUpdateSettings({ ...settings, cursor_style: c.value })}
              className="rounded-lg border py-1.5 text-[11px] transition-colors hover:bg-white/5"
              style={chipStyle(settings.cursor_style === c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>

      {/* Scrollback */}
      <section className="space-y-2">
        <div className="font-medium" style={{ color: theme.textPrimary }}>
          Scrollback Lines
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {SCROLLBACKS.map((s) => (
            <button
              key={s.value}
              onClick={() => onUpdateSettings({ ...settings, scrollback_lines: s.value })}
              className="rounded-lg border py-1.5 text-[11px] transition-colors hover:bg-white/5"
              style={chipStyle(settings.scrollback_lines === s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {/* Behavior */}
      <section className="space-y-2">
        <div className="font-medium" style={{ color: theme.textPrimary }}>
          Behavior
        </div>
        <div className="space-y-2 text-[11px]">
          {[
            ["Copy selection automatically", "copy_on_select"],
            ["Right-click pastes in terminal", "right_click_paste"],
            ["Follow terminal folder in SFTP", "follow_terminal_folder"],
            ["Show remote system monitor", "remote_monitoring"],
            ["Show hidden dotfiles", "show_hidden_files"],
          ].map(([label, key]) => (
            <label key={key} className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={Boolean(settings[key as keyof AppSettings])}
                onChange={(e) =>
                  onUpdateSettings({
                    ...settings,
                    [key]: e.target.checked,
                  })
                }
                className="rounded accent-zinc-300"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* Theme */}
      <section className="space-y-2 pb-2">
        <div className="font-medium" style={{ color: theme.textPrimary }}>
          Theme
        </div>
        <div className="space-y-1">
          {(Object.keys(THEMES) as ThemeId[]).map((id) => (
            <button
              key={id}
              onClick={() => onUpdateSettings({ ...settings, theme_id: id })}
              className="flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left transition-colors hover:bg-white/5"
              style={chipStyle(settings.theme_id === id)}
            >
              <span>{THEMES[id].label}</span>
              <span
                className="h-3 w-3 rounded-full border"
                style={{ backgroundColor: THEMES[id].termBg, borderColor: THEMES[id].border }}
              />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
