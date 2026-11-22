use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    pub fn as_f32_array(self) -> [f32; 3] {
        [
            f32::from(self.r) / 255.0,
            f32::from(self.g) / 255.0,
            f32::from(self.b) / 255.0,
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeId {
    #[default]
    Obsidian,
    CatppuccinMocha,
    TokyoNight,
    Nord,
}

impl ThemeId {
    pub const ALL: [Self; 4] = [
        Self::Obsidian,
        Self::CatppuccinMocha,
        Self::TokyoNight,
        Self::Nord,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Obsidian => "Vela Obsidian",
            Self::CatppuccinMocha => "Catppuccin Mocha",
            Self::TokyoNight => "Tokyo Night",
            Self::Nord => "Nord",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AnsiPalette {
    pub normal: [Rgb; 8],
    pub bright: [Rgb; 8],
}

#[derive(Debug, Clone, Copy)]
pub struct VelaTheme {
    pub id: ThemeId,
    pub bg_base: Rgb,
    pub bg_surface: Rgb,
    pub bg_elevated: Rgb,
    pub border: Rgb,
    pub text_primary: Rgb,
    pub text_muted: Rgb,
    pub accent: Rgb,
    pub success: Rgb,
    pub warning: Rgb,
    pub danger: Rgb,
    pub terminal_bg: Rgb,
    pub terminal_fg: Rgb,
    pub cursor: Rgb,
    pub selection: Rgb,
    pub ansi: AnsiPalette,
}

impl VelaTheme {
    pub const fn from_id(id: ThemeId) -> Self {
        match id {
            ThemeId::Obsidian => Self::obsidian(),
            ThemeId::CatppuccinMocha => Self::catppuccin_mocha(),
            ThemeId::TokyoNight => Self::tokyo_night(),
            ThemeId::Nord => Self::nord(),
        }
    }

    /// Clean, restrained dark charcoal theme with neutral surfaces and no neon accents.
    pub const fn obsidian() -> Self {
        Self {
            id: ThemeId::Obsidian,
            bg_base: Rgb::new(18, 19, 21),
            bg_surface: Rgb::new(24, 25, 28),
            bg_elevated: Rgb::new(36, 38, 43),
            border: Rgb::new(46, 49, 55),
            text_primary: Rgb::new(228, 230, 234),
            text_muted: Rgb::new(138, 143, 152),
            accent: Rgb::new(164, 174, 190),
            success: Rgb::new(98, 184, 126),
            warning: Rgb::new(212, 167, 74),
            danger: Rgb::new(214, 96, 104),
            terminal_bg: Rgb::new(16, 17, 19),
            terminal_fg: Rgb::new(224, 226, 230),
            cursor: Rgb::new(228, 230, 234),
            selection: Rgb::new(56, 64, 78),
            ansi: AnsiPalette {
                normal: [
                    Rgb::new(40, 42, 48),
                    Rgb::new(214, 96, 104),
                    Rgb::new(98, 184, 126),
                    Rgb::new(218, 178, 88),
                    Rgb::new(104, 154, 212),
                    Rgb::new(178, 128, 206),
                    Rgb::new(92, 178, 186),
                    Rgb::new(200, 204, 212),
                ],
                bright: [
                    Rgb::new(98, 104, 114),
                    Rgb::new(232, 122, 128),
                    Rgb::new(124, 206, 148),
                    Rgb::new(236, 198, 112),
                    Rgb::new(132, 178, 232),
                    Rgb::new(198, 154, 224),
                    Rgb::new(118, 202, 210),
                    Rgb::new(238, 240, 244),
                ],
            },
        }
    }

    pub const fn catppuccin_mocha() -> Self {
        Self {
            id: ThemeId::CatppuccinMocha,
            bg_base: Rgb::new(17, 17, 27),
            bg_surface: Rgb::new(24, 24, 37),
            bg_elevated: Rgb::new(30, 30, 46),
            border: Rgb::new(49, 50, 68),
            text_primary: Rgb::new(205, 214, 244),
            text_muted: Rgb::new(147, 153, 178),
            accent: Rgb::new(137, 180, 250),
            success: Rgb::new(166, 227, 161),
            warning: Rgb::new(249, 226, 175),
            danger: Rgb::new(243, 139, 168),
            terminal_bg: Rgb::new(20, 20, 31),
            terminal_fg: Rgb::new(205, 214, 244),
            cursor: Rgb::new(245, 224, 220),
            selection: Rgb::new(69, 71, 90),
            ansi: AnsiPalette {
                normal: [
                    Rgb::new(69, 71, 90),
                    Rgb::new(243, 139, 168),
                    Rgb::new(166, 227, 161),
                    Rgb::new(249, 226, 175),
                    Rgb::new(137, 180, 250),
                    Rgb::new(245, 194, 231),
                    Rgb::new(148, 226, 213),
                    Rgb::new(186, 194, 222),
                ],
                bright: [
                    Rgb::new(88, 91, 112),
                    Rgb::new(243, 139, 168),
                    Rgb::new(166, 227, 161),
                    Rgb::new(249, 226, 175),
                    Rgb::new(137, 180, 250),
                    Rgb::new(245, 194, 231),
                    Rgb::new(148, 226, 213),
                    Rgb::new(166, 173, 200),
                ],
            },
        }
    }

    pub const fn tokyo_night() -> Self {
        Self {
            id: ThemeId::TokyoNight,
            bg_base: Rgb::new(22, 22, 30),
            bg_surface: Rgb::new(26, 27, 38),
            bg_elevated: Rgb::new(36, 40, 59),
            border: Rgb::new(59, 66, 97),
            text_primary: Rgb::new(192, 202, 245),
            text_muted: Rgb::new(120, 124, 153),
            accent: Rgb::new(122, 162, 247),
            success: Rgb::new(158, 206, 106),
            warning: Rgb::new(224, 175, 104),
            danger: Rgb::new(247, 118, 142),
            terminal_bg: Rgb::new(26, 27, 38),
            terminal_fg: Rgb::new(192, 202, 245),
            cursor: Rgb::new(192, 202, 245),
            selection: Rgb::new(51, 70, 124),
            ansi: AnsiPalette {
                normal: [
                    Rgb::new(21, 22, 30),
                    Rgb::new(247, 118, 142),
                    Rgb::new(158, 206, 106),
                    Rgb::new(224, 175, 104),
                    Rgb::new(122, 162, 247),
                    Rgb::new(187, 154, 247),
                    Rgb::new(125, 207, 255),
                    Rgb::new(169, 177, 214),
                ],
                bright: [
                    Rgb::new(65, 72, 104),
                    Rgb::new(247, 118, 142),
                    Rgb::new(158, 206, 106),
                    Rgb::new(224, 175, 104),
                    Rgb::new(122, 162, 247),
                    Rgb::new(187, 154, 247),
                    Rgb::new(125, 207, 255),
                    Rgb::new(192, 202, 245),
                ],
            },
        }
    }

    pub const fn nord() -> Self {
        Self {
            id: ThemeId::Nord,
            bg_base: Rgb::new(36, 41, 51),
            bg_surface: Rgb::new(46, 52, 64),
            bg_elevated: Rgb::new(59, 66, 82),
            border: Rgb::new(76, 86, 106),
            text_primary: Rgb::new(236, 239, 244),
            text_muted: Rgb::new(147, 161, 181),
            accent: Rgb::new(136, 192, 208),
            success: Rgb::new(163, 190, 140),
            warning: Rgb::new(235, 203, 139),
            danger: Rgb::new(191, 97, 106),
            terminal_bg: Rgb::new(46, 52, 64),
            terminal_fg: Rgb::new(216, 222, 233),
            cursor: Rgb::new(216, 222, 233),
            selection: Rgb::new(67, 76, 94),
            ansi: AnsiPalette {
                normal: [
                    Rgb::new(59, 66, 82),
                    Rgb::new(191, 97, 106),
                    Rgb::new(163, 190, 140),
                    Rgb::new(235, 203, 139),
                    Rgb::new(129, 161, 193),
                    Rgb::new(180, 142, 173),
                    Rgb::new(136, 192, 208),
                    Rgb::new(229, 233, 240),
                ],
                bright: [
                    Rgb::new(76, 86, 106),
                    Rgb::new(191, 97, 106),
                    Rgb::new(163, 190, 140),
                    Rgb::new(235, 203, 139),
                    Rgb::new(129, 161, 193),
                    Rgb::new(180, 142, 173),
                    Rgb::new(143, 188, 187),
                    Rgb::new(236, 239, 244),
                ],
            },
        }
    }
}
