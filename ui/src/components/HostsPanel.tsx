import { useState } from "react";
import { ArrowRight, Download, Play, Search, Server, Trash2 } from "lucide-react";
import type { HostProfile, ThemeTokens } from "../types";

export interface QuickFormValues {
  name: string;
  host: string;
  port: string;
  username: string;
  useKey: boolean;
  password: string;
  keyPath: string;
  passphrase: string;
}

interface HostsPanelProps {
  profiles: HostProfile[];
  theme: ThemeTokens;
  form: QuickFormValues;
  onChangeForm: (next: QuickFormValues) => void;
  onSaveAndConnect: () => void;
  onConnectProfile: (profileId: string) => void;
  onDeleteProfile: (profileId: string) => void;
  onImportSshConfig: () => void;
}

export function HostsPanel({
  profiles,
  theme,
  form,
  onChangeForm,
  onSaveAndConnect,
  onConnectProfile,
  onDeleteProfile,
  onImportSshConfig,
}: HostsPanelProps) {
  const [filter, setFilter] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const filtered = profiles.filter((p) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      p.username.toLowerCase().includes(q)
    );
  });

  const inputStyle = {
    backgroundColor: theme.bgBase,
    borderColor: theme.border,
    color: theme.textPrimary,
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-0.5">
      <div className="relative flex items-center gap-1.5">
        <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5" strokeWidth={1.7} style={{ color: theme.textMuted }} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search connections"
          aria-label="Search saved connections"
          className="min-w-0 flex-1 rounded-xl border py-2.5 pl-9 pr-2 text-xs outline-none"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={onImportSshConfig}
          title="Import hosts from ~/.ssh/config"
          className="flex h-9 shrink-0 items-center gap-1 rounded-xl border px-2 text-[11px] transition-colors hover:bg-white/6"
          style={{
            backgroundColor: theme.bgElevated,
            borderColor: theme.border,
            color: theme.textPrimary,
          }}
        >
          <Download className="h-3 w-3" style={{ color: theme.textMuted }} />
          <span>Import</span>
        </button>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-0.5 pb-1 text-[11px]" style={{ color: theme.textMuted }}>
          <span>Saved hosts</span><span className="tabular-nums">{filtered.length}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="rounded-xl border px-4 py-5 text-center text-xs leading-5" style={{ color: theme.textMuted, borderColor: theme.border, backgroundColor: theme.bgBase }}>
            {profiles.length === 0 ? "Add a connection below or import your SSH config." : "No hosts match your search."}
          </div>
        ) : (
          filtered.map((p) => (
            <div key={p.id} className="space-y-1">
            <div
              key={p.id}
              onDoubleClick={() => onConnectProfile(p.id)}
              className="group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors hover:bg-white/[0.03]"
              style={{
                backgroundColor: theme.bgElevated,
                borderColor: theme.border,
              }}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ color: theme.accent, backgroundColor: theme.bgSurface }}><Server className="h-4 w-4" strokeWidth={1.6} /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium" style={{ color: theme.textPrimary }}>
                  {p.name}
                </div>
                <div className="truncate text-[11px]" style={{ color: theme.textMuted }}>
                  {p.username}@{p.host}
                  {p.port !== 22 ? `:${p.port}` : ""}
                </div>
              </div>
              <button
                onClick={() => onConnectProfile(p.id)}
                title="Connect"
                aria-label={`Connect to ${p.name}`}
                className="flex h-7 w-7 items-center justify-center rounded-lg transition-opacity hover:opacity-85"
                style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
              >
                <Play className="h-3 w-3 fill-current" />
              </button>
              <button
                onClick={() => setPendingDeleteId(p.id)}
                title="Delete host"
                aria-label={`Delete ${p.name}`}
                className="flex h-7 w-7 items-center justify-center rounded-lg opacity-60 transition-opacity hover:bg-white/10 hover:opacity-100"
                style={{ color: theme.danger }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {pendingDeleteId === p.id && (
              <div className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11px]" style={{ color: theme.textPrimary, backgroundColor: theme.bgBase }}>
                <span className="truncate">Delete {p.name}?</span>
                <div className="flex shrink-0 gap-1">
                  <button type="button" className="rounded-lg px-2 py-1" onClick={() => setPendingDeleteId(null)}>Cancel</button>
                  <button type="button" className="rounded-lg px-2 py-1 font-semibold" style={{ color: theme.danger, backgroundColor: theme.bgElevated }} onClick={() => { onDeleteProfile(p.id); setPendingDeleteId(null); }}>Delete</button>
                </div>
              </div>
            )}
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSaveAndConnect();
        }}
        className="mt-1 space-y-3 rounded-2xl border p-3.5"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
        }}
      >
        <div className="flex items-center justify-between text-xs font-semibold" style={{ color: theme.textPrimary }}>
          <span>New connection</span><ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} style={{ color: theme.textMuted }} />
        </div>

        <input
          value={form.name}
          onChange={(e) => onChangeForm({ ...form, name: e.target.value })}
          placeholder="Name (optional)"
          aria-label="Connection name"
          className="w-full rounded-xl border px-3 py-2 text-xs outline-none"
          style={inputStyle}
        />

        <div className="flex gap-1.5">
          <input
            value={form.host}
            onChange={(e) => onChangeForm({ ...form, host: e.target.value })}
            placeholder="Host / IP"
            aria-label="Host address"
            required
            className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-xs outline-none"
            style={inputStyle}
          />
          <input
            value={form.port}
            onChange={(e) => onChangeForm({ ...form, port: e.target.value })}
            placeholder="22"
            aria-label="SSH port"
            inputMode="numeric"
            className="w-16 rounded-xl border px-2 py-2 text-center text-xs outline-none"
            style={inputStyle}
          />
        </div>

        <input
          value={form.username}
          onChange={(e) => onChangeForm({ ...form, username: e.target.value })}
          placeholder="Username"
          aria-label="SSH username"
          required
          className="w-full rounded-xl border px-3 py-2 text-xs outline-none"
          style={inputStyle}
        />

        <div
          className="grid grid-cols-2 gap-1 rounded-xl border p-1 text-[11px]"
          style={{ borderColor: theme.border, backgroundColor: theme.bgSurface }}
        >
          <button
            type="button"
            onClick={() => onChangeForm({ ...form, useKey: false })}
            className="rounded-lg py-1.5 font-medium transition-colors"
            style={{
              backgroundColor: !form.useKey ? theme.bgElevated : "transparent",
              color: !form.useKey ? theme.textPrimary : theme.textMuted,
            }}
          >
            Password
          </button>
          <button
            type="button"
            onClick={() => onChangeForm({ ...form, useKey: true })}
            className="rounded-lg py-1.5 font-medium transition-colors"
            style={{
              backgroundColor: form.useKey ? theme.bgElevated : "transparent",
              color: form.useKey ? theme.textPrimary : theme.textMuted,
            }}
          >
            SSH Key
          </button>
        </div>

        {form.useKey ? (
          <>
            <input
              value={form.keyPath}
              onChange={(e) => onChangeForm({ ...form, keyPath: e.target.value })}
              placeholder="Private key path (~/.ssh/id_ed25519)"
              aria-label="Private key path"
              required
              className="w-full rounded-xl border px-3 py-2 text-xs outline-none"
              style={inputStyle}
            />
            <input
              type="password"
              value={form.passphrase}
              onChange={(e) => onChangeForm({ ...form, passphrase: e.target.value })}
              placeholder="Passphrase (optional)"
              aria-label="Private key passphrase"
              className="w-full rounded-xl border px-3 py-2 text-xs outline-none"
              style={inputStyle}
            />
          </>
        ) : (
          <input
            type="password"
            value={form.password}
            onChange={(e) => onChangeForm({ ...form, password: e.target.value })}
            placeholder="Password"
            aria-label="SSH password"
            className="w-full rounded-xl border px-3 py-2 text-xs outline-none"
            style={inputStyle}
          />
        )}

        <button
          type="submit"
          className="w-full rounded-xl py-2.5 text-xs font-semibold transition-opacity hover:opacity-90"
          style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
        >
          Save and connect
        </button>
      </form>
    </div>
  );
}
