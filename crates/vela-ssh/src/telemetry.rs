use std::time::{Duration, Instant};

use russh::ChannelMsg;
use russh::client::{Handle, Handler};
use serde::Serialize;

const MAX_STATS_BYTES: usize = 16 * 1024;
const STATS_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiskUsage {
    pub mount: String,
    pub used_pct: u8,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ServerStats {
    pub hostname: String,
    pub cpu_percent: f32,
    pub mem_used_gb: f32,
    pub mem_total_gb: f32,
    pub net_tx_mbps: f32,
    pub net_rx_mbps: f32,
    pub uptime_text: String,
    pub users_count: u32,
    pub disks: Vec<DiskUsage>,
}

#[derive(Debug, Default)]
pub struct TelemetryState {
    prev_cpu: Option<(u64, u64)>,
    prev_net: Option<(u64, u64, Instant)>,
}

/// Collects accurate Linux/Unix telemetry (CPU jiffies, RAM with MemFree fallback, net RX/TX bytes,
/// uptime, users, mounts including spaces) over a single lightweight exec channel.
const STATS_CMD: &str = r#"sh -c '
h=$(hostname 2>/dev/null || echo host)
cpu=$(awk "NR==1{idle=\$5+\$6; tot=0; for(i=2;i<=NF;i++) tot+=\$i; printf \"%s %s\", idle, tot}" /proc/stat 2>/dev/null || echo "0 0")
mem=$(awk "/MemTotal/{t=\$2} /MemAvailable/{a=\$2; has_a=1} /MemFree/{f=\$2} /Buffers/{b=\$2} /^Cached:/{c=\$2} END{avail=has_a?a:(f+b+c); if(t>0) printf \"%.2f %.2f\", (t-avail)/1048576, t/1048576; else print \"0 0\"}" /proc/meminfo 2>/dev/null || echo "0 0")
net=$(awk "NR>2 && \$1 !~ /^lo:/{rx+=\$2; tx+=\$10} END{printf \"%s %s\", rx+0, tx+0}" /proc/net/dev 2>/dev/null || echo "0 0")
up=$(awk "{print int(\$1)}" /proc/uptime 2>/dev/null || echo 0)
usr=$(who 2>/dev/null | wc -l | tr -d " " || echo 1)
dsk=$(df -P 2>/dev/null | awk "NR>1 && \$1 ~ /^\/dev\// {pct=\$5; gsub(/%/,\"\",pct); m=\$6; for(i=7;i<=NF;i++) m=m\" \"\$i; printf \"%s=%s;\", m, pct}")
printf "%s|%s|%s|%s|%s|%s|%s\n" "$h" "$cpu" "$mem" "$net" "$up" "$usr" "$dsk"
'"#;

pub async fn poll_server_stats<H: Handler>(
    handle: &Handle<H>,
    state: &mut TelemetryState,
) -> Option<ServerStats> {
    let raw = tokio::time::timeout(STATS_TIMEOUT, async {
        let mut channel = handle.channel_open_session().await.ok()?;
        channel.exec(true, STATS_CMD).await.ok()?;

        let mut buf = Vec::with_capacity(512);
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    let remaining = MAX_STATS_BYTES.saturating_sub(buf.len());
                    if remaining == 0 {
                        break;
                    }
                    let take = data.len().min(remaining);
                    buf.extend_from_slice(&data[..take]);
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Some(buf)
    })
    .await
    .ok()??;

    let line = String::from_utf8_lossy(&raw);
    parse_stats_line(line.trim(), state, Instant::now())
}

pub fn parse_stats_line(
    line: &str,
    state: &mut TelemetryState,
    now: Instant,
) -> Option<ServerStats> {
    let parts: Vec<&str> = line.split('|').collect();
    if parts.len() < 7 {
        return None;
    }

    let hostname = parts[0].trim().to_string();

    // CPU delta from /proc/stat (idle, total)
    let mut cpu_it = parts[1].split_whitespace();
    let idle: u64 = cpu_it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let total: u64 = cpu_it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let cpu_percent = if let Some((prev_idle, prev_total)) = state.prev_cpu {
        let d_tot = total.saturating_sub(prev_total);
        let d_idle = idle.saturating_sub(prev_idle);
        if d_tot > 0 {
            (((d_tot.saturating_sub(d_idle)) as f32 / d_tot as f32) * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        }
    } else {
        0.0
    };
    if total > 0 {
        state.prev_cpu = Some((idle, total));
    }

    // Memory (used GB, total GB)
    let mut mem_it = parts[2].split_whitespace();
    let mem_used_gb: f32 = mem_it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let mem_total_gb: f32 = mem_it.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);

    // Network RX / TX bytes -> Mb/s
    let mut net_it = parts[3].split_whitespace();
    let rx_bytes: u64 = net_it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let tx_bytes: u64 = net_it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let (net_rx_mbps, net_tx_mbps) = if let Some((prev_rx, prev_tx, prev_at)) = state.prev_net {
        let dt = now.duration_since(prev_at).as_secs_f32().max(0.1);
        let d_rx = rx_bytes.saturating_sub(prev_rx) as f32;
        let d_tx = tx_bytes.saturating_sub(prev_tx) as f32;
        (
            (d_rx * 8.0) / (dt * 1_000_000.0),
            (d_tx * 8.0) / (dt * 1_000_000.0),
        )
    } else {
        (0.0, 0.0)
    };
    state.prev_net = Some((rx_bytes, tx_bytes, now));

    let uptime_secs: u64 = parts[4].trim().parse().unwrap_or(0);
    let users_count: u32 = parts[5].trim().parse().unwrap_or(1);

    let mut disks = Vec::new();
    for item in parts[6].split(';') {
        if let Some((mount, pct_str)) = item.rsplit_once('=') {
            let mount = mount.trim();
            if mount.is_empty() || mount.starts_with("/snap") {
                continue;
            }
            let used_pct = pct_str.trim().parse::<u8>().unwrap_or(0).min(100);
            disks.push(DiskUsage {
                mount: mount.to_string(),
                used_pct,
            });
        }
    }
    disks.truncate(4);

    Some(ServerStats {
        hostname,
        cpu_percent,
        mem_used_gb,
        mem_total_gb,
        net_tx_mbps,
        net_rx_mbps,
        uptime_text: format_uptime(uptime_secs),
        users_count,
        disks,
    })
}

fn format_uptime(secs: u64) -> String {
    let days = secs / 86_400;
    let hours = (secs % 86_400) / 3_600;
    let mins = (secs % 3_600) / 60;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {mins}m")
    } else {
        format!("{mins}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_cpu_and_net_deltas_and_parses_disks_with_spaces() {
        let mut st = TelemetryState::default();
        let t0 = Instant::now();
        let _ = parse_stats_line(
            "ubuntu|900 1000|4.11 14.78|1000000 500000|36000|2|/=4;/mnt/My Drive=12;",
            &mut st,
            t0,
        );
        let t1 = t0 + Duration::from_secs(2);
        let s = parse_stats_line(
            "ubuntu|980 1100|4.12 14.78|1250000 750000|36002|2|/=4;/mnt/My Drive=12;",
            &mut st,
            t1,
        );
        assert!(s.is_some());
        if let Some(stats) = s {
            assert_eq!(stats.hostname, "ubuntu");
            assert!((stats.cpu_percent - 20.0).abs() < 0.1);
            assert!((stats.net_rx_mbps - 1.0).abs() < 0.05);
            assert!((stats.net_tx_mbps - 1.0).abs() < 0.05);
            assert_eq!(stats.users_count, 2);
            assert_eq!(stats.disks.len(), 2);
            assert_eq!(stats.disks[1].mount, "/mnt/My Drive");
            assert_eq!(stats.disks[1].used_pct, 12);
        }
    }
}
