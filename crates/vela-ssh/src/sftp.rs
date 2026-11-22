use std::cmp::Ordering;
use std::path::Path;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vela_core::{VelaError, VelaResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteEntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: RemoteEntryKind,
    pub size: u64,
    pub permissions: u32,
    pub modified_epoch: Option<u32>,
}

impl RemoteEntry {
    pub fn is_dir(&self) -> bool {
        self.kind == RemoteEntryKind::Directory
    }

    pub fn format_size(&self) -> String {
        if self.is_dir() {
            return "--".to_string();
        }
        const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
        let mut val = self.size as f64;
        let mut idx = 0;
        while val >= 1024.0 && idx < UNITS.len() - 1 {
            val /= 1024.0;
            idx += 1;
        }
        if idx == 0 {
            format!("{} {}", self.size, UNITS[idx])
        } else {
            format!("{val:.1} {}", UNITS[idx])
        }
    }

    pub fn format_permissions(&self) -> String {
        let mode = self.permissions & 0o777;
        let mut s = String::with_capacity(9);
        for shift in [6, 3, 0] {
            let bits = (mode >> shift) & 0o7;
            s.push(if bits & 4 != 0 { 'r' } else { '-' });
            s.push(if bits & 2 != 0 { 'w' } else { '-' });
            s.push(if bits & 1 != 0 { 'x' } else { '-' });
        }
        s
    }
}

pub fn join_remote_path(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", base.trim_end_matches('/'))
    }
}

pub fn parent_remote_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(idx) => trimmed[..idx].to_string(),
    }
}

pub async fn resolve_canonical_path(sftp: &SftpSession, path: &str) -> VelaResult<String> {
    sftp.canonicalize(path)
        .await
        .map_err(|err| VelaError::Sftp {
            path: path.to_string(),
            reason: err.to_string(),
        })
}

pub async fn list_remote_dir(sftp: &SftpSession, path: &str) -> VelaResult<Vec<RemoteEntry>> {
    let read_dir = sftp.read_dir(path).await.map_err(|err| VelaError::Sftp {
        path: path.to_string(),
        reason: err.to_string(),
    })?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let metadata = entry.metadata();
        let kind = match entry.file_type() {
            FileType::Dir => RemoteEntryKind::Directory,
            FileType::File => RemoteEntryKind::File,
            FileType::Symlink => RemoteEntryKind::Symlink,
            _ => RemoteEntryKind::Other,
        };
        entries.push(RemoteEntry {
            path: join_remote_path(path, &name),
            name,
            kind,
            size: metadata.size.unwrap_or(0),
            permissions: metadata.permissions.unwrap_or(0),
            modified_epoch: metadata.mtime,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir(), b.is_dir()) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

pub async fn download_file(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
) -> VelaResult<u64> {
    let mut remote = sftp.open(remote_path).await.map_err(|err| VelaError::Sftp {
        path: remote_path.to_string(),
        reason: err.to_string(),
    })?;

    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut local = tokio::fs::File::create(local_path).await?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;

    loop {
        let n = remote.read(&mut buf).await.map_err(|err| VelaError::Sftp {
            path: remote_path.to_string(),
            reason: err.to_string(),
        })?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await?;
        total += n as u64;
    }
    local.flush().await?;
    Ok(total)
}

pub async fn upload_file(
    sftp: &SftpSession,
    local_path: &Path,
    remote_path: &str,
) -> VelaResult<u64> {
    let mut local = tokio::fs::File::open(local_path).await?;
    let mut remote = sftp
        .create(remote_path)
        .await
        .map_err(|err| VelaError::Sftp {
            path: remote_path.to_string(),
            reason: err.to_string(),
        })?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;

    loop {
        let n = local.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|err| VelaError::Sftp {
                path: remote_path.to_string(),
                reason: err.to_string(),
            })?;
        total += n as u64;
    }
    remote.flush().await.map_err(|err| VelaError::Sftp {
        path: remote_path.to_string(),
        reason: err.to_string(),
    })?;
    Ok(total)
}

pub async fn create_remote_dir(sftp: &SftpSession, path: &str) -> VelaResult<()> {
    sftp.create_dir(path).await.map_err(|err| VelaError::Sftp {
        path: path.to_string(),
        reason: err.to_string(),
    })
}

pub async fn create_empty_file(sftp: &SftpSession, path: &str) -> VelaResult<()> {
    let mut file = sftp.create(path).await.map_err(|err| VelaError::Sftp {
        path: path.to_string(),
        reason: err.to_string(),
    })?;
    file.flush().await.map_err(|err| VelaError::Sftp {
        path: path.to_string(),
        reason: err.to_string(),
    })?;
    Ok(())
}

pub async fn rename_remote(
    sftp: &SftpSession,
    old_path: &str,
    new_path: &str,
) -> VelaResult<()> {
    sftp.rename(old_path, new_path)
        .await
        .map_err(|err| VelaError::Sftp {
            path: old_path.to_string(),
            reason: err.to_string(),
        })
}

pub async fn chmod_remote(sftp: &SftpSession, path: &str, mode: u32) -> VelaResult<()> {
    let attrs = FileAttributes {
        permissions: Some(mode),
        ..FileAttributes::empty()
    };
    sftp.set_metadata(path, attrs)
        .await
        .map_err(|err| VelaError::Sftp {
            path: path.to_string(),
            reason: err.to_string(),
        })
}

pub async fn delete_remote(sftp: &SftpSession, path: &str, is_dir: bool) -> VelaResult<()> {
    if !is_dir {
        return sftp
            .remove_file(path)
            .await
            .map_err(|err| VelaError::Sftp {
                path: path.to_string(),
                reason: err.to_string(),
            });
    }

    // Iterative post-order traversal for recursive directory deletion.
    let mut stack = vec![(path.to_string(), false)];
    while let Some((curr, visited)) = stack.pop() {
        if visited {
            sftp.remove_dir(&curr).await.map_err(|err| VelaError::Sftp {
                path: curr,
                reason: err.to_string(),
            })?;
            continue;
        }
        stack.push((curr.clone(), true));
        let children = list_remote_dir(sftp, &curr).await?;
        for child in children {
            if child.is_dir() {
                stack.push((child.path, false));
            } else {
                sftp.remove_file(&child.path)
                    .await
                    .map_err(|err| VelaError::Sftp {
                        path: child.path,
                        reason: err.to_string(),
                    })?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_path_helpers_handle_root_and_nested() {
        assert_eq!(join_remote_path("/", "etc"), "/etc");
        assert_eq!(join_remote_path("/srv/docker/", "compose.yml"), "/srv/docker/compose.yml");
        assert_eq!(parent_remote_path("/"), "/");
        assert_eq!(parent_remote_path("/etc"), "/");
        assert_eq!(parent_remote_path("/srv/docker/app"), "/srv/docker");
    }

    #[test]
    fn formats_permissions_and_sizes() {
        let entry = RemoteEntry {
            name: "run.sh".into(),
            path: "/run.sh".into(),
            kind: RemoteEntryKind::File,
            size: 2048,
            permissions: 0o100755,
            modified_epoch: None,
        };
        assert_eq!(entry.format_permissions(), "rwxr-xr-x");
        assert_eq!(entry.format_size(), "2.0 KB");
    }
}
