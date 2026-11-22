use std::cmp::Ordering;
use std::path::{Component, Path};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
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

/// Validates a single remote filename (no slashes, traversal, NUL, or control chars).
pub fn validate_remote_entry_name(name: &str) -> VelaResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || trimmed.chars().any(char::is_control)
    {
        return Err(VelaError::Sftp {
            path: name.to_string(),
            reason: "invalid file or directory name".to_string(),
        });
    }
    Ok(trimmed)
}

/// Strictly sanitizes a remote filename before writing it into a local temp directory.
pub fn sanitize_local_filename(remote_path: &str) -> VelaResult<String> {
    let raw = remote_path
        .rsplit('/')
        .next()
        .ok_or_else(|| VelaError::Sftp {
            path: remote_path.to_string(),
            reason: "remote path has no filename".to_string(),
        })?;

    if raw.is_empty()
        || raw == "."
        || raw == ".."
        || raw.contains('/')
        || raw.contains('\\')
        || raw.contains(':')
        || raw.contains('\0')
        || raw.chars().any(char::is_control)
    {
        return Err(VelaError::Sftp {
            path: remote_path.to_string(),
            reason: "unsafe filename for local editing".to_string(),
        });
    }

    let stem = raw
        .split('.')
        .next()
        .unwrap_or(raw)
        .to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err(VelaError::Sftp {
            path: remote_path.to_string(),
            reason: "filename matches a reserved OS device name".to_string(),
        });
    }

    let mut comps = Path::new(raw).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => Ok(raw.to_string()),
        _ => Err(VelaError::Sftp {
            path: remote_path.to_string(),
            reason: "filename is not a single safe path component".to_string(),
        }),
    }
}

/// Returns true if passing this filename to OS `open::that` could execute code instead of opening an editor.
pub fn is_dangerous_executable_ext(filename: &str) -> bool {
    let Some(ext) = Path::new(filename).extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let lower = ext.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "exe"
            | "bat"
            | "cmd"
            | "com"
            | "msi"
            | "msp"
            | "ps1"
            | "psm1"
            | "vbs"
            | "vbe"
            | "js"
            | "jse"
            | "wsf"
            | "wsh"
            | "hta"
            | "lnk"
            | "scr"
            | "pif"
            | "cpl"
            | "reg"
            | "dll"
            | "sys"
            | "app"
            | "command"
            | "dmg"
            | "pkg"
            | "appimage"
    )
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
        Some(0) => "/".to_string(),
        Some(idx) => trimmed[..idx].to_string(),
        None => ".".to_string(),
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

pub async fn is_remote_dir(sftp: &SftpSession, path: &str) -> VelaResult<bool> {
    let meta = sftp.metadata(path).await.map_err(|err| VelaError::Sftp {
        path: path.to_string(),
        reason: err.to_string(),
    })?;
    Ok(meta.is_dir())
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = local
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .await;
    }

    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;

    let copy_res: VelaResult<u64> = async {
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
    .await;

    if copy_res.is_err() {
        drop(local);
        let _ = tokio::fs::remove_file(local_path).await;
    }
    copy_res
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
    let _ = remote.shutdown().await;
    Ok(total)
}

/// Uploads a local file or recursively uploads a local directory into `remote_path`.
pub async fn upload_path_recursive(
    sftp: &SftpSession,
    local_path: &Path,
    remote_path: &str,
) -> VelaResult<(u64, usize)> {
    let meta = tokio::fs::metadata(local_path).await?;
    if !meta.is_dir() {
        let bytes = upload_file(sftp, local_path, remote_path).await?;
        return Ok((bytes, 1));
    }

    let mut total_bytes = 0u64;
    let mut file_count = 0usize;
    let mut stack = vec![(local_path.to_path_buf(), remote_path.to_string())];

    while let Some((curr_local, curr_remote)) = stack.pop() {
        // Ignore error if directory already exists.
        let _ = sftp.create_dir(&curr_remote).await;
        let mut rd = tokio::fs::read_dir(&curr_local).await?;
        while let Some(entry) = rd.next_entry().await? {
            let entry_path = entry.path();
            let entry_meta = tokio::fs::symlink_metadata(&entry_path).await?;
            if entry_meta.file_type().is_symlink() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if validate_remote_entry_name(&name).is_err() {
                continue;
            }
            let target_remote = join_remote_path(&curr_remote, &name);
            if entry_meta.is_dir() {
                stack.push((entry_path, target_remote));
            } else if entry_meta.is_file() {
                total_bytes += upload_file(sftp, &entry_path, &target_remote).await?;
                file_count += 1;
            }
        }
    }

    Ok((total_bytes, file_count))
}

pub async fn create_remote_dir(sftp: &SftpSession, path: &str) -> VelaResult<()> {
    sftp.create_dir(path).await.map_err(|err| VelaError::Sftp {
        path: path.to_string(),
        reason: err.to_string(),
    })
}

/// Creates a new empty file without truncating an existing file (`O_CREAT | O_EXCL`).
pub async fn create_empty_file(sftp: &SftpSession, path: &str) -> VelaResult<()> {
    let mut file = sftp
        .open_with_flags(
            path,
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await
        .map_err(|err| VelaError::Sftp {
            path: path.to_string(),
            reason: err.to_string(),
        })?;
    file.flush().await.map_err(|err| VelaError::Sftp {
        path: path.to_string(),
        reason: err.to_string(),
    })?;
    let _ = file.shutdown().await;
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

/// Safely deletes a remote file, symlink, or directory (recursively).
/// Never follows a top-level symlink and never deletes `/`.
pub async fn delete_remote(sftp: &SftpSession, path: &str) -> VelaResult<()> {
    let normalized = path.trim();
    if normalized.is_empty() || normalized == "/" || normalized == "." || normalized == ".." {
        return Err(VelaError::Sftp {
            path: path.to_string(),
            reason: "refusing to delete root or relative path".to_string(),
        });
    }

    let lstat = sftp
        .symlink_metadata(normalized)
        .await
        .map_err(|err| VelaError::Sftp {
            path: normalized.to_string(),
            reason: err.to_string(),
        })?;

    // Symlinks (even pointing to directories) are always unlinked, never recursed into.
    if lstat.file_type() == FileType::Symlink || !lstat.is_dir() {
        return sftp
            .remove_file(normalized)
            .await
            .map_err(|err| VelaError::Sftp {
                path: normalized.to_string(),
                reason: err.to_string(),
            });
    }

    let mut stack = vec![(normalized.to_string(), false)];
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
        assert_eq!(
            join_remote_path("/srv/docker/", "compose.yml"),
            "/srv/docker/compose.yml"
        );
        assert_eq!(parent_remote_path("/"), "/");
        assert_eq!(parent_remote_path("/etc"), "/");
        assert_eq!(parent_remote_path("/srv/docker/app"), "/srv/docker");
        assert_eq!(parent_remote_path("foo"), ".");
    }

    #[test]
    fn sanitizes_and_blocks_traversal_and_executables() {
        assert!(sanitize_local_filename("/home/rico/config.yaml").is_ok());
        assert!(sanitize_local_filename("/tmp/..\\..\\evil.bat").is_err());
        assert!(sanitize_local_filename("/tmp/C:evil.txt").is_err());
        assert!(sanitize_local_filename("/tmp/CON.txt").is_err());
        assert!(is_dangerous_executable_ext("payload.bat"));
        assert!(is_dangerous_executable_ext("setup.EXE"));
        assert!(!is_dangerous_executable_ext("docker-compose.yml"));
        assert!(validate_remote_entry_name("../etc").is_err());
        assert!(validate_remote_entry_name("ok_file.txt").is_ok());
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
