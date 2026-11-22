import { useState } from "react";
import { ArrowRight, Check, Copy, Network, Play, Square } from "lucide-react";
import type { SessionTab, ThemeTokens } from "../types";

interface TunnelsPanelProps {
  session: SessionTab | null;
  theme: ThemeTokens;
  onStartTunnel: (localPort: number, remoteHost: string, remotePort: number) => void;
  onStopTunnel: (tunnelId: string) => void;
  onCopyAddress: (addr: string) => void;
}

const PRESETS: { label: string; localPort: number; remoteHost: string; remotePort: number }[] = [
  { label: "PostgreSQL 5432", localPort: 5432, remoteHost: "127.0.0.1", remotePort: 5432 },
  { label: "Redis 6379", localPort: 6379, remoteHost: "127.0.0.1", remotePort: 6379 },
  { label: "Web 8080", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 8080 },
];

export function TunnelsPanel({
  session,
  theme,
  onStartTunnel,
  onStopTunnel,
  onCopyAddress,
}: TunnelsPanelProps) {
  const [localPort, setLocalPort] = useState("8080");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("8080");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const isConnected = session !== null && session.state === "connected";
  const parsedLocal = Number.parseInt(localPort, 10);
  const parsedRemote = Number.parseInt(remotePort, 10);
  const validLocal = Number.isInteger(parsedLocal) && parsedLocal >= 1 && parsedLocal <= 65535;
  const validRemote = Number.isInteger(parsedRemote) && parsedRemote >= 1 && parsedRemote <= 65535;
  const validHost = remoteHost.trim().length > 0;
  const canStart = isConnected && validLocal && validRemote && validHost;

  const inputStyle = {
    backgroundColor: theme.bgBase,
    borderColor: theme.border,
    color: theme.textPrimary,
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    onStartTunnel(parsedLocal, remoteHost.trim(), parsedRemote);
  };

  const handleCopy = (id: string, addr: string) => {
    onCopyAddress(addr);
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((cur) => (cur === id ? null : cur));
    }, 1400);
  };

  if (!isConnected) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div
          className="rounded-xl border px-3.5 py-6 text-center text-xs"
          style={{
            backgroundColor: theme.bgBase,
            borderColor: theme.border,
            color: theme.textMuted,
          }}
        >
          <Network className="mx-auto mb-2 h-4 w-4 opacity-60" />
          <div className="font-medium" style={{ color: theme.textPrimary }}>
            No active SSH session
          </div>
          <p className="mt-1 text-[11px] leading-relaxed">
            Connect to a host to create local port forwards (-L) over the active SSH tunnel.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-0.5">
      {/* New Local Forward (-L) form */}
      <form
        onSubmit={handleSubmit}
        className="space-y-2.5 rounded-xl border p-3"
        style={{
          backgroundColor: theme.bgBase,
          borderColor: theme.border,
        }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium" style={{ color: theme.textPrimary }}>
            New Local Forward (-L)
          </span>
          <span className="truncate text-[10px]" style={{ color: theme.textMuted }}>
            {session.title}
          </span>
        </div>

        {/* Quick presets */}
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                setLocalPort(String(preset.localPort));
                setRemoteHost(preset.remoteHost);
                setRemotePort(String(preset.remotePort));
              }}
              className="vela-focus rounded-md border px-2 py-0.5 text-[10px] tabular-nums transition-colors hover:bg-white/5"
              style={{
                backgroundColor: theme.bgSurface,
                borderColor: theme.border,
                color: theme.textMuted,
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Local bind */}
        <div className="space-y-1">
          <div className="text-[10px]" style={{ color: theme.textMuted }}>
            Local bind
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="flex h-7 items-center rounded-lg border px-2 font-mono text-[11px] tabular-nums"
              style={{
                backgroundColor: theme.bgSurface,
                borderColor: theme.border,
                color: theme.textMuted,
              }}
            >
              127.0.0.1
            </div>
            <span className="text-xs" style={{ color: theme.textMuted }}>
              :
            </span>
            <input
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="8080"
              inputMode="numeric"
              className="h-7 min-w-0 flex-1 rounded-lg border px-2 font-mono text-xs tabular-nums outline-none"
              style={inputStyle}
            />
          </div>
        </div>

        {/* Remote destination */}
        <div className="space-y-1">
          <div className="text-[10px]" style={{ color: theme.textMuted }}>
            Remote destination
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              placeholder="127.0.0.1"
              className="h-7 min-w-0 flex-1 rounded-lg border px-2 font-mono text-[11px] outline-none"
              style={inputStyle}
            />
            <span className="text-xs" style={{ color: theme.textMuted }}>
              :
            </span>
            <input
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="8080"
              inputMode="numeric"
              className="h-7 w-16 rounded-lg border px-2 text-center font-mono text-xs tabular-nums outline-none"
              style={inputStyle}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={!canStart}
          className="vela-focus flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            backgroundColor: theme.textPrimary,
            color: theme.bgBase,
          }}
        >
          <Play className="h-3 w-3 fill-current" />
          Start Forward
        </button>
      </form>

      {/* Active Tunnels */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-0.5">
          <span
            className="text-[10px] font-medium uppercase tracking-wider"
            style={{ color: theme.textMuted }}
          >
            Active Tunnels
          </span>
          <span
            className="rounded border px-1.5 py-0.5 text-[10px] tabular-nums"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textMuted,
            }}
          >
            {session.tunnels.length}
          </span>
        </div>

        {session.tunnels.length === 0 ? (
          <div
            className="rounded-xl border px-3 py-4 text-center text-[11px]"
            style={{
              backgroundColor: theme.bgBase,
              borderColor: theme.border,
              color: theme.textMuted,
            }}
          >
            No active port forwards on this session.
          </div>
        ) : (
          session.tunnels.map((t) => {
            const localAddr = `localhost:${t.local_port}`;
            const isCopied = copiedId === t.id;
            return (
              <div
                key={t.id}
                className="rounded-xl border p-2.5"
                style={{
                  backgroundColor: theme.bgElevated,
                  borderColor: theme.border,
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: theme.success }}
                    title="Listening"
                  />
                  <div
                    className="flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-[11px] tabular-nums"
                    style={{ color: theme.textPrimary }}
                    title={`${localAddr} → ${t.remote_host}:${t.remote_port}`}
                  >
                    <span className="truncate">{localAddr}</span>
                    <ArrowRight
                      className="h-3 w-3 shrink-0"
                      style={{ color: theme.textMuted }}
                    />
                    <span className="truncate" style={{ color: theme.textMuted }}>
                      {t.remote_host}:{t.remote_port}
                    </span>
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <span
                    className="rounded border px-1.5 py-0.5 text-[10px] tabular-nums"
                    style={{
                      backgroundColor: theme.bgBase,
                      borderColor: theme.border,
                      color: t.active_connections > 0 ? theme.success : theme.textMuted,
                    }}
                  >
                    {t.active_connections}{" "}
                    {t.active_connections === 1 ? "conn" : "conns"}
                  </span>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleCopy(t.id, localAddr)}
                      title={`Copy ${localAddr}`}
                      className="vela-focus flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-white/5"
                      style={{
                        borderColor: theme.border,
                        color: isCopied ? theme.success : theme.textPrimary,
                      }}
                    >
                      {isCopied ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {isCopied ? "Copied" : "Copy"}
                    </button>

                    <button
                      type="button"
                      onClick={() => onStopTunnel(t.id)}
                      title="Stop tunnel"
                      className="vela-focus flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-white/5"
                      style={{
                        borderColor: theme.border,
                        color: theme.danger,
                      }}
                    >
                      <Square className="h-2.5 w-2.5 fill-current" />
                      Stop
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
