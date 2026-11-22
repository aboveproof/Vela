#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use tracing::{error, info, warn};

use crate::commands::AppState;

fn main() {
    let _log_guard = match vela_core::logging::init_logging() {
        Ok(guard) => {
            info!("Vela logging initialized at {}", guard.log_dir.display());
            Some(guard)
        }
        Err(err) => {
            warn!("Could not initialize file logging: {err}");
            None
        }
    };

    // Prune any stale temp files left by a previous crash.
    vela_ssh::cleanup_stale_edit_dirs();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::get_settings,
            commands::save_settings,
            commands::connect_profile,
            commands::respond_host_key,
            commands::send_pty_input,
            commands::resize_pty,
            commands::disconnect_session,
            commands::sftp_list_dir,
            commands::sftp_open_entry,
            commands::sftp_go_up,
            commands::sftp_download_dialog,
            commands::sftp_upload_dialog,
            commands::sftp_upload_dropped,
            commands::sftp_mkdir,
            commands::sftp_create_file,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_chmod,
            commands::sftp_edit_locally,
            commands::save_transcript_dialog,
            commands::open_external_url,
        ])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        error!("Tauri runtime error: {err}");
    }
}
