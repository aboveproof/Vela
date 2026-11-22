import { Activity, ArrowDown, ArrowUp, Clock, Cpu, HardDrive, Server, User } from "lucide-react";
import type { ServerStats, ThemeTokens } from "../types";

interface MonitorStripProps {
  stats: ServerStats | null;
  cpuHistory: number[];
  theme: ThemeTokens;
}

function CpuSparkline({ samples, color }: { samples: number[]; color: string }) {
  const w = 48;
  const h = 16;
  if (samples.length < 2) {
    return <div className="h-4 w-12 rounded bg-white/5" />;
  }
  const step = w / (samples.length - 1);
  const pts = samples
    .map((v, i) => {
      const x = i * step;
      const y = h - (Math.min(100, Math.max(0, v)) / 100) * (h - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;

  return (
    <svg width={w} height={h} className="overflow-visible">
      <polygon points={area} fill={color} fillOpacity={0.18} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

export function MonitorStrip({ stats, cpuHistory, theme }: MonitorStripProps) {
  if (!stats) {
    return (
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-t px-3 text-[11px]"
        style={{
          backgroundColor: theme.bgSurface,
          borderColor: theme.border,
          color: theme.textMuted,
        }}
      >
        <Activity className="h-3 w-3" />
        <span>Collecting host telemetry...</span>
      </div>
    );
  }

  const memPct =
    stats.mem_total_gb > 0 ? Math.min(100, (stats.mem_used_gb / stats.mem_total_gb) * 100) : 0;
  const cpuColor =
    stats.cpu_percent > 80 ? theme.danger : stats.cpu_percent > 50 ? theme.warning : theme.success;
  const memColor = memPct > 85 ? theme.danger : theme.accent;

  const pillStyle = {
    backgroundColor: theme.bgElevated,
    borderColor: theme.border,
  };

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-t px-2.5 text-[11px]"
      style={{
        backgroundColor: theme.bgSurface,
        borderColor: theme.border,
        color: theme.textPrimary,
      }}
    >
      <div className="flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5" style={pillStyle}>
        <Server className="h-3 w-3" style={{ color: theme.warning }} />
        <span className="font-medium">{stats.hostname}</span>
      </div>

      <div className="flex shrink-0 items-center gap-2 rounded-md border px-2 py-0.5" style={pillStyle}>
        <Cpu className="h-3 w-3" style={{ color: cpuColor }} />
        <span className="w-7 text-right tabular-nums">{Math.round(stats.cpu_percent)}%</span>
        <CpuSparkline samples={cpuHistory} color={cpuColor} />
      </div>

      <div className="flex shrink-0 items-center gap-2 rounded-md border px-2 py-0.5" style={pillStyle}>
        <Activity className="h-3 w-3" style={{ color: memColor }} />
        <span className="tabular-nums">
          {stats.mem_used_gb.toFixed(2)} / {stats.mem_total_gb.toFixed(2)} GB
        </span>
        <div
          className="h-1.5 w-11 overflow-hidden rounded-full"
          style={{ backgroundColor: theme.bgBase }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${Math.max(3, memPct)}%`, backgroundColor: memColor }}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 rounded-md border px-2 py-0.5 tabular-nums" style={pillStyle}>
        <span className="flex items-center gap-1">
          <ArrowUp className="h-3 w-3" style={{ color: theme.success }} />
          {stats.net_tx_mbps.toFixed(2)} Mb/s
        </span>
        <span className="flex items-center gap-1">
          <ArrowDown className="h-3 w-3" style={{ color: theme.accent }} />
          {stats.net_rx_mbps.toFixed(2)} Mb/s
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2 rounded-md border px-2 py-0.5" style={pillStyle}>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" style={{ color: theme.textMuted }} />
          {stats.uptime_text}
        </span>
        <span className="flex items-center gap-1">
          <User className="h-3 w-3" style={{ color: theme.textMuted }} />
          {stats.users_count}
        </span>
      </div>

      {stats.disks.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 rounded-md border px-2 py-0.5" style={pillStyle}>
          <HardDrive className="h-3 w-3" style={{ color: theme.textMuted }} />
          {stats.disks.map((d) => (
            <span
              key={d.mount}
              className="tabular-nums"
              style={{ color: d.used_pct > 85 ? theme.danger : theme.textPrimary }}
            >
              {d.mount}: {d.used_pct}%
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
