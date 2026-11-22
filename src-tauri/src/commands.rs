use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use tracing::{error, info, warn};
use uuid::Uuid;
use vela_core::{
    AppSettings, AuthMethod, HostKeyStatus, HostProfile, KnownHostsStore, OsKeyringStore,
    ProfileStore, SecretStore, SettingsStore, Snippet, SnippetStore, UserError,
    read_default_ssh_config,
};
use vela_ssh::keys::validate_public_key_for_deploy;
use vela_ssh::sftp::{join_remote_path, parent_remote_path, validate_remote_entry_name};
use vela_ssh::{
    AuthCredentials, ConnectConfig, FilePreview, PtySize, RemoteEntry, ServerStats, SessionCommand,
    SessionEvent, SshKeyInfo, SshSessionHandle, TunnelInfo, connect_session, generate_ed25519_key,
    list_ssh_keys as scan_ssh_keys,
};

pub struct PendingPrompt {
    pub session_id: String,
    pub responder: oneshot::Sender<bool>,
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, SshSessionHandle>>,
    pub host_key_prompts: Mutex<HashMap<String, PendingPrompt>>,
    pub store_lock: Mutex<()>,
    pub profile_store: Option<ProfileStore>,
    pub settings_store: Option<SettingsStore>,
    pub snippet_store: Option<SnippetStore>,
    pub known_hosts: Option<KnownHostsStore>,
    pub secrets: OsKeyringStore,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            host_key_prompts: Mutex::new(HashMap::new()),
            store_lock: Mutex::new(()),
            profile_store: ProfileStore::default_store().ok(),
            settings_store: SettingsStore::default_store().ok(),
            snippet_store: SnippetStore::default_store().ok(),
            known_hosts: KnownHostsStore::default_store().ok(),
            secrets: OsKeyringStore,
        }
    }

    async fn send_cmd(&self, session_id: &str, cmd: SessionCommand) -> Result<(), String> {
        let tx = {
            let guard = self
                .sessions
                .lock()
                .map_err(|e| format!("session lock poisoned: {e}"))?;
            guard
                .get(session_id)
                .map(|h| h.cmd_tx.clone())
                .ok_or_else(|| "session not found".to_string())?
        };
        tx.send(cmd)
            .await
            .map_err(|e| format!("failed to send session command: {e}"))
    }

    pub fn purge_prompts_for_session(&self, session_id: &str) {
        if let Ok(mut guard) = self.host_key_prompts.lock() {
            guard.retain(|_, p| p.session_id != session_id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyPayload {
    pub session_id: String,
    pub data_b64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SftpListingPayload {
    pub session_id: String,
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsPayload {
    pub session_id: String,
    pub stats: ServerStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostKeyPayload {
    pub prompt_id: String,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub status: HostKeyStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionStatePayload {
    pub session_id: String,
    pub state: String,
    pub initial_dir: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NoticePayload {
    pub session_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorPayload {
    pub session_id: String,
    pub error: UserError,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilePreviewPayload {
    pub session_id: String,
    pub preview: FilePreview,
}

#[derive(Debug, Clone, Serialize)]
pub struct TunnelsPayload {
    pub session_id: String,
    pub tunnels: Vec<TunnelInfo>,
}

#[derive(Deserialize)]
pub struct NewProfileInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub use_key: bool,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

impl fmt::Debug for NewProfileInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NewProfileInput")
            .field("name", &self.name)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("use_key", &self.use_key)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("key_path", &self.key_path)
            .field(
                "passphrase",
                &self.passphrase.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub session_id: String,
    pub title: String,
    pub address: String,
}

fn validate_host_name(host: &str) -> Result<String, String> {
    let trimmed = host.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '#')
    {
        return Err("Host contains invalid characters".to_string());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<Vec<HostProfile>, String> {
    let Some(store) = &state.profile_store else {
        return Ok(Vec::new());
    };
    store.load().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_profile(
    input: NewProfileInput,
    state: State<'_, AppState>,
) -> Result<HostProfile, String> {
    let host = validate_host_name(&input.host)?;
    let username = input.username.trim().to_string();
    if username.is_empty() {
        return Err("Username is required".to_string());
    }
    if input.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }

    let name = if input.name.trim().is_empty() {
        format!("{username}@{host}")
    } else {
        input.name.trim().to_string()
    };

    let auth = if input.use_key {
        let kp = input.key_path.unwrap_or_default();
        let trimmed = kp.trim();
        if trimmed.is_empty() {
            return Err("Private key path is required for SSH key auth".to_string());
        }
        AuthMethod::PrivateKey {
            path: PathBuf::from(trimmed),
        }
    } else {
        AuthMethod::Password
    };

    let profile = HostProfile::new(name, host, input.port, username, auth);

    let secret = if input.use_key {
        input.passphrase.unwrap_or_default()
    } else {
        input.password.unwrap_or_default()
    };
    if !secret.is_empty() {
        state
            .secrets
            .set_secret(&profile.secret_key(), &secret)
            .map_err(|e| format!("Failed to store credentials in OS keychain: {e}"))?;
    }

    if let Some(store) = &state.profile_store {
        let _lock = state
            .store_lock
            .lock()
            .map_err(|e| format!("store lock poisoned: {e}"))?;
        let mut profiles = store.load().map_err(|e| e.to_string())?;
        profiles.push(profile.clone());
        store.save(&profiles).map_err(|e| e.to_string())?;
    }

    Ok(profile)
}

#[tauri::command]
pub fn delete_profile(profile_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let uuid = Uuid::parse_str(&profile_id).map_err(|e| e.to_string())?;
    let Some(store) = &state.profile_store else {
        return Ok(());
    };
    let _lock = state
        .store_lock
        .lock()
        .map_err(|e| format!("store lock poisoned: {e}"))?;
    let mut profiles = store.load().map_err(|e| e.to_string())?;
    if let Some(pos) = profiles.iter().position(|p| p.id == uuid) {
        let removed = profiles.remove(pos);
        if let Err(err) = state.secrets.delete_secret(&removed.secret_key()) {
            warn!("failed to remove secret from OS keychain: {err}");
        }
        store.save(&profiles).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state
        .settings_store
        .as_ref()
        .and_then(|s| s.load().ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(store) = &state.settings_store {
        let _lock = state
            .store_lock
            .lock()
            .map_err(|e| format!("store lock poisoned: {e}"))?;
        store.save(&settings).map_err(|e| e.to_string())?;
    }
    let handles: Vec<_> = {
        let guard = state
            .sessions
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        guard.values().map(|h| h.cmd_tx.clone()).collect()
    };
    for tx in handles {
        let _ = tx
            .send(SessionCommand::SetMonitoring(settings.remote_monitoring))
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_profile(
    session_id: String,
    profile_id: String,
    cols: u32,
    rows: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConnectResult, String> {
    Uuid::parse_str(&session_id).map_err(|_| "invalid session ID".to_string())?;
    let uuid = Uuid::parse_str(&profile_id).map_err(|e| e.to_string())?;
    let store = state
        .profile_store
        .as_ref()
        .ok_or_else(|| "profile store unavailable".to_string())?;
    let profiles = store.load().map_err(|e| e.to_string())?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == uuid)
        .ok_or_else(|| "profile not found".to_string())?;

    let saved_secret = state
        .secrets
        .get_secret(&profile.secret_key())
        .map_err(|e| format!("OS keychain error: {e}"))?;

    let credentials = match &profile.auth {
        AuthMethod::Password => AuthCredentials::Password(saved_secret.unwrap_or_default()),
        AuthMethod::PrivateKey { path } => AuthCredentials::PrivateKey {
            path: path.clone(),
            passphrase: saved_secret,
        },
        AuthMethod::Agent => {
            return Err("SSH agent authentication is not yet implemented".to_string());
        }
    };

    let known_hosts = state
        .known_hosts
        .clone()
        .ok_or_else(|| "known_hosts store unavailable".to_string())?;

    let settings = state
        .settings_store
        .as_ref()
        .and_then(|s| s.load().ok())
        .unwrap_or_default();

    let cfg = ConnectConfig {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        credentials,
        initial_pty: PtySize {
            cols: cols.max(20),
            rows: rows.max(8),
        },
        keepalive_secs: profile.keepalive_secs,
        initial_remote_path: profile.default_remote_path.clone(),
    };

    info!("Connecting Tauri session to {}", profile.display_address());
    let (mut event_rx, monitoring_tx) = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        if guard.contains_key(&session_id) {
            return Err("session ID already in use".to_string());
        }
        let (handle, event_rx) = connect_session(cfg, known_hosts);
        let monitoring_tx = handle.cmd_tx.clone();
        guard.insert(session_id.clone(), handle);
        (event_rx, monitoring_tx)
    };
    if !settings.remote_monitoring {
        let _ = monitoring_tx
            .send(SessionCommand::SetMonitoring(false))
            .await;
    }

    let sid = session_id.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = event_rx.recv().await {
            match ev {
                SessionEvent::HostKeyVerification(prompt) => {
                    let prompt_id = Uuid::new_v4().to_string();
                    if let Ok(mut guard) = app_handle.state::<AppState>().host_key_prompts.lock() {
                        guard.insert(
                            prompt_id.clone(),
                            PendingPrompt {
                                session_id: sid.clone(),
                                responder: prompt.responder,
                            },
                        );
                    }
                    let _ = app_handle.emit(
                        "vela://host-key",
                        HostKeyPayload {
                            prompt_id,
                            session_id: sid.clone(),
                            host: prompt.host,
                            port: prompt.port,
                            status: prompt.status,
                        },
                    );
                }
                SessionEvent::Connected { initial_dir } => {
                    let _ = app_handle.emit(
                        "vela://state",
                        SessionStatePayload {
                            session_id: sid.clone(),
                            state: "connected".to_string(),
                            initial_dir: Some(initial_dir),
                            detail: None,
                        },
                    );
                }
                SessionEvent::PtyOutput(bytes) => {
                    let data_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                    let _ = app_handle.emit(
                        "vela://pty",
                        PtyPayload {
                            session_id: sid.clone(),
                            data_b64,
                        },
                    );
                }
                SessionEvent::SftpDirListing { path, entries } => {
                    let _ = app_handle.emit(
                        "vela://sftp",
                        SftpListingPayload {
                            session_id: sid.clone(),
                            path,
                            entries,
                        },
                    );
                }
                SessionEvent::FilePreview(preview) => {
                    let _ = app_handle.emit(
                        "vela://preview",
                        FilePreviewPayload {
                            session_id: sid.clone(),
                            preview,
                        },
                    );
                }
                SessionEvent::TunnelsUpdated(tunnels) => {
                    let _ = app_handle.emit(
                        "vela://tunnels",
                        TunnelsPayload {
                            session_id: sid.clone(),
                            tunnels,
                        },
                    );
                }
                SessionEvent::Stats(stats) => {
                    let _ = app_handle.emit(
                        "vela://stats",
                        StatsPayload {
                            session_id: sid.clone(),
                            stats,
                        },
                    );
                }
                SessionEvent::Notice(message) => {
                    let _ = app_handle.emit(
                        "vela://notice",
                        NoticePayload {
                            session_id: sid.clone(),
                            message,
                        },
                    );
                }
                SessionEvent::Error(err) => {
                    error!("Session {sid} error: {err}");
                    let _ = app_handle.emit(
                        "vela://error",
                        ErrorPayload {
                            session_id: sid.clone(),
                            error: err.to_user_error(),
                        },
                    );
                }
                SessionEvent::Disconnected(reason) => {
                    let _ = app_handle.emit(
                        "vela://state",
                        SessionStatePayload {
                            session_id: sid.clone(),
                            state: "disconnected".to_string(),
                            initial_dir: None,
                            detail: Some(reason),
                        },
                    );
                }
            }
        }
        let app_state = app_handle.state::<AppState>();
        app_state.purge_prompts_for_session(&sid);
        if let Ok(mut guard) = app_state.sessions.lock() {
            guard.remove(&sid);
        }
    });

    Ok(ConnectResult {
        session_id,
        title: profile.name.clone(),
        address: profile.display_address(),
    })
}

#[tauri::command]
pub fn respond_host_key(
    prompt_id: String,
    accepted: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let prompt = {
        let mut guard = state
            .host_key_prompts
            .lock()
            .map_err(|e| format!("prompt lock poisoned: {e}"))?;
        guard.remove(&prompt_id)
    };
    if let Some(p) = prompt {
        let _ = p.responder.send(accepted);
    }
    Ok(())
}

#[tauri::command]
pub async fn send_pty_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(&session_id, SessionCommand::SendBytes(data.into_bytes()))
        .await
}

#[tauri::command]
pub async fn resize_pty(
    session_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(
            &session_id,
            SessionCommand::Resize(PtySize {
                cols: cols.max(10),
                rows: rows.max(4),
            }),
        )
        .await
}

#[tauri::command]
pub async fn disconnect_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.purge_prompts_for_session(&session_id);
    let handle = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        guard.remove(&session_id)
    };
    if let Some(h) = handle {
        let _ = h.cmd_tx.send(SessionCommand::Disconnect).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_list_dir(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(&session_id, SessionCommand::SftpListDir(path))
        .await
}

#[tauri::command]
pub async fn sftp_open_entry(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(&session_id, SessionCommand::SftpOpenEntry(path))
        .await
}

#[tauri::command]
pub async fn sftp_go_up(
    session_id: String,
    current_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let parent = parent_remote_path(&current_path);
    state
        .send_cmd(&session_id, SessionCommand::SftpListDir(parent))
        .await
}

/// Opens a native OS Save dialog on the backend so the frontend cannot supply arbitrary local paths.
#[tauri::command]
pub async fn sftp_download_dialog(
    session_id: String,
    remote_path: String,
    default_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });

    let Some(file_path) = rx.await.ok().flatten() else {
        return Ok(false);
    };
    let local_path = file_path
        .into_path()
        .map_err(|e| format!("invalid save path: {e}"))?;

    state
        .send_cmd(
            &session_id,
            SessionCommand::SftpDownload {
                remote_path,
                local_path,
            },
        )
        .await?;
    Ok(true)
}

/// Opens a native OS Open dialog on the backend to pick files for SFTP upload.
#[tauri::command]
pub async fn sftp_upload_dialog(
    session_id: String,
    remote_dir: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_files(move |picked| {
        let _ = tx.send(picked);
    });

    let Some(files) = rx.await.ok().flatten() else {
        return Ok(0);
    };

    let mut count = 0usize;
    for fp in files {
        let local_path = fp
            .into_path()
            .map_err(|e| format!("invalid file path: {e}"))?;
        let Some(file_name) = local_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let valid_name = validate_remote_entry_name(file_name).map_err(|e| e.to_string())?;
        let remote_path = join_remote_path(&remote_dir, valid_name);
        state
            .send_cmd(
                &session_id,
                SessionCommand::SftpUpload {
                    local_path,
                    remote_path,
                },
            )
            .await?;
        count += 1;
    }
    Ok(count)
}

/// Uploads OS-dropped local files or folders into `remote_dir`.
#[tauri::command]
pub async fn sftp_upload_dropped(
    session_id: String,
    local_path: String,
    remote_dir: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let local = PathBuf::from(&local_path);
    let file_name = local
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid local filename".to_string())?;
    let valid_name = validate_remote_entry_name(file_name).map_err(|e| e.to_string())?;
    let remote_path = join_remote_path(&remote_dir, valid_name);
    state
        .send_cmd(
            &session_id,
            SessionCommand::SftpUpload {
                local_path: local,
                remote_path,
            },
        )
        .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    parent_dir: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let valid = validate_remote_entry_name(&name).map_err(|e| e.to_string())?;
    let path = join_remote_path(&parent_dir, valid);
    state
        .send_cmd(&session_id, SessionCommand::SftpMkdir { path })
        .await
}

#[tauri::command]
pub async fn sftp_create_file(
    session_id: String,
    parent_dir: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let valid = validate_remote_entry_name(&name).map_err(|e| e.to_string())?;
    let path = join_remote_path(&parent_dir, valid);
    state
        .send_cmd(&session_id, SessionCommand::SftpCreateFile { path })
        .await
}

#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let valid = validate_remote_entry_name(&new_name).map_err(|e| e.to_string())?;
    let parent = parent_remote_path(&old_path);
    let new_path = join_remote_path(&parent, valid);
    state
        .send_cmd(
            &session_id,
            SessionCommand::SftpRename { old_path, new_path },
        )
        .await
}

#[tauri::command]
pub async fn sftp_delete(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(&session_id, SessionCommand::SftpDelete { path })
        .await
}

#[tauri::command]
pub async fn sftp_chmod(
    session_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if mode > 0o7777 {
        return Err("Permissions must be a four-digit octal mode or less".to_string());
    }
    state
        .send_cmd(&session_id, SessionCommand::SftpChmod { path, mode })
        .await
}

#[tauri::command]
pub async fn sftp_edit_locally(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(&session_id, SessionCommand::SftpEditLocally { remote_path })
        .await
}

/// Opens a native Save dialog on the backend and writes a terminal transcript safely.
#[tauri::command]
pub async fn save_transcript_dialog(
    default_name: String,
    content: String,
    app: AppHandle,
) -> Result<bool, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });

    let Some(file_path) = rx.await.ok().flatten() else {
        return Ok(false);
    };
    let local_path = file_path
        .into_path()
        .map_err(|e| format!("invalid save path: {e}"))?;
    tokio::fs::write(&local_path, content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Opens an external HTTP/HTTPS URL in the user's OS browser (rejecting all other schemes).
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http:// and https:// URLs can be opened".to_string());
    }
    open::that(trimmed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    let Some(store) = &state.snippet_store else {
        return Ok(vela_core::starter_snippets());
    };
    store.load().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_snippet(
    name: String,
    command: String,
    folder: Option<String>,
    auto_execute: bool,
    state: State<'_, AppState>,
) -> Result<Snippet, String> {
    let clean_name = name.trim().to_string();
    if clean_name.is_empty() {
        return Err("Snippet name is required".to_string());
    }
    let clean_command = command.trim().to_string();
    if clean_command.is_empty() {
        return Err("Snippet command is required".to_string());
    }
    let clean_folder = folder
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty());

    let snippet = Snippet::new(clean_name, clean_command, clean_folder, auto_execute);

    if let Some(store) = &state.snippet_store {
        let _lock = state
            .store_lock
            .lock()
            .map_err(|e| format!("store lock poisoned: {e}"))?;
        let mut snippets = store.load().map_err(|e| e.to_string())?;
        snippets.push(snippet.clone());
        store.save(&snippets).map_err(|e| e.to_string())?;
    }

    Ok(snippet)
}

#[tauri::command]
pub fn delete_snippet(snippet_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let uuid = Uuid::parse_str(&snippet_id).map_err(|e| e.to_string())?;
    let Some(store) = &state.snippet_store else {
        return Ok(());
    };
    let _lock = state
        .store_lock
        .lock()
        .map_err(|e| format!("store lock poisoned: {e}"))?;
    let mut snippets = store.load().map_err(|e| e.to_string())?;
    let before = snippets.len();
    snippets.retain(|s| s.id != uuid);
    if snippets.len() != before {
        store.save(&snippets).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn import_ssh_config(state: State<'_, AppState>) -> Result<Vec<HostProfile>, String> {
    let parsed = read_default_ssh_config().map_err(|e| e.to_string())?;
    if parsed.is_empty() {
        return Ok(Vec::new());
    }
    let Some(store) = &state.profile_store else {
        return Err("profile store unavailable".to_string());
    };

    let _lock = state
        .store_lock
        .lock()
        .map_err(|e| format!("store lock poisoned: {e}"))?;
    let mut existing = store.load().map_err(|e| e.to_string())?;

    let mut newly_imported = Vec::new();
    for candidate in parsed {
        let already_exists = existing.iter().any(|p| {
            p.host.eq_ignore_ascii_case(&candidate.host)
                && p.port == candidate.port
                && p.username == candidate.username
        });
        if !already_exists {
            existing.push(candidate.clone());
            newly_imported.push(candidate);
        }
    }

    if !newly_imported.is_empty() {
        store.save(&existing).map_err(|e| e.to_string())?;
    }
    Ok(newly_imported)
}

#[tauri::command]
pub fn toggle_bookmark(
    profile_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let uuid = Uuid::parse_str(&profile_id).map_err(|e| e.to_string())?;
    let clean_path = path.trim().to_string();
    if clean_path.is_empty() {
        return Err("Bookmark path cannot be empty".to_string());
    }
    let store = state
        .profile_store
        .as_ref()
        .ok_or_else(|| "profile store unavailable".to_string())?;

    let _lock = state
        .store_lock
        .lock()
        .map_err(|e| format!("store lock poisoned: {e}"))?;
    let mut profiles = store.load().map_err(|e| e.to_string())?;
    let profile = profiles
        .iter_mut()
        .find(|p| p.id == uuid)
        .ok_or_else(|| "profile not found".to_string())?;

    if let Some(pos) = profile.bookmarks.iter().position(|b| b == &clean_path) {
        profile.bookmarks.remove(pos);
    } else {
        profile.bookmarks.push(clean_path);
    }
    let updated = profile.bookmarks.clone();
    store.save(&profiles).map_err(|e| e.to_string())?;
    Ok(updated)
}

#[tauri::command]
pub fn list_ssh_keys() -> Result<Vec<SshKeyInfo>, String> {
    scan_ssh_keys().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn generate_ssh_key(name: String, comment: String) -> Result<SshKeyInfo, String> {
    generate_ed25519_key(&name, &comment).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn deploy_public_key(
    session_id: String,
    public_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let validated = validate_public_key_for_deploy(&public_key).map_err(|e| e.to_string())?;
    state
        .send_cmd(&session_id, SessionCommand::DeployPublicKey(validated))
        .await
}

#[tauri::command]
pub async fn start_local_tunnel(
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let host = validate_host_name(&remote_host)?;
    if local_port == 0 || remote_port == 0 {
        return Err("Ports must be between 1 and 65535".to_string());
    }
    let tunnel_id = Uuid::new_v4().to_string();
    state
        .send_cmd(
            &session_id,
            SessionCommand::StartLocalTunnel {
                id: tunnel_id.clone(),
                local_port,
                remote_host: host,
                remote_port,
            },
        )
        .await?;
    Ok(tunnel_id)
}

#[tauri::command]
pub async fn stop_local_tunnel(
    session_id: String,
    tunnel_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(
            &session_id,
            SessionCommand::StopLocalTunnel { id: tunnel_id },
        )
        .await
}

#[tauri::command]
pub async fn sftp_read_preview(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .send_cmd(&session_id, SessionCommand::SftpReadPreview { path })
        .await
}
