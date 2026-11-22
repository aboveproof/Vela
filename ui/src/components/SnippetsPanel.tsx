import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Play,
  Plus,
  Radio,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { Snippet, ThemeTokens } from "../types";

interface SnippetsPanelProps {
  snippets: Snippet[];
  hasActiveSession: boolean;
  sessionCount: number;
  theme: ThemeTokens;
  onRunSnippet: (s: Snippet, broadcast: boolean) => void;
  onCreateSnippet: (name: string, command: string, autoExecute: boolean) => void;
  onDeleteSnippet: (id: string) => void;
}

export function SnippetsPanel({
  snippets,
  hasActiveSession,
  sessionCount,
  theme,
  onRunSnippet,
  onCreateSnippet,
  onDeleteSnippet,
}: SnippetsPanelProps) {
  const [filter, setFilter] = useState("");
  const [formOpen, setFormOpen] = useState(snippets.length === 0);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [autoExecute, setAutoExecute] = useState(true);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        (s.folder ?? "").toLowerCase().includes(q),
    );
  }, [snippets, filter]);

  const inputStyle = {
    backgroundColor: theme.bgBase,
    borderColor: theme.border,
    color: theme.textPrimary,
  };

  const canSubmit = name.trim().length > 0 && command.trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onCreateSnippet(name.trim(), command.trim(), autoExecute);
    setName("");
    setCommand("");
    setAutoExecute(true);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5">
      {/* Search bar */}
      {snippets.length > 0 && (
        <div
          className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5"
          style={inputStyle}
        >
          <Search className="h-3.5 w-3.5 shrink-0" style={{ color: theme.textMuted }} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter snippets..."
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            style={{ color: theme.textPrimary }}
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              title="Clear filter"
              className="flex h-4 w-4 items-center justify-center rounded hover:bg-white/10"
              style={{ color: theme.textMuted }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Snippets list */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div
            className="rounded-xl border px-3 py-5 text-center text-xs"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textMuted,
            }}
          >
            <Terminal className="mx-auto mb-1.5 h-4 w-4 opacity-60" />
            {snippets.length === 0
              ? "No command snippets yet. Create one below."
              : "No matching snippets."}
          </div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border p-2.5 transition-colors"
              style={{
                backgroundColor: theme.bgElevated,
                borderColor: theme.border,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="truncate text-xs font-medium"
                      style={{ color: theme.textPrimary }}
                    >
                      {s.name}
                    </span>
                    {s.folder && (
                      <span
                        className="shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: theme.bgSurface,
                          borderColor: theme.border,
                          color: theme.textMuted,
                        }}
                      >
                        {s.folder}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  title={s.auto_execute ? "Runs automatically (sends Enter)" : "Pastes into terminal without Enter"}
                  className="flex shrink-0 items-center gap-0.5 text-[10px]"
                  style={{ color: theme.textMuted }}
                >
                  {s.auto_execute ? (
                    <>
                      <CornerDownLeft className="h-2.5 w-2.5" />
                      Auto
                    </>
                  ) : (
                    "Paste"
                  )}
                </span>
              </div>

              <pre
                className="mt-1.5 line-clamp-3 overflow-hidden whitespace-pre-wrap break-all rounded-lg border px-2 py-1.5 font-mono text-[11px] leading-relaxed"
                style={{
                  backgroundColor: theme.bgBase,
                  borderColor: theme.border,
                  color: theme.textPrimary,
                }}
              >
                {s.command}
              </pre>

              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!hasActiveSession}
                  onClick={() => onRunSnippet(s, false)}
                  title={
                    hasActiveSession
                      ? s.auto_execute
                        ? "Run in active terminal"
                        : "Paste into active terminal"
                      : "Connect to a host first"
                  }
                  className="vela-focus flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{
                    backgroundColor: theme.textPrimary,
                    color: theme.bgBase,
                  }}
                >
                  <Play className="h-3 w-3 fill-current" />
                  Run
                </button>

                {sessionCount > 1 && (
                  <button
                    type="button"
                    disabled={!hasActiveSession}
                    onClick={() => onRunSnippet(s, true)}
                    title={`Broadcast to all ${sessionCount} connected tabs`}
                    className="vela-focus flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium tabular-nums transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                    style={{
                      borderColor: theme.border,
                      color: theme.textPrimary,
                    }}
                  >
                    <Radio className="h-3 w-3" />
                    All ({sessionCount})
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onDeleteSnippet(s.id)}
                  title="Delete snippet"
                  className="vela-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border opacity-70 transition-opacity hover:bg-white/5 hover:opacity-100"
                  style={{
                    borderColor: theme.border,
                    color: theme.danger,
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Collapsible New Snippet form */}
      <div
        className="mt-auto rounded-xl border"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
        }}
      >
        <button
          type="button"
          onClick={() => setFormOpen((prev) => !prev)}
          className="vela-focus flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-medium transition-colors hover:bg-white/[0.03]"
          style={{ color: theme.textPrimary }}
        >
          <span className="flex items-center gap-1.5">
            <Plus className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
            New Snippet
          </span>
          {formOpen ? (
            <ChevronDown className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" style={{ color: theme.textMuted }} />
          )}
        </button>

        {formOpen && (
          <form
            onSubmit={handleSubmit}
            className="space-y-2 border-t p-3"
            style={{ borderColor: theme.border }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Snippet name (e.g. Tail nginx logs)"
              className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
              style={inputStyle}
            />

            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="sudo journalctl -u nginx -f"
              rows={3}
              className="w-full resize-none rounded-lg border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed outline-none"
              style={inputStyle}
            />

            <label
              className="flex cursor-pointer items-center gap-2 text-[11px]"
              style={{ color: theme.textMuted }}
            >
              <input
                type="checkbox"
                checked={autoExecute}
                onChange={(e) => setAutoExecute(e.target.checked)}
                className="rounded accent-zinc-300"
              />
              <span>Auto-execute (press Enter after pasting)</span>
            </label>

            <button
              type="submit"
              disabled={!canSubmit}
              className="vela-focus w-full rounded-lg py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                backgroundColor: theme.textPrimary,
                color: theme.bgBase,
              }}
            >
              Save Snippet
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
