use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use tracing::{error, info, warn};
use uuid::Uuid;
use vela_core::{
    AppSettings, AuthMethod, HostKeyStatus, HostProfile, KnownHostsStore, OsKeyringStore,
    ProfileStore, SecretStore, SettingsStore, UserError,
};
use vela_ssh::sftp::{join_remote_path, parent_remote_path};
use vela_ssh::{
    AuthCredentials, ConnectConfig, PtySize, RemoteEntry, ServerStats, SessionCommand,
    SessionEvent, SshSessionHandle, connect_session,
};

pub struct AppState {
    pub sessions: Mutex<HashMap<String, SshSessionHandle>>,
    pub host_key_prompts: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    pub profile_store: Option<ProfileStore>,
    pub settings_store: Option<SettingsStore>,
    pub known_hosts: Option<KnownHostsStore>,
    pub secrets: OsKeyringStore,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            host_key_prompts: Mutex::new(HashMap::new()),
            profile_store: ProfileStore::default_store().ok(),
            settings_store: SettingsStore::default_store().ok(),
            known_hosts: KnownHostsStore::default_store().ok(),
            secrets: OsKeyringStore,
        }
    }

    fn send_cmd(&self, session_id: &str, cmd: SessionCommand) -> Result<(), String> {
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
        tx.try_send(cmd)
            .map_err(|e| format!("failed to send session command: {e}"))
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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub session_id: String,
    pub title: String,
    pub address: String,
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
    let host = input.host.trim().to_string();
    let username = input.username.trim().to_string();
    if host.is_empty() || username.is_empty() {
        return Err("Host and username are required".to_string());
    }

    let name = if input.name.trim().is_empty() {
        format!("{username}@{host}")
    } else {
        input.name.trim().to_string()
    };

    let auth = if input.use_key {
        AuthMethod::PrivateKey {
            path: PathBuf::from(input.key_path.unwrap_or_default().trim()),
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
    if !secret.is_empty()
        && let Err(err) = state.secrets.set_secret(&profile.secret_key(), &secret)
    {
        warn!("could not save secret to OS keychain: {err}");
    }

    if let Some(store) = &state.profile_store {
        let mut profiles = store.load().unwrap_or_default();
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
    let mut profiles = store.load().unwrap_or_default();
    if let Some(pos) = profiles.iter().position(|p| p.id == uuid) {
        let removed = profiles.remove(pos);
        let _ = state.secrets.delete_secret(&removed.secret_key());
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
pub fn save_settings(settings: AppSettings, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(store) = &state.settings_store {
        store.save(&settings).map_err(|e| e.to_string())?;
    }
    // Propagate monitoring toggle to all live sessions.
    let handles: Vec<_> = {
        let guard = state
            .sessions
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        guard.values().map(|h| h.cmd_tx.clone()).collect()
    };
    for tx in handles {
        let _ = tx.try_send(SessionCommand::SetMonitoring(settings.remote_monitoring));
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_profile(
    profile_id: String,
    cols: u32,
    rows: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConnectResult, String> {
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
        .ok()
        .flatten();

    let credentials = match &profile.auth {
        AuthMethod::Password | AuthMethod::Agent => {
            AuthCredentials::Password(saved_secret.unwrap_or_default())
        }
        AuthMethod::PrivateKey { path } => AuthCredentials::PrivateKey {
            path: path.clone(),
            passphrase: saved_secret,
        },
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
    let (handle, mut event_rx) = connect_session(cfg, known_hosts);
    if !settings.remote_monitoring {
        let _ = handle.cmd_tx.try_send(SessionCommand::SetMonitoring(false));
    }

    let session_id = Uuid::new_v4().to_string();
    {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        guard.insert(session_id.clone(), handle);
    }

    let sid = session_id.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = event_rx.recv().await {
            match ev {
                SessionEvent::HostKeyVerification(prompt) => {
                    let prompt_id = Uuid::new_v4().to_string();
                    if let Ok(mut guard) = app_handle.state::<AppState>().host_key_prompts.lock() {
                        guard.insert(prompt_id.clone(), prompt.responder);
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
        if let Ok(mut guard) = app_handle.state::<AppState>().sessions.lock() {
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
    let tx = {
        let mut guard = state
            .host_key_prompts
            .lock()
            .map_err(|e| format!("prompt lock poisoned: {e}"))?;
        guard.remove(&prompt_id)
    };
    if let Some(sender) = tx {
        let _ = sender.send(accepted);
    }
    Ok(())
}

#[tauri::command]
pub fn send_pty_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.send_cmd(&session_id, SessionCommand::SendBytes(data.into_bytes()))
}

#[tauri::command]
pub fn resize_pty(
    session_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.send_cmd(
        &session_id,
        SessionCommand::Resize(PtySize {
            cols: cols.max(10),
            rows: rows.max(4),
        }),
    )
}

#[tauri::command]
pub fn disconnect_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let handle = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|e| format!("session lock poisoned: {e}"))?;
        guard.remove(&session_id)
    };
    if let Some(h) = handle {
        let _ = h.cmd_tx.try_send(SessionCommand::Disconnect);
    }
    Ok(())
}

#[tauri::command]
pub fn sftp_list_dir(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.send_cmd(&session_id, SessionCommand::SftpListDir(path))
}

#[tauri::command]
pub fn sftp_go_up(
    session_id: String,
    current_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let parent = parent_remote_path(&current_path);
    state.send_cmd(&session_id, SessionCommand::SftpListDir(parent))
}

#[tauri::command]
pub fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.send_cmd(
        &session_id,
        SessionCommand::SftpDownload {
            remote_path,
            local_path: PathBuf::from(local_path),
        },
    )
}

#[tauri::command]
pub fn sftp_upload(
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
    let remote_path = join_remote_path(&remote_dir, file_name);
    state.send_cmd(
        &session_id,
        SessionCommand::SftpUpload {
            local_path: local,
            remote_path,
        },
    )
}

#[tauri::command]
pub fn sftp_mkdir(
    session_id: String,
    parent_dir: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = join_remote_path(&parent_dir, name.trim());
    state.send_cmd(&session_id, SessionCommand::SftpMkdir { path })
}

#[tauri::command]
pub fn sftp_create_file(
    session_id: String,
    parent_dir: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = join_remote_path(&parent_dir, name.trim());
    state.send_cmd(&session_id, SessionCommand::SftpCreateFile { path })
}

#[tauri::command]
pub fn sftp_rename(
    session_id: String,
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let parent = parent_remote_path(&old_path);
    let new_path = join_remote_path(&parent, new_name.trim());
    state.send_cmd(&session_id, SessionCommand::SftpRename { old_path, new_path })
}

#[tauri::command]
pub fn sftp_delete(
    session_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.send_cmd(&session_id, SessionCommand::SftpDelete { path, is_dir })
}

#[tauri::command]
pub fn sftp_chmod(
    session_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.send_cmd(&session_id, SessionCommand::SftpChmod { path, mode })
}

#[tauri::command]
pub fn sftp_edit_locally(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.send_cmd(
        &session_id,
        SessionCommand::SftpEditLocally { remote_path },
    )
}

#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}
