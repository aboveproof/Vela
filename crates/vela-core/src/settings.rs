use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{VelaError, VelaResult};
use crate::theme::ThemeId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpDockPosition {
    #[default]
    Left,
    Right,
    Bottom,
    Top,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorStyle {
    #[default]
    Beam,
    Block,
    Underline,
}

impl CursorStyle {
    pub const ALL: [Self; 3] = [Self::Beam, Self::Block, Self::Underline];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Beam => "Beam",
            Self::Block => "Block",
            Self::Underline => "Underline",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub theme_id: ThemeId,
    /// `None` uses the OS default monospace font.
    #[serde(default)]
    pub terminal_font: Option<String>,
    #[serde(default = "default_font_size")]
    pub terminal_font_size: f32,
    #[serde(default)]
    pub cursor_style: CursorStyle,
    #[serde(default = "default_scrollback")]
    pub scrollback_lines: usize,
    #[serde(default)]
    pub copy_on_select: bool,
    #[serde(default)]
    pub right_click_paste: bool,
    #[serde(default = "default_true")]
    pub show_hidden_files: bool,
    #[serde(default = "default_true")]
    pub follow_terminal_folder: bool,
    #[serde(default = "default_true")]
    pub remote_monitoring: bool,
    #[serde(default)]
    pub sftp_position: SftpDockPosition,
}

const fn default_font_size() -> f32 {
    14.0
}

const fn default_scrollback() -> usize {
    10_000
}

const fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_id: ThemeId::Obsidian,
            terminal_font: None,
            terminal_font_size: default_font_size(),
            cursor_style: CursorStyle::Beam,
            scrollback_lines: default_scrollback(),
            copy_on_select: false,
            right_click_paste: false,
            show_hidden_files: true,
            follow_terminal_folder: true,
            remote_monitoring: true,
            sftp_position: SftpDockPosition::Left,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn default_store() -> VelaResult<Self> {
        let proj = directories::ProjectDirs::from("dev", "vela", "Vela")
            .ok_or_else(|| VelaError::Config("could not resolve OS config directory".into()))?;
        Ok(Self::new(proj.config_dir().join("settings.toml")))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> VelaResult<AppSettings> {
        if !self.path.exists() {
            return Ok(AppSettings::default());
        }
        let raw = std::fs::read_to_string(&self.path)?;
        toml::from_str(&raw)
            .map_err(|err| VelaError::Config(format!("invalid settings.toml: {err}")))
    }

    pub fn save(&self, settings: &AppSettings) -> VelaResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let serialized = toml::to_string_pretty(settings)
            .map_err(|err| VelaError::Config(format!("failed to serialize settings: {err}")))?;
        let tmp = self.path.with_extension("toml.tmp");
        std::fs::write(&tmp, serialized)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_settings_with_system_default_font() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let store = SettingsStore::new(dir.path().join("settings.toml"));

        let defaults = store.load()?;
        assert_eq!(defaults.terminal_font, None);
        assert!((defaults.terminal_font_size - 14.0).abs() < f32::EPSILON);

        let updated = AppSettings {
            theme_id: ThemeId::TokyoNight,
            terminal_font: Some("Cascadia Mono".into()),
            terminal_font_size: 15.0,
            cursor_style: CursorStyle::Block,
            scrollback_lines: 25_000,
            copy_on_select: true,
            right_click_paste: false,
            show_hidden_files: false,
            follow_terminal_folder: true,
            remote_monitoring: false,
            sftp_position: SftpDockPosition::Right,
        };
        store.save(&updated)?;
        assert_eq!(store.load()?, updated);
        Ok(())
    }
}
