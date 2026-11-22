use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Config, Handle, Handler};
use russh::keys::{
    HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key,
};
use russh::{ChannelMsg, Pty};
use russh_sftp::client::SftpSession;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};
use vela_core::{HostKeyStatus, KnownHostsStore, VelaError, VelaResult};

use crate::sftp::{
    RemoteEntry, chmod_remote, create_empty_file, create_remote_dir, delete_remote, download_file,
    list_remote_dir, parent_remote_path, rename_remote, resolve_canonical_path, upload_file,
};
use crate::telemetry::{ServerStats, TelemetryState, poll_server_stats};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u32,
    pub rows: u32,
}

impl Default for PtySize {
    fn default() -> Self {
        Self { cols: 120, rows: 36 }
    }
}

#[derive(Debug, Clone)]
pub enum AuthCredentials {
    Password(String),
    PrivateKey {
        path: PathBuf,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credentials: AuthCredentials,
    pub initial_pty: PtySize,
    pub keepalive_secs: u64,
    pub initial_remote_path: Option<String>,
}

#[derive(Debug)]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub status: HostKeyStatus,
    pub responder: oneshot::Sender<bool>,
}

#[derive(Debug)]
pub enum SessionCommand {
    SendBytes(Vec<u8>),
    Resize(PtySize),
    SftpListDir(String),
    SftpDownload {
        remote_path: String,
        local_path: PathBuf,
    },
    SftpUpload {
        local_path: PathBuf,
        remote_path: String,
    },
    SftpMkdir {
        path: String,
    },
    SftpCreateFile {
        path: String,
    },
    SftpRename {
        old_path: String,
        new_path: String,
    },
    SftpDelete {
        path: String,
        is_dir: bool,
    },
    SftpChmod {
        path: String,
        mode: u32,
    },
    SftpEditLocally {
        remote_path: String,
    },
    SetMonitoring(bool),
    Disconnect,
}

#[derive(Debug)]
pub enum SessionEvent {
    HostKeyVerification(HostKeyPrompt),
    Connected {
        initial_dir: String,
    },
    PtyOutput(Vec<u8>),
    SftpDirListing {
        path: String,
        entries: Vec<RemoteEntry>,
    },
    Stats(ServerStats),
    Notice(String),
    Error(VelaError),
    Disconnected(String),
}

pub struct SshSessionHandle {
    pub cmd_tx: mpsc::Sender<SessionCommand>,
}

impl SshSessionHandle {
    pub async fn send_bytes(&self, bytes: Vec<u8>) {
        let _ = self.cmd_tx.send(SessionCommand::SendBytes(bytes)).await;
    }

    pub async fn resize(&self, size: PtySize) {
        let _ = self.cmd_tx.send(SessionCommand::Resize(size)).await;
    }

    pub async fn list_dir(&self, path: String) {
        let _ = self.cmd_tx.send(SessionCommand::SftpListDir(path)).await;
    }

    pub async fn disconnect(&self) {
        let _ = self.cmd_tx.send(SessionCommand::Disconnect).await;
    }
}

struct VelaClientHandler {
    host: String,
    port: u16,
    known_hosts: KnownHostsStore,
    event_tx: mpsc::Sender<SessionEvent>,
}

impl Handler for VelaClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let status = match self.known_hosts.verify(&self.host, self.port, &fingerprint) {
            Ok(s) => s,
            Err(err) => {
                warn!("known_hosts read error: {err}");
                HostKeyStatus::Unknown {
                    fingerprint: fingerprint.clone(),
                }
            }
        };

        if matches!(status, HostKeyStatus::Trusted) {
            return Ok(true);
        }

        let (tx, rx) = oneshot::channel();
        let prompt = HostKeyPrompt {
            host: self.host.clone(),
            port: self.port,
            status: status.clone(),
            responder: tx,
        };

        if self
            .event_tx
            .send(SessionEvent::HostKeyVerification(prompt))
            .await
            .is_err()
        {
            return Ok(false);
        }

        let accepted = rx.await.unwrap_or(false);
        if accepted {
            if let Err(err) = self.known_hosts.trust(&self.host, self.port, &fingerprint) {
                warn!("failed to persist trusted host key: {err}");
            }
        } else if let HostKeyStatus::Mismatch { expected, actual } = status {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(VelaError::HostKeyMismatch {
                    host: self.host.clone(),
                    port: self.port,
                    expected,
                    actual,
                }))
                .await;
        }
        Ok(accepted)
    }
}

/// Spawns an async SSH + PTY + SFTP session task, returning a command handle and event receiver.
pub fn connect_session(
    config: ConnectConfig,
    known_hosts: KnownHostsStore,
) -> (SshSessionHandle, mpsc::Receiver<SessionEvent>) {
    let (cmd_tx, cmd_rx) = mpsc::channel(256);
    let (event_tx, event_rx) = mpsc::channel(512);
    let self_cmd_tx = cmd_tx.clone();

    tokio::spawn(async move {
        if let Err(err) =
            run_session(config, known_hosts, self_cmd_tx, cmd_rx, event_tx.clone()).await
        {
            error!("SSH session ended with error: {err}");
            let _ = event_tx.send(SessionEvent::Error(err)).await;
        }
    });

    (SshSessionHandle { cmd_tx }, event_rx)
}

async fn authenticate(
    handle: &mut Handle<VelaClientHandler>,
    cfg: &ConnectConfig,
) -> VelaResult<()> {
    let auth_res = match &cfg.credentials {
        AuthCredentials::Password(password) => handle
            .authenticate_password(&cfg.username, password)
            .await
            .map_err(|err| VelaError::AuthFailed {
                user: cfg.username.clone(),
                host: cfg.host.clone(),
                reason: err.to_string(),
            })?,
        AuthCredentials::PrivateKey { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_deref()).map_err(|err| {
                VelaError::AuthFailed {
                    user: cfg.username.clone(),
                    host: cfg.host.clone(),
                    reason: format!("failed to load private key '{}': {err}", path.display()),
                }
            })?;
            let best_hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|err| VelaError::AuthFailed {
                    user: cfg.username.clone(),
                    host: cfg.host.clone(),
                    reason: err.to_string(),
                })?
                .flatten();
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), best_hash);
            handle
                .authenticate_publickey(&cfg.username, key_with_alg)
                .await
                .map_err(|err| VelaError::AuthFailed {
                    user: cfg.username.clone(),
                    host: cfg.host.clone(),
                    reason: err.to_string(),
                })?
        }
    };

    if !auth_res.success() {
        return Err(VelaError::AuthFailed {
            user: cfg.username.clone(),
            host: cfg.host.clone(),
            reason: "server rejected credentials".to_string(),
        });
    }
    Ok(())
}

async fn run_session(
    cfg: ConnectConfig,
    known_hosts: KnownHostsStore,
    self_cmd_tx: mpsc::Sender<SessionCommand>,
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    event_tx: mpsc::Sender<SessionEvent>,
) -> VelaResult<()> {
    let keepalive = if cfg.keepalive_secs > 0 {
        Some(Duration::from_secs(cfg.keepalive_secs))
    } else {
        None
    };

    let client_cfg = Arc::new(Config {
        keepalive_interval: keepalive,
        keepalive_max: 3,
        ..Config::default()
    });

    let handler = VelaClientHandler {
        host: cfg.host.clone(),
        port: cfg.port,
        known_hosts,
        event_tx: event_tx.clone(),
    };

    info!("Connecting to {}:{}", cfg.host, cfg.port);
    let mut handle = client::connect(client_cfg, (cfg.host.as_str(), cfg.port), handler)
        .await
        .map_err(|err| VelaError::ConnectionFailed {
            host: cfg.host.clone(),
            port: cfg.port,
            reason: err.to_string(),
        })?;

    authenticate(&mut handle, &cfg).await?;

    // Open interactive PTY channel.
    let mut pty_channel =
        handle
            .channel_open_session()
            .await
            .map_err(|err| VelaError::ConnectionFailed {
                host: cfg.host.clone(),
                port: cfg.port,
                reason: format!("failed to open PTY channel: {err}"),
            })?;

    pty_channel
        .request_pty(
            false,
            "xterm-256color",
            cfg.initial_pty.cols,
            cfg.initial_pty.rows,
            0,
            0,
            &[(Pty::ECHO, 1)],
        )
        .await
        .map_err(|err| VelaError::ConnectionFailed {
            host: cfg.host.clone(),
            port: cfg.port,
            reason: format!("failed to request PTY: {err}"),
        })?;

    pty_channel
        .request_shell(false)
        .await
        .map_err(|err| VelaError::ConnectionFailed {
            host: cfg.host.clone(),
            port: cfg.port,
            reason: format!("failed to start shell: {err}"),
        })?;

    // Open multiplexed SFTP subsystem channel on the same SSH connection.
    let sftp_session = match open_sftp_channel(&handle).await {
        Ok(sftp) => Some(sftp),
        Err(err) => {
            warn!("SFTP subsystem unavailable: {err}");
            None
        }
    };

    let initial_dir = if let Some(sftp) = &sftp_session {
        let requested = cfg.initial_remote_path.as_deref().unwrap_or(".");
        resolve_canonical_path(sftp, requested)
            .await
            .unwrap_or_else(|_| "/".to_string())
    } else {
        "/".to_string()
    };

    let _ = event_tx
        .send(SessionEvent::Connected {
            initial_dir: initial_dir.clone(),
        })
        .await;

    if let Some(sftp) = &sftp_session {
        match list_remote_dir(sftp, &initial_dir).await {
            Ok(entries) => {
                let _ = event_tx
                    .send(SessionEvent::SftpDirListing {
                        path: initial_dir.clone(),
                        entries,
                    })
                    .await;
            }
            Err(err) => {
                let _ = event_tx.send(SessionEvent::Error(err)).await;
            }
        }
    }

    let mut monitoring_enabled = true;
    let mut telemetry_state = TelemetryState::default();
    let mut stats_interval = tokio::time::interval(Duration::from_secs(2));
    stats_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = stats_interval.tick(), if monitoring_enabled => {
                if let Some(stats) = poll_server_stats(&handle, &mut telemetry_state).await {
                    let _ = event_tx.send(SessionEvent::Stats(stats)).await;
                }
            }
            maybe_cmd = cmd_rx.recv() => {
                let Some(cmd) = maybe_cmd else {
                    debug!("command channel closed; terminating session");
                    break;
                };
                match cmd {
                    SessionCommand::SendBytes(data) => {
                        if let Err(err) = pty_channel.data(&data[..]).await {
                            warn!("PTY write error: {err}");
                            break;
                        }
                    }
                    SessionCommand::Resize(size) => {
                        if let Err(err) = pty_channel.window_change(size.cols, size.rows, 0, 0).await {
                            warn!("PTY resize error: {err}");
                        }
                    }
                    SessionCommand::SftpListDir(path) => {
                        if let Some(sftp) = &sftp_session {
                            refresh_dir(sftp, &path, &event_tx).await;
                        } else {
                            let _ = event_tx
                                .send(SessionEvent::Error(VelaError::Sftp {
                                    path,
                                    reason: "SFTP subsystem is not active on this server".into(),
                                }))
                                .await;
                        }
                    }
                    SessionCommand::SftpDownload {
                        remote_path,
                        local_path,
                    } => {
                        if let Some(sftp) = &sftp_session {
                            match download_file(sftp, &remote_path, &local_path).await {
                                Ok(bytes) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Notice(format!(
                                            "Downloaded {} ({bytes} B)",
                                            remote_path
                                        )))
                                        .await;
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::SftpUpload {
                        local_path,
                        remote_path,
                    } => {
                        if let Some(sftp) = &sftp_session {
                            match upload_file(sftp, &local_path, &remote_path).await {
                                Ok(bytes) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Notice(format!(
                                            "Uploaded {} ({bytes} B)",
                                            remote_path
                                        )))
                                        .await;
                                    let parent = parent_remote_path(&remote_path);
                                    refresh_dir(sftp, &parent, &event_tx).await;
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::SftpMkdir { path } => {
                        if let Some(sftp) = &sftp_session {
                            match create_remote_dir(sftp, &path).await {
                                Ok(()) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Notice(format!("Created {path}")))
                                        .await;
                                    let parent = parent_remote_path(&path);
                                    refresh_dir(sftp, &parent, &event_tx).await;
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::SftpCreateFile { path } => {
                        if let Some(sftp) = &sftp_session {
                            match create_empty_file(sftp, &path).await {
                                Ok(()) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Notice(format!("Created file {path}")))
                                        .await;
                                    let parent = parent_remote_path(&path);
                                    refresh_dir(sftp, &parent, &event_tx).await;
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::SetMonitoring(enabled) => {
                        monitoring_enabled = enabled;
                    }
                    SessionCommand::SftpRename { old_path, new_path } => {
                        if let Some(sftp) = &sftp_session {
                            match rename_remote(sftp, &old_path, &new_path).await {
                                Ok(()) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Notice(format!("Renamed to {new_path}")))
                                        .await;
                                    let parent = parent_remote_path(&new_path);
                                    refresh_dir(sftp, &parent, &event_tx).await;
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::SftpDelete { path, is_dir } => {
                        if let Some(sftp) = &sftp_session {
                            match delete_remote(sftp, &path, is_dir).await {
                                Ok(()) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Notice(format!("Deleted {path}")))
                                        .await;
                                    let parent = parent_remote_path(&path);
                                    refresh_dir(sftp, &parent, &event_tx).await;
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::SftpChmod { path, mode } => {
                        if let Some(sftp) = &sftp_session {
                            match chmod_remote(sftp, &path, mode).await {
                                Ok(()) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Notice(format!(
                                            "Updated permissions on {path} to {:04o}",
                                            mode & 0o7777
                                        )))
                                        .await;
                                    let parent = parent_remote_path(&path);
                                    refresh_dir(sftp, &parent, &event_tx).await;
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::SftpEditLocally { remote_path } => {
                        if let Some(sftp) = &sftp_session {
                            let file_name = remote_path
                                .rsplit('/')
                                .next()
                                .filter(|s| !s.is_empty())
                                .unwrap_or("remote_file");
                            let temp_dir = std::env::temp_dir()
                                .join("vela-edits")
                                .join(uuid::Uuid::new_v4().to_string());
                            let local_path = temp_dir.join(file_name);

                            match download_file(sftp, &remote_path, &local_path).await {
                                Ok(_) => {
                                    if let Err(err) = open::that(&local_path) {
                                        let _ = event_tx
                                            .send(SessionEvent::Error(VelaError::Sftp {
                                                path: remote_path,
                                                reason: format!("failed to open editor: {err}"),
                                            }))
                                            .await;
                                    } else {
                                        let _ = event_tx
                                            .send(SessionEvent::Notice(format!(
                                                "Editing {file_name} locally (auto-uploads on save)"
                                            )))
                                            .await;
                                        spawn_edit_watcher(
                                            local_path,
                                            remote_path,
                                            self_cmd_tx.clone(),
                                        );
                                    }
                                }
                                Err(err) => {
                                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                                }
                            }
                        }
                    }
                    SessionCommand::Disconnect => {
                        let _ = pty_channel.eof().await;
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "user disconnected", "en")
                            .await;
                        let _ = event_tx
                            .send(SessionEvent::Disconnected("Disconnected".into()))
                            .await;
                        return Ok(());
                    }
                }
            }
            maybe_msg = pty_channel.wait() => {
                match maybe_msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if event_tx.send(SessionEvent::PtyOutput(data.to_vec())).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                        let _ = event_tx
                            .send(SessionEvent::Disconnected("Remote host closed the shell".into()))
                            .await;
                        break;
                    }
                    Some(_) => {}
                }
            }
        }
    }

    Ok(())
}

async fn refresh_dir(
    sftp: &SftpSession,
    path: &str,
    event_tx: &mpsc::Sender<SessionEvent>,
) {
    let canonical = resolve_canonical_path(sftp, path)
        .await
        .unwrap_or_else(|_| path.to_string());
    match list_remote_dir(sftp, &canonical).await {
        Ok(entries) => {
            let _ = event_tx
                .send(SessionEvent::SftpDirListing {
                    path: canonical,
                    entries,
                })
                .await;
        }
        Err(err) => {
            let _ = event_tx.send(SessionEvent::Error(err)).await;
        }
    }
}

fn spawn_edit_watcher(
    local_path: PathBuf,
    remote_path: String,
    cmd_tx: mpsc::Sender<SessionCommand>,
) {
    tokio::spawn(async move {
        use notify::{RecursiveMode, Watcher};

        let (tx, mut rx) = mpsc::channel::<()>(16);
        let Ok(mut watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res
                && matches!(
                    event.kind,
                    notify::EventKind::Modify(_) | notify::EventKind::Create(_)
                )
            {
                let _ = tx.try_send(());
            }
        }) else {
            return;
        };

        let Some(parent) = local_path.parent() else {
            return;
        };
        if watcher.watch(parent, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        // Debounce file saves by 300ms and upload back while session is alive.
        while rx.recv().await.is_some() {
            tokio::time::sleep(Duration::from_millis(300)).await;
            while rx.try_recv().is_ok() {}
            if cmd_tx
                .send(SessionCommand::SftpUpload {
                    local_path: local_path.clone(),
                    remote_path: remote_path.clone(),
                })
                .await
                .is_err()
            {
                break;
            }
        }
    });
}

async fn open_sftp_channel(handle: &Handle<VelaClientHandler>) -> VelaResult<SftpSession> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|err| VelaError::Sftp {
            path: "/".into(),
            reason: format!("failed to open SFTP channel: {err}"),
        })?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|err| VelaError::Sftp {
            path: "/".into(),
            reason: format!("failed to request sftp subsystem: {err}"),
        })?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|err| VelaError::Sftp {
            path: "/".into(),
            reason: format!("SFTP handshake failed: {err}"),
        })
}
