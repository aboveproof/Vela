use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use russh::client::{Handle, Handler};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};
use vela_core::VelaError;

use crate::session::SessionEvent;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TunnelInfo {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub active_connections: u32,
}

#[derive(Debug, Clone)]
pub struct LocalTunnelSpec {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

struct ActiveTunnel {
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    active_connections: Arc<AtomicU32>,
    stop_tx: watch::Sender<bool>,
}

#[derive(Clone, Default)]
pub struct TunnelManager {
    inner: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> Vec<TunnelInfo> {
        let mut list: Vec<TunnelInfo> = match self.inner.lock() {
            Ok(guard) => guard
                .values()
                .map(|t| TunnelInfo {
                    id: t.id.clone(),
                    local_port: t.local_port,
                    remote_host: t.remote_host.clone(),
                    remote_port: t.remote_port,
                    active_connections: t.active_connections.load(Ordering::Relaxed),
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        list.sort_by(|a, b| {
            a.local_port
                .cmp(&b.local_port)
                .then_with(|| a.id.cmp(&b.id))
        });
        list
    }

    pub async fn start_local_tunnel<H: Handler + 'static>(
        &self,
        handle: Arc<Handle<H>>,
        event_tx: mpsc::Sender<SessionEvent>,
        session_cancel: watch::Receiver<bool>,
        spec: LocalTunnelSpec,
    ) {
        let LocalTunnelSpec {
            id,
            local_port,
            remote_host,
            remote_port,
        } = spec;
        let remote_host = remote_host.trim().to_string();
        if local_port == 0 || remote_port == 0 || remote_host.is_empty() {
            let _ = event_tx
                .send(SessionEvent::Error(VelaError::Config(
                    "Tunnel requires valid local port, remote host, and remote port".into(),
                )))
                .await;
            return;
        }

        let listener = match TcpListener::bind(("127.0.0.1", local_port)).await {
            Ok(l) => l,
            Err(err) => {
                let _ = event_tx
                    .send(SessionEvent::Error(VelaError::ConnectionFailed {
                        host: "127.0.0.1".into(),
                        port: local_port,
                        reason: format!("failed to bind local tunnel port: {err}"),
                    }))
                    .await;
                return;
            }
        };

        let (stop_tx, mut stop_rx) = watch::channel(false);
        let active_connections = Arc::new(AtomicU32::new(0));
        {
            if let Ok(mut guard) = self.inner.lock() {
                guard.insert(
                    id.clone(),
                    ActiveTunnel {
                        id: id.clone(),
                        local_port,
                        remote_host: remote_host.clone(),
                        remote_port,
                        active_connections: Arc::clone(&active_connections),
                        stop_tx,
                    },
                );
            }
        }

        info!("Started local SSH tunnel 127.0.0.1:{local_port} -> {remote_host}:{remote_port}");
        let _ = event_tx
            .send(SessionEvent::TunnelsUpdated(self.snapshot()))
            .await;
        let _ = event_tx
            .send(SessionEvent::Notice(format!(
                "Tunnel active: 127.0.0.1:{local_port} -> {remote_host}:{remote_port}"
            )))
            .await;

        let manager = self.clone();
        let mut session_cancel_loop = session_cancel.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop_rx.changed() => {
                        debug!("Local tunnel {id} stopped by user");
                        break;
                    }
                    _ = session_cancel_loop.changed() => {
                        debug!("Local tunnel {id} stopped on session disconnect");
                        break;
                    }
                    accepted = listener.accept() => {
                        let (mut tcp_stream, peer_addr) = match accepted {
                            Ok(pair) => pair,
                            Err(err) => {
                                warn!("Local tunnel {id} accept error: {err}");
                                break;
                            }
                        };

                        let handle_conn = Arc::clone(&handle);
                        let remote_host_conn = remote_host.clone();
                        let active_conn = Arc::clone(&active_connections);
                        let manager_conn = manager.clone();
                        let event_tx_conn = event_tx.clone();
                        let mut stop_conn = stop_rx.clone();
                        let mut cancel_conn = session_cancel.clone();
                        let peer_port = u32::from(peer_addr.port());

                        active_conn.fetch_add(1, Ordering::Relaxed);
                        let _ = event_tx_conn
                            .send(SessionEvent::TunnelsUpdated(manager_conn.snapshot()))
                            .await;

                        tokio::spawn(async move {
                            match handle_conn
                                .channel_open_direct_tcpip(
                                    &remote_host_conn,
                                    u32::from(remote_port),
                                    "127.0.0.1",
                                    peer_port,
                                )
                                .await
                            {
                                Ok(channel) => {
                                    let mut ssh_stream = channel.into_stream();
                                    tokio::select! {
                                        _ = stop_conn.changed() => {}
                                        _ = cancel_conn.changed() => {}
                                        res = tokio::io::copy_bidirectional(&mut tcp_stream, &mut ssh_stream) => {
                                            if let Err(err) = res {
                                                debug!("Tunnel stream closed: {err}");
                                            }
                                        }
                                    }
                                }
                                Err(err) => {
                                    warn!("Failed to open direct-tcpip channel to {remote_host_conn}:{remote_port}: {err}");
                                }
                            }
                            active_conn.fetch_sub(1, Ordering::Relaxed);
                            let _ = event_tx_conn
                                .send(SessionEvent::TunnelsUpdated(manager_conn.snapshot()))
                                .await;
                        });
                    }
                }
            }

            if let Ok(mut guard) = manager.inner.lock() {
                guard.remove(&id);
            }
            let _ = event_tx
                .send(SessionEvent::TunnelsUpdated(manager.snapshot()))
                .await;
        });
    }

    pub async fn stop_local_tunnel(&self, id: &str, event_tx: &mpsc::Sender<SessionEvent>) {
        let removed = if let Ok(mut guard) = self.inner.lock() {
            guard.remove(id)
        } else {
            None
        };
        if let Some(tunnel) = removed {
            let _ = tunnel.stop_tx.send(true);
            let _ = event_tx
                .send(SessionEvent::TunnelsUpdated(self.snapshot()))
                .await;
            let _ = event_tx
                .send(SessionEvent::Notice(format!(
                    "Stopped tunnel 127.0.0.1:{}",
                    tunnel.local_port
                )))
                .await;
        }
    }
}
