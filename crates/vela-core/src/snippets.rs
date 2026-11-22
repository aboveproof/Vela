use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{VelaError, VelaResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snippet {
    pub id: Uuid,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub auto_execute: bool,
}

impl Snippet {
    pub fn new(
        name: impl Into<String>,
        command: impl Into<String>,
        folder: Option<String>,
        auto_execute: bool,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            command: command.into(),
            folder,
            auto_execute,
        }
    }
}

/// Returns the built-in starter snippets with stable deterministic UUIDs so they
/// can be referenced or deleted even before `snippets.toml` is created on disk.
pub fn starter_snippets() -> Vec<Snippet> {
    vec![
        Snippet {
            id: Uuid::from_u128(0x7665_6c61_0001_4000_8000_0000_0000_0001),
            name: "Docker Containers".to_string(),
            command: r#"docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}""#.to_string(),
            folder: Some("Docker".to_string()),
            auto_execute: true,
        },
        Snippet {
            id: Uuid::from_u128(0x7665_6c61_0001_4000_8000_0000_0000_0002),
            name: "Disk Usage".to_string(),
            command: "df -h".to_string(),
            folder: Some("System".to_string()),
            auto_execute: true,
        },
        Snippet {
            id: Uuid::from_u128(0x7665_6c61_0001_4000_8000_0000_0000_0003),
            name: "Failed Services".to_string(),
            command: "systemctl --failed".to_string(),
            folder: Some("System".to_string()),
            auto_execute: true,
        },
        Snippet {
            id: Uuid::from_u128(0x7665_6c61_0001_4000_8000_0000_0000_0004),
            name: "Top Memory".to_string(),
            command: "ps aux --sort=-%mem | head -n 15".to_string(),
            folder: Some("System".to_string()),
            auto_execute: true,
        },
    ]
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SnippetDocument {
    #[serde(default)]
    snippets: Vec<Snippet>,
}

#[derive(Debug, Clone)]
pub struct SnippetStore {
    path: PathBuf,
}

impl SnippetStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn default_store() -> VelaResult<Self> {
        let proj = directories::ProjectDirs::from("dev", "vela", "Vela")
            .ok_or_else(|| VelaError::Config("could not resolve OS config directory".into()))?;
        Ok(Self::new(proj.config_dir().join("snippets.toml")))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> VelaResult<Vec<Snippet>> {
        if !self.path.exists() {
            return Ok(starter_snippets());
        }
        let raw = std::fs::read_to_string(&self.path)?;
        let doc: SnippetDocument = toml::from_str(&raw)
            .map_err(|err| VelaError::Config(format!("invalid snippets.toml: {err}")))?;
        Ok(doc.snippets)
    }

    /// Writes snippets atomically via a unique sibling temporary file and fsync.
    pub fn save(&self, snippets: &[Snippet]) -> VelaResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let doc = SnippetDocument {
            snippets: snippets.to_vec(),
        };
        let serialized = toml::to_string_pretty(&doc)
            .map_err(|err| VelaError::Config(format!("failed to serialize snippets: {err}")))?;

        let tmp_name = format!(".snippets.{}.tmp", Uuid::new_v4());
        let tmp_path = self.path.with_file_name(tmp_name);
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp_path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
            }
            file.write_all(serialized.as_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_starters_when_missing_and_round_trips_atomically()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let store = SnippetStore::new(dir.path().join("snippets.toml"));

        let initial = store.load()?;
        assert_eq!(initial.len(), 4);
        assert_eq!(initial[0].name, "Docker Containers");
        assert_eq!(initial[1].command, "df -h");
        assert_eq!(initial[2].command, "systemctl --failed");
        assert_eq!(initial[3].command, "ps aux --sort=-%mem | head -n 15");

        let custom = Snippet::new(
            "Tail Nginx",
            "tail -f /var/log/nginx/error.log",
            Some("Web".into()),
            false,
        );
        let mut updated = initial;
        updated.push(custom.clone());
        store.save(&updated)?;

        let reloaded = store.load()?;
        assert_eq!(reloaded, updated);
        assert_eq!(reloaded.last(), Some(&custom));
        Ok(())
    }
}
