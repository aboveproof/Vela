use serde::Serialize;
use thiserror::Error;

pub type VelaResult<T> = Result<T, VelaError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    Retry,
    UpdateKnownHosts,
    SwitchAuth,
    OpenSettings,
    CopyDiagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UserError {
    pub title: String,
    pub detail: String,
    pub action: RecoveryAction,
}

#[derive(Debug, Error)]
pub enum VelaError {
    #[error("authentication failed for {user}@{host}: {reason}")]
    AuthFailed {
        user: String,
        host: String,
        reason: String,
    },

    #[error("host key mismatch for {host}:{port} (expected {expected}, got {actual})")]
    HostKeyMismatch {
        host: String,
        port: u16,
        expected: String,
        actual: String,
    },

    #[error("host key rejected by user for {host}:{port}")]
    HostKeyRejected { host: String, port: u16 },

    #[error("connection to {host}:{port} failed: {reason}")]
    ConnectionFailed {
        host: String,
        port: u16,
        reason: String,
    },

    #[error("SFTP error on '{path}': {reason}")]
    Sftp { path: String, reason: String },

    #[error("keychain unavailable: {0}")]
    Keychain(String),

    #[error("configuration error: {0}")]
    Config(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

impl VelaError {
    pub fn to_user_error(&self) -> UserError {
        match self {
            Self::AuthFailed { user, host, reason } => UserError {
                title: format!("Authentication failed ({user}@{host})"),
                detail: reason.clone(),
                action: RecoveryAction::SwitchAuth,
            },
            Self::HostKeyMismatch {
                host,
                port,
                expected,
                actual,
            } => UserError {
                title: format!("Host key changed for {host}:{port}"),
                detail: format!("Expected {expected}, received {actual}. Verify server identity before updating."),
                action: RecoveryAction::UpdateKnownHosts,
            },
            Self::HostKeyRejected { host, port } => UserError {
                title: format!("Connection cancelled ({host}:{port})"),
                detail: "Host fingerprint was not trusted.".to_string(),
                action: RecoveryAction::Retry,
            },
            Self::ConnectionFailed { host, port, reason } => UserError {
                title: format!("Unable to connect to {host}:{port}"),
                detail: reason.clone(),
                action: RecoveryAction::Retry,
            },
            Self::Sftp { path, reason } => UserError {
                title: format!("SFTP operation failed on {path}"),
                detail: reason.clone(),
                action: RecoveryAction::Retry,
            },
            Self::Keychain(reason) => UserError {
                title: "OS Keychain unavailable".to_string(),
                detail: reason.clone(),
                action: RecoveryAction::OpenSettings,
            },
            Self::Config(reason) => UserError {
                title: "Configuration error".to_string(),
                detail: reason.clone(),
                action: RecoveryAction::CopyDiagnostics,
            },
            Self::Io(err) => UserError {
                title: "Filesystem I/O error".to_string(),
                detail: err.to_string(),
                action: RecoveryAction::CopyDiagnostics,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_errors_to_expected_recovery_actions() {
        let auth = VelaError::AuthFailed {
            user: "rico".into(),
            host: "10.0.0.5".into(),
            reason: "invalid password".into(),
        };
        assert_eq!(auth.to_user_error().action, RecoveryAction::SwitchAuth);

        let mismatch = VelaError::HostKeyMismatch {
            host: "homeserver".into(),
            port: 22,
            expected: "SHA256:aaa".into(),
            actual: "SHA256:bbb".into(),
        };
        assert_eq!(
            mismatch.to_user_error().action,
            RecoveryAction::UpdateKnownHosts
        );
    }
}
