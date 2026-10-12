//! The colour tokens of 04 mapped to GPUI Kit `ThemeColor` fields, once (07, Window layout).
//! Views read colours only through [`color`]; no colour values in views.
use gpui_kit::component::{ActiveTheme as _, ThemeColor};
use gpui_kit::{App, Hsla};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Token {
    Background,
    Foreground,
    /// `--muted-foreground`
    MutedForeground,
    /// `--primary`
    Primary,
    /// `--destructive`
    Destructive,
    /// `--warning` (04's custom token)
    Warning,
    Border,
    /// Added lines in the diff view (07, Changes); open PRs and passed checks (04, Indicators).
    Success,
    /// `--merged`: merged PRs (04, Indicators).
    Merged,
}

pub fn color(token: Token, cx: &App) -> Hsla {
    from_theme(cx.theme(), token)
}

pub fn from_theme(colors: &ThemeColor, token: Token) -> Hsla {
    match token {
        Token::Background => colors.background,
        Token::Foreground => colors.foreground,
        Token::MutedForeground => colors.muted_foreground,
        Token::Primary => colors.primary,
        Token::Destructive => colors.danger,
        Token::Warning => colors.warning,
        Token::Border => colors.border,
        Token::Success => colors.success,
        Token::Merged => colors.magenta,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::hsla;

    #[test]
    fn each_token_reads_its_own_field() {
        let mut colors = ThemeColor::default();
        let tokens = [
            Token::Background,
            Token::Foreground,
            Token::MutedForeground,
            Token::Primary,
            Token::Destructive,
            Token::Warning,
            Token::Border,
            Token::Success,
            Token::Merged,
        ];
        colors.background = hsla(0.0, 0.0, 0.0, 1.0);
        colors.foreground = hsla(0.1, 0.0, 0.0, 1.0);
        colors.muted_foreground = hsla(0.2, 0.0, 0.0, 1.0);
        colors.primary = hsla(0.3, 0.0, 0.0, 1.0);
        colors.danger = hsla(0.4, 0.0, 0.0, 1.0);
        colors.warning = hsla(0.5, 0.0, 0.0, 1.0);
        colors.border = hsla(0.6, 0.0, 0.0, 1.0);
        colors.success = hsla(0.7, 0.0, 0.0, 1.0);
        colors.magenta = hsla(0.8, 0.0, 0.0, 1.0);
        for (ix, token) in tokens.into_iter().enumerate() {
            assert_eq!(from_theme(&colors, token).h, ix as f32 / 10.0, "{token:?}");
        }
    }
}
