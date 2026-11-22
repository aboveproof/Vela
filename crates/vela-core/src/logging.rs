use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

use crate::error::{VelaError, VelaResult};

pub struct LogGuard {
    _guard: WorkerGuard,
    pub log_dir: PathBuf,
}

/// Initializes structured tracing with a daily rotating log file in the OS data directory.
pub fn init_logging() -> VelaResult<LogGuard> {
    let log_dir = default_log_dir()?;
    std::fs::create_dir_all(&log_dir)?;

    let file_appender = tracing_appender::rolling::daily(&log_dir, "vela.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("vela_core=info,vela_ssh=info,vela_app=info,warn"));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr))
        .try_init();

    Ok(LogGuard {
        _guard: guard,
        log_dir,
    })
}

pub fn default_log_dir() -> VelaResult<PathBuf> {
    let proj = directories::ProjectDirs::from("dev", "vela", "Vela")
        .ok_or_else(|| VelaError::Config("could not resolve OS project directories".into()))?;
    Ok(proj.data_local_dir().join("logs"))
}
