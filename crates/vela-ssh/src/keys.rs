use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use russh::ChannelMsg;
use russh::client::{Handle, Handler};
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use vela_core::{VelaError, VelaResult};

const DEPLOY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshKeyInfo {
    pub name: String,
    pub private_path: String,
    pub public_path: String,
    pub public_key: String,
    pub fingerprint: String,
    pub key_type: String,
}

pub fn default_ssh_dir() -> VelaResult<PathBuf> {
    let base = directories::BaseDirs::new()
        .ok_or_else(|| VelaError::Config("could not resolve user home directory".into()))?;
    Ok(base.home_dir().join(".ssh"))
}

/// Scans `~/.ssh/` for `*.pub` files, computes OpenSSH `SHA256:...` fingerprints,
/// and detects matching private keys.
pub fn list_ssh_keys() -> VelaResult<Vec<SshKeyInfo>> {
    let ssh_dir = default_ssh_dir()?;
    list_ssh_keys_in(&ssh_dir)
}

pub fn list_ssh_keys_in(ssh_dir: &Path) -> VelaResult<Vec<SshKeyInfo>> {
    if !ssh_dir.exists() {
        return Ok(Vec::new());
    }

    let mut keys = Vec::new();
    for entry in std::fs::read_dir(ssh_dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_pub = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("pub"));
        if !is_pub {
            continue;
        }

        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(line) = raw.lines().map(str::trim).find(|l| !l.is_empty()) else {
            continue;
        };
        let Some((key_type, fingerprint)) = parse_public_key_line(line) else {
            continue;
        };

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("key")
            .to_string();
        let candidate_private = path.with_extension("");
        let private_path = if candidate_private.is_file() {
            candidate_private.to_string_lossy().into_owned()
        } else {
            String::new()
        };

        keys.push(SshKeyInfo {
            name: stem,
            private_path,
            public_path: path.to_string_lossy().into_owned(),
            public_key: line.to_string(),
            fingerprint,
            key_type,
        });
    }

    keys.sort_by_key(|a| a.name.to_lowercase());
    Ok(keys)
}

/// Generates a new Ed25519 SSH keypair inside `~/.ssh/` without overwriting existing files.
pub fn generate_ed25519_key(name: &str, comment: &str) -> VelaResult<SshKeyInfo> {
    let ssh_dir = default_ssh_dir()?;
    generate_ed25519_key_in(&ssh_dir, name, comment)
}

pub fn generate_ed25519_key_in(
    ssh_dir: &Path,
    name: &str,
    comment: &str,
) -> VelaResult<SshKeyInfo> {
    let clean_name = validate_key_name(name)?;
    let clean_comment: String = comment
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect();

    if !ssh_dir.exists() {
        std::fs::create_dir_all(ssh_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(ssh_dir, std::fs::Permissions::from_mode(0o700));
        }
    }

    let private_path = ssh_dir.join(clean_name);
    let public_path = ssh_dir.join(format!("{clean_name}.pub"));
    if private_path.exists() || public_path.exists() {
        return Err(VelaError::Config(format!(
            "SSH key '{clean_name}' already exists in {}",
            ssh_dir.display()
        )));
    }

    let mut private_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|err| VelaError::Config(format!("failed to generate Ed25519 key: {err}")))?;
    if !clean_comment.is_empty() {
        private_key.set_comment(clean_comment);
    }

    let private_pem = private_key
        .to_openssh(LineEnding::LF)
        .map_err(|err| VelaError::Config(format!("failed to encode private key: {err}")))?;
    let public_openssh = private_key
        .public_key()
        .to_openssh()
        .map_err(|err| VelaError::Config(format!("failed to encode public key: {err}")))?;

    {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut priv_file = opts.open(&private_path)?;
        priv_file.write_all(private_pem.as_bytes())?;
        priv_file.sync_all()?;
    }

    if let Err(err) = (|| -> std::io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o644);
        }
        let mut pub_file = opts.open(&public_path)?;
        pub_file.write_all(public_openssh.as_bytes())?;
        pub_file.write_all(b"\n")?;
        pub_file.sync_all()?;
        Ok(())
    })() {
        let _ = std::fs::remove_file(&private_path);
        return Err(VelaError::Io(err));
    }

    let (key_type, fingerprint) = parse_public_key_line(&public_openssh).ok_or_else(|| {
        VelaError::Config("generated public key failed fingerprint verification".into())
    })?;

    Ok(SshKeyInfo {
        name: clean_name.to_string(),
        private_path: private_path.to_string_lossy().into_owned(),
        public_path: public_path.to_string_lossy().into_owned(),
        public_key: public_openssh,
        fingerprint,
        key_type,
    })
}

/// Validates an OpenSSH public key line before deploying it to a remote `authorized_keys`.
pub fn validate_public_key_for_deploy(public_key: &str) -> VelaResult<String> {
    let trimmed = public_key.trim();
    if trimmed.is_empty() {
        return Err(VelaError::Config("Public key cannot be empty".into()));
    }
    if trimmed.chars().any(|c| c == '\n' || c == '\r' || c.is_control()) {
        return Err(VelaError::Config(
            "Public key must be a single line with no control characters".into(),
        ));
    }
    let mut parts = trimmed.split_whitespace();
    let key_type = parts.next().unwrap_or_default();
    let key_blob = parts.next().unwrap_or_default();
    if !(key_type.starts_with("ssh-") || key_type.starts_with("ecdsa-")) {
        return Err(VelaError::Config(
            "Public key must start with 'ssh-' or 'ecdsa-'".into(),
        ));
    }
    if key_blob.is_empty()
        || base64::engine::general_purpose::STANDARD
            .decode(key_blob)
            .is_err()
    {
        return Err(VelaError::Config(
            "Public key contains an invalid base64 key blob".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Deploys a validated OpenSSH public key to the remote user's `~/.ssh/authorized_keys`
/// idempotently using strict single-quoted shell arguments.
pub async fn deploy_public_key_remote<H: Handler>(
    handle: &Handle<H>,
    public_key: &str,
) -> VelaResult<()> {
    let validated = validate_public_key_for_deploy(public_key)?;
    let quoted = shell_single_quote(&validated);
    let cmd = format!(
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && (grep -qxF {quoted} ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' {quoted} >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys"
    );

    let outcome = tokio::time::timeout(DEPLOY_TIMEOUT, async {
        let mut channel = handle.channel_open_session().await.map_err(|err| {
            VelaError::Config(format!("failed to open exec channel for key deploy: {err}"))
        })?;
        channel
            .exec(true, cmd)
            .await
            .map_err(|err| VelaError::Config(format!("failed to run key deploy command: {err}")))?;

        let mut exit_status: Option<u32> = None;
        let mut stderr_buf = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                ChannelMsg::ExtendedData { data, .. } => {
                    if stderr_buf.len() < 1024 {
                        let take = data.len().min(1024 - stderr_buf.len());
                        stderr_buf.extend_from_slice(&data[..take]);
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<(Option<u32>, Vec<u8>), VelaError>((exit_status, stderr_buf))
    })
    .await
    .map_err(|_| VelaError::Config("timed out while deploying SSH key to server".into()))??;

    if let (Some(code), stderr_buf) = outcome
        && code != 0
    {
        let detail = String::from_utf8_lossy(&stderr_buf).trim().to_string();
        let reason = if detail.is_empty() {
            format!("remote command exited with status {code}")
        } else {
            format!("remote command exited with status {code}: {detail}")
        };
        return Err(VelaError::Config(reason));
    }

    Ok(())
}

fn validate_key_name(name: &str) -> VelaResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err(VelaError::Config(
            "Key name must be between 1 and 64 characters".into(),
        ));
    }
    if trimmed.starts_with('.') || trimmed.starts_with('-') || trimmed.ends_with(".pub") {
        return Err(VelaError::Config(
            "Key name must not start with '.' or '-', or end with '.pub'".into(),
        ));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(VelaError::Config(
            "Key name may only contain letters, digits, '.', '_', and '-'".into(),
        ));
    }
    Ok(trimmed)
}

fn parse_public_key_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    let key_type = parts.next()?;
    let blob_b64 = parts.next()?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(blob_b64)
        .ok()?;
    let digest = Sha256::digest(&blob);
    let fp = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
    Some((key_type.to_string(), format!("SHA256:{fp}")))
}

fn shell_single_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_lists_and_refuses_overwrite_of_ed25519_key()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let generated = generate_ed25519_key_in(dir.path(), "id_vela_test", "rico@vela")?;

        assert_eq!(generated.name, "id_vela_test");
        assert_eq!(generated.key_type, "ssh-ed25519");
        assert!(generated.fingerprint.starts_with("SHA256:"));
        assert!(generated.public_key.starts_with("ssh-ed25519 "));
        assert!(Path::new(&generated.private_path).is_file());
        assert!(Path::new(&generated.public_path).is_file());

        // Overwrite must be refused.
        assert!(generate_ed25519_key_in(dir.path(), "id_vela_test", "dup").is_err());

        // Invalid names must be refused.
        assert!(generate_ed25519_key_in(dir.path(), "../evil", "").is_err());
        assert!(generate_ed25519_key_in(dir.path(), "bad name", "").is_err());

        let listed = list_ssh_keys_in(dir.path())?;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].fingerprint, generated.fingerprint);
        assert_eq!(listed[0].private_path, generated.private_path);

        // Deploy validation accepts the generated key and rejects newlines / bad prefixes.
        assert!(validate_public_key_for_deploy(&generated.public_key).is_ok());
        assert!(validate_public_key_for_deploy("ssh-ed25519 AAAA\nrm -rf /").is_err());
        assert!(validate_public_key_for_deploy("rsa-invalid AAAA").is_err());
        Ok(())
    }
}
