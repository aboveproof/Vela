use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{VelaError, VelaResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    PrivateKey { path: PathBuf },
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostProfile {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub default_remote_path: Option<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u64,
    #[serde(default)]
    pub bookmarks: Vec<String>,
}

const fn default_keepalive() -> u64 {
    30
}

impl HostProfile {
    pub fn new(
        name: impl Into<String>,
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
        auth: AuthMethod,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            host: host.into(),
            port,
            username: username.into(),
            auth,
            folder: None,
            default_remote_path: None,
            keepalive_secs: default_keepalive(),
            bookmarks: Vec::new(),
        }
    }

    pub fn secret_key(&self) -> String {
        format!("host:{}", self.id)
    }

    pub fn display_address(&self) -> String {
        if self.port == 22 {
            format!("{}@{}", self.username, self.host)
        } else {
            format!("{}@{}:{}", self.username, self.host, self.port)
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProfileDocument {
    #[serde(default)]
    profiles: Vec<HostProfile>,
}

#[derive(Debug, Clone)]
pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn default_store() -> VelaResult<Self> {
        let proj = directories::ProjectDirs::from("dev", "vela", "Vela")
            .ok_or_else(|| VelaError::Config("could not resolve OS config directory".into()))?;
        Ok(Self::new(proj.config_dir().join("hosts.toml")))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> VelaResult<Vec<HostProfile>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = std::fs::read_to_string(&self.path)?;
        let doc: ProfileDocument = toml::from_str(&raw)
            .map_err(|err| VelaError::Config(format!("invalid hosts.toml: {err}")))?;
        Ok(doc.profiles)
    }

    /// Writes profiles atomically via a sibling temporary file to prevent corruption.
    pub fn save(&self, profiles: &[HostProfile]) -> VelaResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let doc = ProfileDocument {
            profiles: profiles.to_vec(),
        };
        let serialized = toml::to_string_pretty(&doc)
            .map_err(|err| VelaError::Config(format!("failed to serialize profiles: {err}")))?;

        let tmp_path = self.path.with_extension("toml.tmp");
        std::fs::write(&tmp_path, serialized)?;
        std::fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_profiles_atomically() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let store = ProfileStore::new(dir.path().join("hosts.toml"));

        assert!(store.load()?.is_empty());

        let mut p1 = HostProfile::new(
            "Homeserver",
            "192.168.1.218",
            22,
            "rico",
            AuthMethod::PrivateKey {
                path: PathBuf::from("/home/rico/.ssh/id_ed25519"),
            },
        );
        p1.folder = Some("Homelab".into());
        p1.bookmarks = vec!["/srv/docker".into(), "/etc/nginx".into()];

        let p2 = HostProfile::new("NAS", "192.168.1.50", 2222, "admin", AuthMethod::Password);
        store.save(&[p1.clone(), p2.clone()])?;

        let loaded = store.load()?;
        assert_eq!(loaded, vec![p1, p2]);
        Ok(())
    }
}
