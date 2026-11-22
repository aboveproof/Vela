use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Config, Handle, Handler};
use russh::keys::{
    HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key,
};
use russh::{ChannelMsg, Pty};
use russh_sftp::client::SftpSession;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::{debug, error, info, warn};
use vela_core::{HostKeyStatus, KnownHostsStore, VelaError, VelaResult};

use crate::keys::deploy_public_key_remote;
use crate::sftp::{
    DEFAULT_PREVIEW_MAX_BYTES, FilePreview, RemoteEntry, chmod_remote, create_empty_file,
    create_remote_dir, delete_remote, download_file, is_dangerous_executable_ext, is_remote_dir,
    list_remote_dir, parent_remote_path, read_file_preview, rename_remote, resolve_canonical_path,
    sanitize_local_filename, upload_path_recursive,
};
use crate::telemetry::{ServerStats, TelemetryState, poll_server_stats};
use crate::tunnels::{LocalTunnelSpec, TunnelInfo, TunnelManager};

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

#[derive(Clone)]
pub enum AuthCredentials {
    Password(String),
    PrivateKey {
        path: PathBuf,
        passphrase: Option<String>,
    },
}

impl fmt::Debug for AuthCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password(_) => f.write_str("Password([REDACTED])"),
            Self::PrivateKey { path, passphrase } => f
                .debug_struct("PrivateKey")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "[REDACTED]"))
                .finish(),
        }
    }
}

#[derive(Clone)]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credentials: AuthCredentials,
    pub initial_pty: PtySize,
    pub keepalive_secs: u64,
    pub initial_remote_path: Option<String>,
}

impl fmt::Debug for ConnectConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("credentials", &self.credentials)
            .field("initial_pty", &self.initial_pty)
            .field("keepalive_secs", &self.keepalive_secs)
            .field("initial_remote_path", &self.initial_remote_path)
            .finish()
    }
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
    SftpOpenEntry(String),
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
    },
    SftpChmod {
        path: String,
        mode: u32,
    },
    SftpEditLocally {
        remote_path: String,
    },
    SftpReadPreview {
        path: String,
    },
    DeployPublicKey(String),
    StartLocalTunnel {
        id: String,
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    },
    StopLocalTunnel {
        id: String,
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
    FilePreview(FilePreview),
    TunnelsUpdated(Vec<TunnelInfo>),
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
    host_key_error: Arc<Mutex<Option<VelaError>>>,
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

        // Fail closed if known_hosts cannot be read or host is invalid.
        let status = match self.known_hosts.verify(&self.host, self.port, &fingerprint) {
            Ok(s) => s,
            Err(err) => {
                error!("known_hosts verification failed closed: {err}");
                if let Ok(mut guard) = self.host_key_error.lock() {
                    *guard = Some(err);
                }
                return Ok(false);
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
        } else {
            let err = match status {
                HostKeyStatus::Mismatch { expected, actual } => VelaError::HostKeyMismatch {
                    host: self.host.clone(),
                    port: self.port,
                    expected,
                    actual,
                },
                _ => VelaError::HostKeyRejected {
                    host: self.host.clone(),
                    port: self.port,
                },
            };
            if let Ok(mut guard) = self.host_key_error.lock() {
                *guard = Some(err);
            }
        }
        Ok(accepted)
    }
}

/// Removes stale local edit directories from previous runs on startup.
pub fn cleanup_stale_edit_dirs() {
    if let Some(root) = edit_cache_root()
        && root.exists()
    {
        let _ = std::fs::remove_dir_all(&root);
    }
}

fn edit_cache_root() -> Option<PathBuf> {
    directories::ProjectDirs::from("dev", "vela", "Vela")
        .map(|p| p.cache_dir().join("edits"))
}

struct TempDirGuard {
    dir: PathBuf,
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Spawns an async SSH + PTY + SFTP session task, returning a command handle and event receiver.
pub fn connect_session(
    config: ConnectConfig,
    known_hosts: KnownHostsStore,
) -> (SshSessionHandle, mpsc::Receiver<SessionEvent>) {
    let (cmd_tx, cmd_rx) = mpsc::channel(512);
    let (event_tx, event_rx) = mpsc::channel(1024);

    tokio::spawn(async move {
        if let Err(err) = run_session(config, known_hosts, cmd_rx, event_tx.clone()).await {
            error!("SSH session ended with error: {err}");
            let _ = event_tx.send(SessionEvent::Error(err)).await;
        }
    });

    (SshSessionHandle { cmd_tx }, event_rx)
}

async fn authenticate(
    handle: &mut Handle<VelaClientHandler>,
    username: &str,
    host: &str,
    credentials: AuthCredentials,
) -> VelaResult<()> {
    let auth_res = match credentials {
        AuthCredentials::Password(password) => handle
            .authenticate_password(username, password)
            .await
            .map_err(|err| VelaError::AuthFailed {
                user: username.to_string(),
                host: host.to_string(),
                reason: err.to_string(),
            })?,
        AuthCredentials::PrivateKey { path, passphrase } => {
            let key = load_secret_key(&path, passphrase.as_deref()).map_err(|err| {
                VelaError::AuthFailed {
                    user: username.to_string(),
                    host: host.to_string(),
                    reason: format!("failed to load private key '{}': {err}", path.display()),
                }
            })?;
            let best_hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|err| VelaError::AuthFailed {
                    user: username.to_string(),
                    host: host.to_string(),
                    reason: err.to_string(),
                })?
                .flatten();
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), best_hash);
            handle
                .authenticate_publickey(username, key_with_alg)
                .await
                .map_err(|err| VelaError::AuthFailed {
                    user: username.to_string(),
                    host: host.to_string(),
                    reason: err.to_string(),
                })?
        }
    };

    if !auth_res.success() {
        return Err(VelaError::AuthFailed {
            user: username.to_string(),
            host: host.to_string(),
            reason: "server rejected credentials".to_string(),
        });
    }
    Ok(())
}

async fn run_session(
    cfg: ConnectConfig,
    known_hosts: KnownHostsStore,
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    event_tx: mpsc::Sender<SessionEvent>,
) -> VelaResult<()> {
    let ConnectConfig {
        host,
        port,
        username,
        credentials,
        initial_pty,
        keepalive_secs,
        initial_remote_path,
    } = cfg;

    let keepalive = if keepalive_secs > 0 {
        Some(Duration::from_secs(keepalive_secs))
    } else {
        None
    };

    let client_cfg = Arc::new(Config {
        keepalive_interval: keepalive,
        keepalive_max: 3,
        ..Config::default()
    });

    let host_key_error = Arc::new(Mutex::new(None));
    let handler = VelaClientHandler {
        host: host.clone(),
        port,
        known_hosts,
        event_tx: event_tx.clone(),
        host_key_error: Arc::clone(&host_key_error),
    };

    info!("Connecting to {host}:{port}");
    let mut handle = match client::connect(client_cfg, (host.as_str(), port), handler).await {
        Ok(h) => h,
        Err(err) => {
            // Return the exact host-key rejection/mismatch error once if that's why connect failed.
            if let Ok(mut guard) = host_key_error.lock()
                && let Some(hk_err) = guard.take()
            {
                return Err(hk_err);
            }
            return Err(VelaError::ConnectionFailed {
                host,
                port,
                reason: err.to_string(),
            });
        }
    };

    // Consume and drop plaintext credentials immediately after authentication completes.
    authenticate(&mut handle, &username, &host, credentials).await?;

    let mut pty_channel =
        handle
            .channel_open_session()
            .await
            .map_err(|err| VelaError::ConnectionFailed {
                host: host.clone(),
                port,
                reason: format!("failed to open PTY channel: {err}"),
            })?;

    pty_channel
        .request_pty(
            false,
            "xterm-256color",
            initial_pty.cols,
            initial_pty.rows,
            0,
            0,
            &[(Pty::ECHO, 1)],
        )
        .await
        .map_err(|err| VelaError::ConnectionFailed {
            host: host.clone(),
            port,
            reason: format!("failed to request PTY: {err}"),
        })?;

    pty_channel
        .request_shell(false)
        .await
        .map_err(|err| VelaError::ConnectionFailed {
            host: host.clone(),
            port,
            reason: format!("failed to start shell: {err}"),
        })?;

    let handle = Arc::new(handle);

    // Open multiplexed SFTP subsystem channel on the same SSH connection.
    let sftp_session = match open_sftp_channel(&handle).await {
        Ok(sftp) => Some(sftp),
        Err(err) => {
            warn!("SFTP subsystem unavailable: {err}");
            None
        }
    };

    let initial_dir = if let Some(sftp) = &sftp_session {
        let requested = initial_remote_path.as_deref().unwrap_or(".");
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

    // Cancellation signal shared by telemetry, SFTP worker, tunnels, and edit watchers.
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (mon_tx, mut mon_rx) = watch::channel(true);
    let tunnel_manager = TunnelManager::new();

    // Dedicated telemetry polling task (never blocks PTY or SFTP).
    {
        let handle_clone = Arc::clone(&handle);
        let event_tx_clone = event_tx.clone();
        let mut cancel = cancel_rx.clone();
        tokio::spawn(async move {
            let mut telemetry_state = TelemetryState::default();
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut consecutive_failures = 0u8;

            loop {
                let enabled = *mon_rx.borrow();
                tokio::select! {
                    _ = cancel.changed() => break,
                    res = mon_rx.changed() => {
                        if res.is_err() {
                            break;
                        }
                        consecutive_failures = 0;
                    }
                    _ = interval.tick(), if enabled && consecutive_failures < 5 => {
                        if let Some(stats) = poll_server_stats(&handle_clone, &mut telemetry_state).await {
                            consecutive_failures = 0;
                            if event_tx_clone.send(SessionEvent::Stats(stats)).await.is_err() {
                                break;
                            }
                        } else {
                            consecutive_failures = consecutive_failures.saturating_add(1);
                        }
                    }
                }
            }
        });
    }

    // Dedicated SFTP worker task (large transfers never block interactive PTY I/O).
    let (sftp_tx, mut sftp_rx) = mpsc::channel::<SessionCommand>(128);
    {
        let event_tx_clone = event_tx.clone();
        let sftp_tx_self = sftp_tx.clone();
        let cancel_for_sftp = cancel_rx.clone();
        let initial_dir_clone = initial_dir.clone();
        tokio::spawn(async move {
            let session_edit_root = edit_cache_root()
                .unwrap_or_else(|| std::env::temp_dir().join("vela-edits"))
                .join(uuid::Uuid::new_v4().to_string());
            let _temp_guard = TempDirGuard {
                dir: session_edit_root.clone(),
            };
            let mut active_edits: HashMap<String, PathBuf> = HashMap::new();

            if let Some(sftp) = &sftp_session {
                refresh_dir(sftp, &initial_dir_clone, &event_tx_clone).await;
            }

            let mut cancel = cancel_for_sftp.clone();
            loop {
                tokio::select! {
                    _ = cancel.changed() => break,
                    maybe_cmd = sftp_rx.recv() => {
                        let Some(cmd) = maybe_cmd else { break };
                        let Some(sftp) = &sftp_session else {
                            let _ = event_tx_clone
                                .send(SessionEvent::Error(VelaError::Sftp {
                                    path: "/".into(),
                                    reason: "SFTP subsystem is not active on this server".into(),
                                }))
                                .await;
                            continue;
                        };

                        handle_sftp_command(
                            sftp,
                            cmd,
                            &event_tx_clone,
                            &sftp_tx_self,
                            &session_edit_root,
                            &mut active_edits,
                            &cancel_for_sftp,
                        )
                        .await;
                    }
                }
            }
        });
    }

    // Fast interactive PTY loop: only handles keystrokes, resize, PTY output, and forwarding SFTP cmds.
    loop {
        tokio::select! {
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
                    SessionCommand::SetMonitoring(enabled) => {
                        let _ = mon_tx.send(enabled);
                    }
                    SessionCommand::DeployPublicKey(public_key) => {
                        let handle_clone = Arc::clone(&handle);
                        let event_tx_clone = event_tx.clone();
                        tokio::spawn(async move {
                            match deploy_public_key_remote(&handle_clone, &public_key).await {
                                Ok(()) => {
                                    let _ = event_tx_clone
                                        .send(SessionEvent::Notice(
                                            "Deployed SSH key to server".into(),
                                        ))
                                        .await;
                                }
                                Err(err) => {
                                    let _ = event_tx_clone.send(SessionEvent::Error(err)).await;
                                }
                            }
                        });
                    }
                    SessionCommand::StartLocalTunnel {
                        id,
                        local_port,
                        remote_host,
                        remote_port,
                    } => {
                        let tm = tunnel_manager.clone();
                        let handle_clone = Arc::clone(&handle);
                        let event_tx_clone = event_tx.clone();
                        let cancel_clone = cancel_rx.clone();
                        tokio::spawn(async move {
                            tm.start_local_tunnel(
                                handle_clone,
                                event_tx_clone,
                                cancel_clone,
                                LocalTunnelSpec {
                                    id,
                                    local_port,
                                    remote_host,
                                    remote_port,
                                },
                            )
                            .await;
                        });
                    }
                    SessionCommand::StopLocalTunnel { id } => {
                        let tm = tunnel_manager.clone();
                        let event_tx_clone = event_tx.clone();
                        tokio::spawn(async move {
                            tm.stop_local_tunnel(&id, &event_tx_clone).await;
                        });
                    }
                    SessionCommand::Disconnect => {
                        let _ = cancel_tx.send(true);
                        let _ = pty_channel.eof().await;
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "user disconnected", "en")
                            .await;
                        let _ = event_tx
                            .send(SessionEvent::Disconnected("Disconnected".into()))
                            .await;
                        return Ok(());
                    }
                    sftp_cmd => {
                        let _ = sftp_tx.send(sftp_cmd).await;
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

    let _ = cancel_tx.send(true);
    Ok(())
}

async fn handle_sftp_command(
    sftp: &SftpSession,
    cmd: SessionCommand,
    event_tx: &mpsc::Sender<SessionEvent>,
    sftp_tx: &mpsc::Sender<SessionCommand>,
    session_edit_root: &Path,
    active_edits: &mut HashMap<String, PathBuf>,
    cancel_rx: &watch::Receiver<bool>,
) {
    match cmd {
        SessionCommand::SftpListDir(path) => {
            refresh_dir(sftp, &path, event_tx).await;
        }
        SessionCommand::SftpOpenEntry(path) => {
            // Follow symlink target to determine whether it is a directory or regular file.
            match is_remote_dir(sftp, &path).await {
                Ok(true) => refresh_dir(sftp, &path, event_tx).await,
                Ok(false) => {
                    open_remote_file_locally(
                        sftp,
                        path,
                        event_tx,
                        sftp_tx,
                        session_edit_root,
                        active_edits,
                        cancel_rx,
                    )
                    .await;
                }
                Err(err) => {
                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                }
            }
        }
        SessionCommand::SftpDownload {
            remote_path,
            local_path,
        } => match download_file(sftp, &remote_path, &local_path).await {
            Ok(bytes) => {
                let _ = event_tx
                    .send(SessionEvent::Notice(format!(
                        "Downloaded {remote_path} ({bytes} B)"
                    )))
                    .await;
            }
            Err(err) => {
                let _ = event_tx.send(SessionEvent::Error(err)).await;
            }
        },
        SessionCommand::SftpUpload {
            local_path,
            remote_path,
        } => match upload_path_recursive(sftp, &local_path, &remote_path).await {
            Ok((bytes, count)) => {
                let msg = if count > 1 {
                    format!("Uploaded {count} files to {remote_path} ({bytes} B)")
                } else {
                    format!("Uploaded {remote_path} ({bytes} B)")
                };
                let _ = event_tx.send(SessionEvent::Notice(msg)).await;
                let parent = parent_remote_path(&remote_path);
                refresh_dir(sftp, &parent, event_tx).await;
            }
            Err(err) => {
                let _ = event_tx.send(SessionEvent::Error(err)).await;
            }
        },
        SessionCommand::SftpMkdir { path } => match create_remote_dir(sftp, &path).await {
            Ok(()) => {
                let _ = event_tx
                    .send(SessionEvent::Notice(format!("Created {path}")))
                    .await;
                let parent = parent_remote_path(&path);
                refresh_dir(sftp, &parent, event_tx).await;
            }
            Err(err) => {
                let _ = event_tx.send(SessionEvent::Error(err)).await;
            }
        },
        SessionCommand::SftpCreateFile { path } => match create_empty_file(sftp, &path).await {
            Ok(()) => {
                let _ = event_tx
                    .send(SessionEvent::Notice(format!("Created file {path}")))
                    .await;
                let parent = parent_remote_path(&path);
                refresh_dir(sftp, &parent, event_tx).await;
            }
            Err(err) => {
                let _ = event_tx.send(SessionEvent::Error(err)).await;
            }
        },
        SessionCommand::SftpRename { old_path, new_path } => {
            match rename_remote(sftp, &old_path, &new_path).await {
                Ok(()) => {
                    let _ = event_tx
                        .send(SessionEvent::Notice(format!("Renamed to {new_path}")))
                        .await;
                    let parent = parent_remote_path(&new_path);
                    refresh_dir(sftp, &parent, event_tx).await;
                }
                Err(err) => {
                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                }
            }
        }
        SessionCommand::SftpDelete { path } => match delete_remote(sftp, &path).await {
            Ok(()) => {
                let _ = event_tx
                    .send(SessionEvent::Notice(format!("Deleted {path}")))
                    .await;
                let parent = parent_remote_path(&path);
                refresh_dir(sftp, &parent, event_tx).await;
            }
            Err(err) => {
                let _ = event_tx.send(SessionEvent::Error(err)).await;
            }
        },
        SessionCommand::SftpChmod { path, mode } => match chmod_remote(sftp, &path, mode).await {
            Ok(()) => {
                let _ = event_tx
                    .send(SessionEvent::Notice(format!(
                        "Updated permissions on {path} to {:04o}",
                        mode & 0o7777
                    )))
                    .await;
                let parent = parent_remote_path(&path);
                refresh_dir(sftp, &parent, event_tx).await;
            }
            Err(err) => {
                let _ = event_tx.send(SessionEvent::Error(err)).await;
            }
        },
        SessionCommand::SftpEditLocally { remote_path } => {
            open_remote_file_locally(
                sftp,
                remote_path,
                event_tx,
                sftp_tx,
                session_edit_root,
                active_edits,
                cancel_rx,
            )
            .await;
        }
        SessionCommand::SftpReadPreview { path } => {
            match read_file_preview(sftp, &path, DEFAULT_PREVIEW_MAX_BYTES).await {
                Ok(preview) => {
                    let _ = event_tx.send(SessionEvent::FilePreview(preview)).await;
                }
                Err(err) => {
                    let _ = event_tx.send(SessionEvent::Error(err)).await;
                }
            }
        }
        _ => {}
    }
}

async fn open_remote_file_locally(
    sftp: &SftpSession,
    remote_path: String,
    event_tx: &mpsc::Sender<SessionEvent>,
    sftp_tx: &mpsc::Sender<SessionCommand>,
    session_edit_root: &Path,
    active_edits: &mut HashMap<String, PathBuf>,
    cancel_rx: &watch::Receiver<bool>,
) {
    let safe_name = match sanitize_local_filename(&remote_path) {
        Ok(n) => n,
        Err(err) => {
            let _ = event_tx.send(SessionEvent::Error(err)).await;
            return;
        }
    };

    if is_dangerous_executable_ext(&safe_name) {
        let _ = event_tx
            .send(SessionEvent::Error(VelaError::Sftp {
                path: remote_path,
                reason: "Refused to shell-open an executable or script file. Use Download instead."
                    .into(),
            }))
            .await;
        return;
    }

    // Reuse existing watcher/local file if this remote file is already open for editing.
    if let Some(existing_local) = active_edits.get(&remote_path) {
        if existing_local.exists() {
            let _ = open::that(existing_local);
            return;
        }
        active_edits.remove(&remote_path);
    }

    let file_dir = session_edit_root.join(uuid::Uuid::new_v4().to_string());
    let local_path = file_dir.join(&safe_name);
    if local_path.parent() != Some(file_dir.as_path()) {
        let _ = event_tx
            .send(SessionEvent::Error(VelaError::Sftp {
                path: remote_path,
                reason: "Resolved local path escaped edit directory".into(),
            }))
            .await;
        return;
    }

    match download_file(sftp, &remote_path, &local_path).await {
        Ok(_) => {
            let initial_hash = file_sha256(&local_path).await.unwrap_or_default();
            if let Err(err) = open::that(&local_path) {
                let _ = tokio::fs::remove_dir_all(&file_dir).await;
                let _ = event_tx
                    .send(SessionEvent::Error(VelaError::Sftp {
                        path: remote_path,
                        reason: format!("failed to open editor: {err}"),
                    }))
                    .await;
            } else {
                active_edits.insert(remote_path.clone(), local_path.clone());
                let _ = event_tx
                    .send(SessionEvent::Notice(format!(
                        "Editing {safe_name} locally (auto-uploads on save)"
                    )))
                    .await;
                spawn_edit_watcher(
                    local_path,
                    remote_path,
                    initial_hash,
                    sftp_tx.clone(),
                    cancel_rx.clone(),
                );
            }
        }
        Err(err) => {
            let _ = tokio::fs::remove_dir_all(&file_dir).await;
            let _ = event_tx.send(SessionEvent::Error(err)).await;
        }
    }
}

async fn file_sha256(path: &Path) -> Option<[u8; 32]> {
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(Sha256::digest(&bytes).into())
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
    mut last_hash: [u8; 32],
    sftp_tx: mpsc::Sender<SessionCommand>,
    mut cancel_rx: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        use notify::{RecursiveMode, Watcher};

        let target_name = local_path.file_name().map(|n| n.to_os_string());
        let (tx, mut rx) = mpsc::channel::<()>(16);
        let Ok(mut watcher) =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res
                    && matches!(
                        event.kind,
                        notify::EventKind::Modify(_) | notify::EventKind::Create(_)
                    )
                    && event.paths.iter().any(|p| p.file_name() == target_name.as_deref())
                {
                    let _ = tx.try_send(());
                }
            })
        else {
            return;
        };

        let Some(parent) = local_path.parent() else {
            return;
        };
        if watcher.watch(parent, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        loop {
            tokio::select! {
                _ = cancel_rx.changed() => break,
                maybe_ev = rx.recv() => {
                    if maybe_ev.is_none() {
                        break;
                    }
                    // Debounce atomic-save editors (VS Code / Notepad++ rename-replace).
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    while rx.try_recv().is_ok() {}

                    // Retry briefly if Windows editor still holds a transient lock during rename.
                    let mut next_hash = None;
                    for _ in 0..4 {
                        if let Some(h) = file_sha256(&local_path).await {
                            next_hash = Some(h);
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(120)).await;
                    }

                    let Some(hash) = next_hash else { continue };
                    if hash == last_hash {
                        continue;
                    }
                    last_hash = hash;

                    if sftp_tx
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
