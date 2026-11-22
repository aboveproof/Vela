use std::path::{Path, PathBuf};

use crate::error::VelaResult;
use crate::profile::{AuthMethod, HostProfile};

#[derive(Debug, Default, Clone)]
struct RawBlock {
    aliases: Vec<String>,
    is_global_wildcard: bool,
    hostname: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    identity_file: Option<String>,
}

/// Reads and parses the user's default `~/.ssh/config` file.
/// Returns an empty list if `~/.ssh/config` does not exist.
pub fn read_default_ssh_config() -> VelaResult<Vec<HostProfile>> {
    let Some(base) = directories::BaseDirs::new() else {
        return Ok(Vec::new());
    };
    let home = base.home_dir();
    let config_path = home.join(".ssh").join("config");
    if !config_path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&config_path)?;
    let default_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".to_string());

    Ok(parse_ssh_config_str(&content, Some(home), &default_user))
}

/// Pure-Rust parser for OpenSSH client config files (`Host`, `HostName`, `Port`, `User`, `IdentityFile`).
/// Skips wildcard entries (`*`, `?`, `!`) while honoring `Host *` fallback defaults.
pub fn parse_ssh_config_str(
    content: &str,
    home_dir: Option<&Path>,
    default_user: &str,
) -> Vec<HostProfile> {
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut current: Option<RawBlock> = None;

    for raw_line in content.lines() {
        let line = strip_comment(raw_line).trim();
        if line.is_empty() {
            continue;
        }
        let Some((keyword, value)) = split_directive(line) else {
            continue;
        };

        if keyword.eq_ignore_ascii_case("host") {
            if let Some(prev) = current.take() {
                blocks.push(prev);
            }
            let tokens = split_tokens(value);
            let is_global_wildcard = tokens.iter().any(|t| t == "*");
            let aliases: Vec<String> = tokens
                .into_iter()
                .filter(|t| !is_pattern_token(t))
                .collect();
            current = Some(RawBlock {
                aliases,
                is_global_wildcard,
                ..RawBlock::default()
            });
            continue;
        }

        if keyword.eq_ignore_ascii_case("match") {
            if let Some(prev) = current.take() {
                blocks.push(prev);
            }
            continue;
        }

        let Some(block) = current.as_mut() else {
            continue;
        };

        let val = unquote(value.trim());
        if val.is_empty() {
            continue;
        }

        if keyword.eq_ignore_ascii_case("hostname") {
            if block.hostname.is_none() {
                block.hostname = Some(val.to_string());
            }
        } else if keyword.eq_ignore_ascii_case("port") {
            if block.port.is_none()
                && let Ok(p) = val.parse::<u16>()
                && p > 0
            {
                block.port = Some(p);
            }
        } else if keyword.eq_ignore_ascii_case("user") {
            if block.user.is_none() {
                block.user = Some(val.to_string());
            }
        } else if keyword.eq_ignore_ascii_case("identityfile") && block.identity_file.is_none() {
            block.identity_file = Some(val.to_string());
        }
    }

    if let Some(last) = current {
        blocks.push(last);
    }

    let mut global_port: Option<u16> = None;
    let mut global_user: Option<String> = None;
    let mut global_identity: Option<String> = None;

    for block in &blocks {
        if block.is_global_wildcard {
            if global_port.is_none() {
                global_port = block.port;
            }
            if global_user.is_none() {
                global_user = block.user.clone();
            }
            if global_identity.is_none() {
                global_identity = block.identity_file.clone();
            }
        }
    }

    let mut profiles = Vec::new();
    for block in blocks {
        for alias in block.aliases {
            let host = block.hostname.clone().unwrap_or_else(|| alias.clone());
            if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
                continue;
            }
            let port = block.port.or(global_port).unwrap_or(22);
            let username = block
                .user
                .clone()
                .or_else(|| global_user.clone())
                .unwrap_or_else(|| default_user.to_string());

            let identity = block
                .identity_file
                .as_deref()
                .or(global_identity.as_deref());
            let auth = match identity {
                Some(raw_path) => AuthMethod::PrivateKey {
                    path: expand_tilde(raw_path, home_dir),
                },
                None => AuthMethod::Password,
            };

            let mut profile = HostProfile::new(alias, host, port, username, auth);
            profile.folder = Some("SSH Config".to_string());
            profiles.push(profile);
        }
    }

    profiles
}

fn is_pattern_token(token: &str) -> bool {
    token.is_empty() || token.contains('*') || token.contains('?') || token.starts_with('!')
}

fn strip_comment(line: &str) -> &str {
    let mut in_quotes = false;
    for (idx, ch) in line.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '#' if !in_quotes => return &line[..idx],
            _ => {}
        }
    }
    line
}

fn split_directive(line: &str) -> Option<(&str, &str)> {
    let mut split_idx = None;
    for (idx, ch) in line.char_indices() {
        if ch.is_whitespace() || ch == '=' {
            split_idx = Some(idx);
            break;
        }
    }
    let idx = split_idx?;
    let key = &line[..idx];
    let rest = line[idx..].trim_start();
    let val = rest.strip_prefix('=').unwrap_or(rest).trim_start();
    if key.is_empty() || val.is_empty() {
        return None;
    }
    Some((key, val))
}

fn split_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for ch in input.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn unquote(s: &str) -> &str {
    s.strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(s)
}

fn expand_tilde(raw: &str, home_dir: Option<&Path>) -> PathBuf {
    if let Some(home) = home_dir {
        if raw == "~" {
            return home.to_path_buf();
        }
        if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts_expands_tilde_and_skips_wildcards() {
        let sample = r#"
# Homelab config
Host homeserver
    HostName 192.168.1.218
    Port 2222
    User rico
    IdentityFile ~/.ssh/id_ed25519

Host db-prod db-replica
    HostName=10.0.0.40
    User=postgres

Host *.internal prod-? !excluded
    User ops

Host *
    User fallback
    IdentityFile "~/.ssh/default_key"
"#;

        let home = PathBuf::from("/home/rico");
        let parsed = parse_ssh_config_str(sample, Some(&home), "localuser");

        assert_eq!(parsed.len(), 3);

        assert_eq!(parsed[0].name, "homeserver");
        assert_eq!(parsed[0].host, "192.168.1.218");
        assert_eq!(parsed[0].port, 2222);
        assert_eq!(parsed[0].username, "rico");
        assert_eq!(
            parsed[0].auth,
            AuthMethod::PrivateKey {
                path: home.join(".ssh/id_ed25519")
            }
        );
        assert_eq!(parsed[0].folder.as_deref(), Some("SSH Config"));

        assert_eq!(parsed[1].name, "db-prod");
        assert_eq!(parsed[1].host, "10.0.0.40");
        assert_eq!(parsed[1].port, 22);
        assert_eq!(parsed[1].username, "postgres");
        assert_eq!(
            parsed[1].auth,
            AuthMethod::PrivateKey {
                path: home.join(".ssh/default_key")
            }
        );

        assert_eq!(parsed[2].name, "db-replica");
        assert_eq!(parsed[2].host, "10.0.0.40");
    }
}
