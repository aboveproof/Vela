use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{VelaError, VelaResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostKeyStatus {
    Trusted,
    Unknown {
        fingerprint: String,
    },
    Mismatch {
        expected: String,
        actual: String,
    },
}

/// Computes an OpenSSH-style `SHA256:...` fingerprint from raw public key bytes.
pub fn sha256_fingerprint(key_blob: &[u8]) -> String {
    let digest = Sha256::digest(key_blob);
    let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest);
    format!("SHA256:{encoded}")
}

#[derive(Debug, Clone)]
pub struct KnownHostsStore {
    path: PathBuf,
}

impl KnownHostsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn default_store() -> VelaResult<Self> {
        let proj = directories::ProjectDirs::from("dev", "vela", "Vela")
            .ok_or_else(|| VelaError::Config("could not resolve OS config directory".into()))?;
        Ok(Self::new(proj.config_dir().join("known_hosts")))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn host_entry_key(host: &str, port: u16) -> String {
        if port == 22 {
            host.to_lowercase()
        } else {
            format!("[{}]:{port}", host.to_lowercase())
        }
    }

    fn read_entries(&self) -> VelaResult<BTreeMap<String, String>> {
        if !self.path.exists() {
            return Ok(BTreeMap::new());
        }
        let content = std::fs::read_to_string(&self.path)?;
        let mut map = BTreeMap::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let mut parts = trimmed.split_whitespace();
            if let (Some(host_key), Some(fingerprint)) = (parts.next(), parts.next()) {
                map.insert(host_key.to_string(), fingerprint.to_string());
            }
        }
        Ok(map)
    }

    fn write_entries(&self, entries: &BTreeMap<String, String>) -> VelaResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = String::from("# Vela trusted SSH host fingerprints\n");
        for (host_key, fp) in entries {
            out.push_str(host_key);
            out.push(' ');
            out.push_str(fp);
            out.push('\n');
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, out)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn verify(&self, host: &str, port: u16, fingerprint: &str) -> VelaResult<HostKeyStatus> {
        let entries = self.read_entries()?;
        let key = Self::host_entry_key(host, port);
        match entries.get(&key) {
            None => Ok(HostKeyStatus::Unknown {
                fingerprint: fingerprint.to_string(),
            }),
            Some(expected) if expected == fingerprint => Ok(HostKeyStatus::Trusted),
            Some(expected) => Ok(HostKeyStatus::Mismatch {
                expected: expected.clone(),
                actual: fingerprint.to_string(),
            }),
        }
    }

    pub fn trust(&self, host: &str, port: u16, fingerprint: &str) -> VelaResult<()> {
        let mut entries = self.read_entries()?;
        entries.insert(Self::host_entry_key(host, port), fingerprint.to_string());
        self.write_entries(&entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tofu_unknown_trust_and_mismatch_flow() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let store = KnownHostsStore::new(dir.path().join("known_hosts"));

        let fp1 = sha256_fingerprint(b"ssh-ed25519-key-v1");
        let fp2 = sha256_fingerprint(b"ssh-ed25519-key-v2");

        assert_eq!(
            store.verify("homeserver.local", 22, &fp1)?,
            HostKeyStatus::Unknown {
                fingerprint: fp1.clone()
            }
        );

        store.trust("homeserver.local", 22, &fp1)?;
        assert_eq!(
            store.verify("homeserver.local", 22, &fp1)?,
            HostKeyStatus::Trusted
        );

        assert_eq!(
            store.verify("homeserver.local", 22, &fp2)?,
            HostKeyStatus::Mismatch {
                expected: fp1,
                actual: fp2.clone()
            }
        );

        store.trust("homeserver.local", 22, &fp2)?;
        assert_eq!(
            store.verify("homeserver.local", 22, &fp2)?,
            HostKeyStatus::Trusted
        );
        Ok(())
    }
}
