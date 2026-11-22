import { useState } from "react";
import { Download, Play, Server, Trash2 } from "lucide-react";
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
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5">
      <div className="flex items-center gap-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter saved hosts..."
          className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-xs outline-none"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={onImportSshConfig}
          title="Import hosts from ~/.ssh/config"
          className="flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] transition-colors hover:bg-white/6"
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
        {filtered.length === 0 ? (
          <div className="px-1 py-2 text-xs" style={{ color: theme.textMuted }}>
            {profiles.length === 0 ? "No saved hosts yet. Add one below." : "No matching hosts."}
          </div>
        ) : (
          filtered.map((p) => (
            <div
              key={p.id}
              onDoubleClick={() => onConnectProfile(p.id)}
              className="group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors hover:bg-white/[0.03]"
              style={{
                backgroundColor: theme.bgElevated,
                borderColor: theme.border,
              }}
            >
              <Server className="h-3.5 w-3.5 shrink-0" style={{ color: theme.textMuted }} />
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
                className="flex h-6 w-6 items-center justify-center rounded-md transition-opacity hover:opacity-85"
                style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
              >
                <Play className="h-3 w-3 fill-current" />
              </button>
              <button
                onClick={() => onDeleteProfile(p.id)}
                title="Delete host"
                className="flex h-6 w-6 items-center justify-center rounded-md opacity-60 transition-opacity hover:bg-white/10 hover:opacity-100"
                style={{ color: theme.danger }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSaveAndConnect();
        }}
        className="mt-1 space-y-2 rounded-xl border p-3"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
        }}
      >
        <div className="text-[11px] font-medium" style={{ color: theme.textMuted }}>
          Quick Connect & Save
        </div>

        <input
          value={form.name}
          onChange={(e) => onChangeForm({ ...form, name: e.target.value })}
          placeholder="Label (e.g. Homeserver)"
          className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
          style={inputStyle}
        />

        <div className="flex gap-1.5">
          <input
            value={form.host}
            onChange={(e) => onChangeForm({ ...form, host: e.target.value })}
            placeholder="Host / IP"
            className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-xs outline-none"
            style={inputStyle}
          />
          <input
            value={form.port}
            onChange={(e) => onChangeForm({ ...form, port: e.target.value })}
            placeholder="22"
            className="w-16 rounded-lg border px-2 py-1.5 text-center text-xs outline-none"
            style={inputStyle}
          />
        </div>

        <input
          value={form.username}
          onChange={(e) => onChangeForm({ ...form, username: e.target.value })}
          placeholder="Username"
          className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
          style={inputStyle}
        />

        <div
          className="grid grid-cols-2 gap-1 rounded-lg border p-0.5 text-[11px]"
          style={{ borderColor: theme.border, backgroundColor: theme.bgSurface }}
        >
          <button
            type="button"
            onClick={() => onChangeForm({ ...form, useKey: false })}
            className="rounded-md py-1 font-medium transition-colors"
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
            className="rounded-md py-1 font-medium transition-colors"
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
              className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
              style={inputStyle}
            />
            <input
              type="password"
              value={form.passphrase}
              onChange={(e) => onChangeForm({ ...form, passphrase: e.target.value })}
              placeholder="Passphrase (optional)"
              className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
              style={inputStyle}
            />
          </>
        ) : (
          <input
            type="password"
            value={form.password}
            onChange={(e) => onChangeForm({ ...form, password: e.target.value })}
            placeholder="Password"
            className="w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none"
            style={inputStyle}
          />
        )}

        <button
          type="submit"
          className="w-full rounded-lg py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
          style={{ backgroundColor: theme.textPrimary, color: theme.bgBase }}
        >
          Save & Connect
        </button>
      </form>
    </div>
  );
}
