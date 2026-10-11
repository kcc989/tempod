//! Terminal colours. Foreground, background, cursor and selection come from the GPUI Kit
//! theme; only the 16-colour ANSI palette is literal (07, Window layout).
use alacritty_terminal::term::color::{COUNT, Colors};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui_kit::Hsla;
use gpui_kit::component::ThemeColor;

/// The Tango palette that gpui-terminal 0.1.0 shipped with: normal 0-7, bright 8-15.
const ANSI: [(u8, u8, u8); 16] = [
    (0x00, 0x00, 0x00),
    (0xcc, 0x00, 0x00),
    (0x4e, 0x9a, 0x06),
    (0xc4, 0xa0, 0x00),
    (0x34, 0x65, 0xa4),
    (0x75, 0x50, 0x7b),
    (0x06, 0x98, 0x9a),
    (0xd3, 0xd7, 0xcf),
    (0x55, 0x57, 0x53),
    (0xef, 0x29, 0x29),
    (0x8a, 0xe2, 0x34),
    (0xfc, 0xe9, 0x4f),
    (0x72, 0x9f, 0xcf),
    (0xad, 0x7f, 0xa8),
    (0x34, 0xe2, 0xe2),
    (0xee, 0xee, 0xec),
];

/// The colours the theme supplies.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ThemeColors {
    pub foreground: Hsla,
    pub background: Hsla,
    pub cursor: Hsla,
    pub selection: Hsla,
}

impl ThemeColors {
    pub fn from_theme(theme: &ThemeColor) -> Self {
        Self {
            foreground: theme.foreground,
            background: theme.background,
            cursor: theme.caret,
            selection: theme.selection,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ColorPalette {
    extended: [Hsla; 256],
    theme: ThemeColors,
}

impl ColorPalette {
    pub fn new(theme: ThemeColors) -> Self {
        let mut extended = [Hsla::default(); 256];
        for (slot, (r, g, b)) in extended.iter_mut().zip(ANSI) {
            *slot = rgb_to_hsla(Rgb { r, g, b });
        }
        let level = |n: u8| if n == 0 { 0 } else { 55 + n * 40 };
        let mut idx = 16;
        for r in 0..6 {
            for g in 0..6 {
                for b in 0..6 {
                    extended[idx] = rgb_to_hsla(Rgb {
                        r: level(r),
                        g: level(g),
                        b: level(b),
                    });
                    idx += 1;
                }
            }
        }
        for (i, slot) in extended[232..].iter_mut().enumerate() {
            let gray = 8 + 10 * i as u8;
            *slot = rgb_to_hsla(Rgb {
                r: gray,
                g: gray,
                b: gray,
            });
        }
        Self { extended, theme }
    }

    pub fn from_theme(theme: &ThemeColor) -> Self {
        Self::new(ThemeColors::from_theme(theme))
    }

    pub fn foreground(&self) -> Hsla {
        self.theme.foreground
    }

    pub fn background(&self) -> Hsla {
        self.theme.background
    }

    pub fn cursor(&self) -> Hsla {
        self.theme.cursor
    }

    pub fn selection(&self) -> Hsla {
        self.theme.selection
    }

    /// Resolves a cell colour. Colours the program set with OSC 4, 10, 11 or 12 win.
    pub fn resolve(&self, color: Color, overrides: &Colors) -> Hsla {
        match color {
            Color::Spec(rgb) => rgb_to_hsla(rgb),
            Color::Indexed(idx) => match overrides[usize::from(idx)] {
                Some(rgb) => rgb_to_hsla(rgb),
                None => self.extended[usize::from(idx)],
            },
            Color::Named(named) => {
                if let Some(rgb) = overrides[named] {
                    return rgb_to_hsla(rgb);
                }
                self.named(named)
            }
        }
    }

    fn named(&self, named: NamedColor) -> Hsla {
        let idx = named as usize;
        if idx < 16 {
            return self.extended[idx];
        }
        match named {
            NamedColor::Foreground | NamedColor::BrightForeground => self.theme.foreground,
            NamedColor::Background => self.theme.background,
            NamedColor::Cursor => self.theme.cursor,
            NamedColor::DimForeground => dim(self.theme.foreground),
            NamedColor::DimBlack => dim(self.extended[0]),
            NamedColor::DimRed => dim(self.extended[1]),
            NamedColor::DimGreen => dim(self.extended[2]),
            NamedColor::DimYellow => dim(self.extended[3]),
            NamedColor::DimBlue => dim(self.extended[4]),
            NamedColor::DimMagenta => dim(self.extended[5]),
            NamedColor::DimCyan => dim(self.extended[6]),
            NamedColor::DimWhite => dim(self.extended[7]),
            _ => self.theme.foreground,
        }
    }

    /// For OSC 4, 10, 11 and 12 queries.
    pub fn rgb(&self, index: usize, overrides: &Colors) -> Option<Rgb> {
        if index >= COUNT {
            return None;
        }
        if let Some(rgb) = overrides[index] {
            return Some(rgb);
        }
        let color = if index < 256 {
            self.extended[index]
        } else if index == NamedColor::Foreground as usize {
            self.theme.foreground
        } else if index == NamedColor::Background as usize {
            self.theme.background
        } else if index == NamedColor::Cursor as usize {
            self.theme.cursor
        } else {
            return None;
        };
        Some(hsla_to_rgb(color))
    }
}

pub fn dim(mut color: Hsla) -> Hsla {
    color.l *= 0.7;
    color
}

pub fn rgb_to_hsla(rgb: Rgb) -> Hsla {
    gpui_kit::Rgba {
        r: f32::from(rgb.r) / 255.0,
        g: f32::from(rgb.g) / 255.0,
        b: f32::from(rgb.b) / 255.0,
        a: 1.0,
    }
    .into()
}

pub fn hsla_to_rgb(color: Hsla) -> Rgb {
    let rgba = color.to_rgb();
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Rgb {
        r: byte(rgba.r),
        g: byte(rgba.g),
        b: byte(rgba.b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::hsla;

    fn theme() -> ThemeColors {
        ThemeColors {
            foreground: hsla(0.0, 0.0, 0.9, 1.0),
            background: hsla(0.0, 0.0, 0.1, 1.0),
            cursor: hsla(0.5, 1.0, 0.5, 1.0),
            selection: hsla(0.6, 1.0, 0.5, 0.3),
        }
    }

    #[test]
    fn default_colors_come_from_the_theme() {
        let palette = ColorPalette::new(theme());
        let colors = Colors::default();
        let t = theme();
        assert_eq!(
            palette.resolve(Color::Named(NamedColor::Foreground), &colors),
            t.foreground
        );
        assert_eq!(
            palette.resolve(Color::Named(NamedColor::Background), &colors),
            t.background
        );
        assert_eq!(
            palette.resolve(Color::Named(NamedColor::Cursor), &colors),
            t.cursor
        );
        assert_eq!(palette.selection(), t.selection);
    }

    #[test]
    fn ansi_indexed_and_true_colors() {
        let palette = ColorPalette::new(theme());
        let colors = Colors::default();
        let red = palette.resolve(Color::Named(NamedColor::Red), &colors);
        assert_eq!(
            hsla_to_rgb(red),
            Rgb {
                r: 0xcc,
                g: 0,
                b: 0
            }
        );
        assert_eq!(palette.resolve(Color::Indexed(1), &colors), red);
        let cube = palette.resolve(Color::Indexed(16 + 36 * 5 + 6 + 2), &colors);
        assert_eq!(
            hsla_to_rgb(cube),
            Rgb {
                r: 255,
                g: 95,
                b: 135
            }
        );
        let gray = palette.resolve(Color::Indexed(255), &colors);
        assert_eq!(
            hsla_to_rgb(gray),
            Rgb {
                r: 238,
                g: 238,
                b: 238
            }
        );
        let spec = Rgb {
            r: 128,
            g: 64,
            b: 192,
        };
        assert_eq!(
            hsla_to_rgb(palette.resolve(Color::Spec(spec), &colors)),
            spec
        );
    }

    #[test]
    fn program_overrides_win() {
        let palette = ColorPalette::new(theme());
        let mut colors = Colors::default();
        let blue = Rgb { r: 0, g: 0, b: 255 };
        colors[NamedColor::Background] = Some(blue);
        colors[3] = Some(blue);
        assert_eq!(
            hsla_to_rgb(palette.resolve(Color::Named(NamedColor::Background), &colors)),
            blue
        );
        assert_eq!(
            hsla_to_rgb(palette.resolve(Color::Indexed(3), &colors)),
            blue
        );
        assert_eq!(palette.rgb(3, &colors), Some(blue));
        assert_eq!(palette.rgb(COUNT, &colors), None);
        assert_eq!(
            palette.rgb(NamedColor::Foreground as usize, &Colors::default()),
            Some(hsla_to_rgb(theme().foreground))
        );
    }
}
