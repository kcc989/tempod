//! Mouse handling: grid geometry, selection kinds, and mouse and wheel reports.
use crate::terminal::{MIN_COLS, MIN_ROWS};
use alacritty_terminal::index::Side;
use alacritty_terminal::term::TermMode;
use gpui_kit::{Bounds, Modifiers, MouseButton, Pixels, Point, Size, point, size};

/// Type of text selection, from the click count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionType {
    /// Single click and drag.
    Simple,
    /// Double click: a word.
    Word,
    /// Triple click: a line, with its wrapped continuation.
    Line,
}

pub fn selection_type_from_clicks(click_count: usize) -> SelectionType {
    match click_count {
        0 | 1 => SelectionType::Simple,
        2 => SelectionType::Word,
        _ => SelectionType::Line,
    }
}

/// How many cells fit in `available`. `None` when not even the minimum grid fits, such as a
/// collapsed panel; the grid then keeps its size.
pub fn grid_size(
    available: Size<Pixels>,
    cell_width: Pixels,
    cell_height: Pixels,
) -> Option<(u16, u16)> {
    let (width, height) = (f32::from(available.width), f32::from(available.height));
    let (cell_width, cell_height) = (f32::from(cell_width), f32::from(cell_height));
    if !(cell_width > 0.0 && cell_height > 0.0) {
        return None;
    }
    let cols = (width / cell_width).floor();
    let rows = (height / cell_height).floor();
    if !(cols >= f32::from(MIN_COLS) && rows >= f32::from(MIN_ROWS)) {
        return None;
    }
    let max = f32::from(u16::MAX);
    Some((cols.min(max) as u16, rows.min(max) as u16))
}

/// A viewport cell: row 0 is the top visible line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellPosition {
    pub row: usize,
    pub col: usize,
    /// The half of the cell the pointer is in.
    pub side: Side,
}

/// Where the grid was laid out in the last frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridGeometry {
    pub origin: Point<Pixels>,
    pub cell_width: Pixels,
    pub cell_height: Pixels,
    pub cols: u16,
    pub rows: u16,
}

impl GridGeometry {
    pub fn bounds(&self) -> Bounds<Pixels> {
        Bounds {
            origin: self.origin,
            size: size(
                self.cell_width * f32::from(self.cols),
                self.cell_height * f32::from(self.rows),
            ),
        }
    }

    pub fn contains(&self, position: Point<Pixels>) -> bool {
        self.bounds().contains(&position)
    }

    /// The cell under `position`, clamped to the grid.
    pub fn cell_at(&self, position: Point<Pixels>) -> CellPosition {
        let x = f32::from(position.x - self.origin.x);
        let y = f32::from(position.y - self.origin.y);
        let width = f32::from(self.cell_width);
        let height = f32::from(self.cell_height);
        let col = clamp_index(x / width, self.cols);
        let row = clamp_index(y / height, self.rows);
        let within = x - col as f32 * width;
        let side = if x >= 0.0 && within > width / 2.0 {
            Side::Right
        } else {
            Side::Left
        };
        CellPosition { row, col, side }
    }

    /// The top-left corner of a cell, in window coordinates.
    pub fn cell_origin(&self, row: usize, col: usize) -> Point<Pixels> {
        point(
            self.origin.x + self.cell_width * col as f32,
            self.origin.y + self.cell_height * row as f32,
        )
    }
}

fn clamp_index(value: f32, count: u16) -> usize {
    let last = usize::from(count.max(1)) - 1;
    if value.is_nan() || value < 0.0 {
        0
    } else {
        (value.floor() as usize).min(last)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseAction {
    Press,
    Release,
    Motion,
}

pub fn button_code(button: MouseButton) -> Option<u8> {
    match button {
        MouseButton::Left => Some(0),
        MouseButton::Middle => Some(1),
        MouseButton::Right => Some(2),
        _ => None,
    }
}

/// Modifier bits for mouse reports: shift 4, alt 8, control 16.
pub fn encode_modifiers(modifiers: &Modifiers) -> u8 {
    let mut bits = 0;
    if modifiers.shift {
        bits |= 4;
    }
    if modifiers.alt {
        bits |= 8;
    }
    if modifiers.control {
        bits |= 16;
    }
    bits
}

/// Whether the app asked for mouse reports. Shift bypasses them, so selection still works.
pub fn reports_mouse(mode: TermMode, modifiers: &Modifiers) -> bool {
    mode.intersects(TermMode::MOUSE_MODE) && !modifiers.shift
}

/// The report for a press, release or motion. `button` is `None` for motion with no button
/// held. `None` when the mode does not ask for this event or the cell cannot be encoded.
pub fn mouse_report(
    button: Option<u8>,
    action: MouseAction,
    cell: CellPosition,
    modifiers: &Modifiers,
    mode: TermMode,
) -> Option<Vec<u8>> {
    if !mode.intersects(TermMode::MOUSE_MODE) {
        return None;
    }
    if action == MouseAction::Motion {
        let wanted = mode.contains(TermMode::MOUSE_MOTION)
            || (button.is_some() && mode.contains(TermMode::MOUSE_DRAG));
        if !wanted {
            return None;
        }
    } else {
        button?;
    }
    let motion = if action == MouseAction::Motion { 32 } else { 0 };
    let mods = encode_modifiers(modifiers);
    let (col, row) = (cell.col + 1, cell.row + 1);
    if mode.contains(TermMode::SGR_MOUSE) {
        let code = button.unwrap_or(3) + mods + motion;
        let end = if action == MouseAction::Release {
            'm'
        } else {
            'M'
        };
        return Some(format!("\x1b[<{code};{col};{row}{end}").into_bytes());
    }
    let code = match action {
        MouseAction::Release => 3,
        _ => button.unwrap_or(3),
    } + mods
        + motion;
    let utf8 = mode.contains(TermMode::UTF8_MOUSE);
    let mut out = b"\x1b[M".to_vec();
    for value in [usize::from(code), col, row] {
        encode_legacy(&mut out, 32 + value, utf8)?;
    }
    Some(out)
}

fn encode_legacy(out: &mut Vec<u8>, value: usize, utf8: bool) -> Option<()> {
    if value <= 127 {
        out.push(value as u8);
    } else if utf8 {
        let ch = char::from_u32(u32::try_from(value).ok()?).filter(|_| value < 2048)?;
        let mut buf = [0; 4];
        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
    } else if value <= 255 {
        out.push(value as u8);
    } else {
        return None;
    }
    Some(())
}

/// Wheel reports in mouse mode: one per line, button 64 (up) or 65 (down).
pub fn scroll_report(
    lines: i32,
    cell: CellPosition,
    modifiers: &Modifiers,
    mode: TermMode,
) -> Option<Vec<u8>> {
    if lines == 0 {
        return None;
    }
    let button = if lines > 0 { 64 } else { 65 };
    let one = mouse_report(Some(button), MouseAction::Press, cell, modifiers, mode)?;
    Some(one.repeat(lines.unsigned_abs() as usize))
}

/// Alternate scroll: on the alternate screen (vim, less, htop) the wheel sends arrow keys.
pub fn alternate_scroll(lines: i32, mode: TermMode) -> Option<Vec<u8>> {
    if lines == 0 || !mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
        return None;
    }
    let app = mode.contains(TermMode::APP_CURSOR);
    let arrow: &[u8] = match (lines > 0, app) {
        (true, false) => b"\x1b[A",
        (true, true) => b"\x1bOA",
        (false, false) => b"\x1b[B",
        (false, true) => b"\x1bOB",
    };
    Some(arrow.repeat(lines.unsigned_abs() as usize))
}

/// Turns pixel deltas (trackpads) into whole lines, keeping the remainder between events.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScrollAccumulator {
    remainder: f32,
}

/// Most lines one wheel event may scroll.
pub const MAX_LINES_PER_EVENT: i32 = 10;

impl ScrollAccumulator {
    pub fn reset(&mut self) {
        self.remainder = 0.0;
    }

    /// Positive is up, into the history.
    pub fn lines(&mut self, delta_y: Pixels, cell_height: Pixels) -> i32 {
        let height = f32::from(cell_height);
        if height <= 0.0 {
            return 0;
        }
        let total = self.remainder + f32::from(delta_y) / height;
        let lines = total.trunc();
        self.remainder = total - lines;
        let max = MAX_LINES_PER_EVENT as f32;
        lines.clamp(-max, max) as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::px;

    fn geometry() -> GridGeometry {
        GridGeometry {
            origin: point(px(10.0), px(10.0)),
            cell_width: px(10.0),
            cell_height: px(20.0),
            cols: 80,
            rows: 24,
        }
    }

    fn cell(row: usize, col: usize) -> CellPosition {
        CellPosition {
            row,
            col,
            side: Side::Left,
        }
    }

    fn mods(shift: bool, alt: bool, control: bool) -> Modifiers {
        Modifiers {
            shift,
            alt,
            control,
            ..Modifiers::default()
        }
    }

    #[test]
    fn cell_at_maps_pixels_to_cells_and_sides() {
        let g = geometry();
        assert_eq!(
            g.cell_at(point(px(100.0), px(50.0))),
            CellPosition {
                row: 2,
                col: 9,
                side: Side::Left
            }
        );
        assert_eq!(g.cell_at(point(px(106.0), px(50.0))).side, Side::Right);
        assert_eq!(g.cell_at(point(px(0.0), px(0.0))), cell(0, 0));
        let far = g.cell_at(point(px(5000.0), px(5000.0)));
        assert_eq!((far.row, far.col), (23, 79));
        assert_eq!(g.cell_origin(2, 9), point(px(100.0), px(50.0)));
        assert!(g.contains(point(px(15.0), px(15.0))));
        assert!(!g.contains(point(px(811.0), px(15.0))));
    }

    #[test]
    fn grid_size_fits_whole_cells() {
        let cell_w = px(8.0);
        let cell_h = px(17.0);
        assert_eq!(
            grid_size(size(px(800.0), px(408.0)), cell_w, cell_h),
            Some((100, 24))
        );
        assert_eq!(
            grid_size(size(px(807.9), px(424.9)), cell_w, cell_h),
            Some((100, 24))
        );
        assert_eq!(
            grid_size(size(px(16.0), px(17.0)), cell_w, cell_h),
            Some((2, 1))
        );
        assert_eq!(grid_size(size(px(15.0), px(400.0)), cell_w, cell_h), None);
        assert_eq!(grid_size(size(px(800.0), px(0.0)), cell_w, cell_h), None);
        assert_eq!(grid_size(size(px(800.0), px(400.0)), px(0.0), cell_h), None);
        assert_eq!(
            grid_size(size(px(1e9), px(1e9)), px(1.0), px(1.0)),
            Some((u16::MAX, u16::MAX))
        );
    }

    #[test]
    fn click_counts_pick_the_selection_type() {
        assert_eq!(selection_type_from_clicks(1), SelectionType::Simple);
        assert_eq!(selection_type_from_clicks(2), SelectionType::Word);
        assert_eq!(selection_type_from_clicks(3), SelectionType::Line);
        assert_eq!(selection_type_from_clicks(4), SelectionType::Line);
    }

    #[test]
    fn no_reports_without_mouse_mode() {
        let none = Modifiers::default();
        let report = mouse_report(
            Some(0),
            MouseAction::Press,
            cell(0, 0),
            &none,
            TermMode::empty(),
        );
        assert_eq!(report, None);
        assert!(!reports_mouse(TermMode::MOUSE_REPORT_CLICK, &mods(true, false, false)));
        assert!(reports_mouse(TermMode::MOUSE_DRAG, &none));
    }

    #[test]
    fn sgr_reports() {
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let none = Modifiers::default();
        let press = mouse_report(Some(0), MouseAction::Press, cell(5, 10), &none, mode);
        assert_eq!(press.unwrap(), b"\x1b[<0;11;6M");
        let release = mouse_report(Some(2), MouseAction::Release, cell(0, 0), &none, mode);
        assert_eq!(release.unwrap(), b"\x1b[<2;1;1m");
        let all = mods(true, true, true);
        let press = mouse_report(Some(0), MouseAction::Press, cell(0, 0), &all, mode);
        assert_eq!(press.unwrap(), b"\x1b[<28;1;1M");
        let big = mouse_report(Some(1), MouseAction::Press, cell(300, 400), &none, mode);
        assert_eq!(big.unwrap(), b"\x1b[<1;401;301M");
    }

    #[test]
    fn motion_reports_follow_drag_and_motion_modes() {
        let none = Modifiers::default();
        let click = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(
            mouse_report(Some(0), MouseAction::Motion, cell(0, 0), &none, click),
            None
        );
        let drag = TermMode::MOUSE_DRAG | TermMode::SGR_MOUSE;
        assert_eq!(
            mouse_report(Some(0), MouseAction::Motion, cell(1, 2), &none, drag).unwrap(),
            b"\x1b[<32;3;2M"
        );
        assert_eq!(
            mouse_report(None, MouseAction::Motion, cell(1, 2), &none, drag),
            None
        );
        let motion = TermMode::MOUSE_MOTION | TermMode::SGR_MOUSE;
        assert_eq!(
            mouse_report(None, MouseAction::Motion, cell(1, 2), &none, motion).unwrap(),
            b"\x1b[<35;3;2M"
        );
    }

    #[test]
    fn legacy_reports() {
        let none = Modifiers::default();
        let mode = TermMode::MOUSE_REPORT_CLICK;
        let press = mouse_report(Some(0), MouseAction::Press, cell(5, 10), &none, mode);
        assert_eq!(press.unwrap(), [0x1b, b'[', b'M', 32, 32 + 11, 32 + 6]);
        let release = mouse_report(Some(0), MouseAction::Release, cell(0, 0), &none, mode);
        assert_eq!(release.unwrap(), [0x1b, b'[', b'M', 32 + 3, 33, 33]);
        let edge = mouse_report(Some(0), MouseAction::Press, cell(0, 222), &none, mode);
        assert_eq!(edge.unwrap(), [0x1b, b'[', b'M', 32, 255, 33]);
        let out = mouse_report(Some(0), MouseAction::Press, cell(0, 223), &none, mode);
        assert_eq!(out, None);
        let utf8 = mode | TermMode::UTF8_MOUSE;
        let wide = mouse_report(Some(0), MouseAction::Press, cell(0, 223), &none, utf8);
        let mut expected = vec![0x1b, b'[', b'M', 32];
        expected.extend_from_slice("\u{100}".as_bytes());
        expected.push(33);
        assert_eq!(wide.unwrap(), expected);
    }

    #[test]
    fn wheel_reports_in_mouse_mode() {
        let none = Modifiers::default();
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(
            scroll_report(2, cell(5, 10), &none, mode).unwrap(),
            b"\x1b[<64;11;6M\x1b[<64;11;6M"
        );
        assert_eq!(
            scroll_report(-1, cell(5, 10), &none, mode).unwrap(),
            b"\x1b[<65;11;6M"
        );
        assert_eq!(scroll_report(0, cell(5, 10), &none, mode), None);
        assert_eq!(scroll_report(1, cell(0, 0), &none, TermMode::empty()), None);
    }

    #[test]
    fn alternate_scroll_sends_arrows_on_the_alternate_screen() {
        let alt = TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL;
        assert_eq!(alternate_scroll(3, alt).unwrap(), b"\x1b[A\x1b[A\x1b[A");
        assert_eq!(
            alternate_scroll(-2, alt | TermMode::APP_CURSOR).unwrap(),
            b"\x1bOB\x1bOB"
        );
        assert_eq!(alternate_scroll(1, TermMode::ALT_SCREEN), None);
        assert_eq!(alternate_scroll(1, TermMode::ALTERNATE_SCROLL), None);
        assert_eq!(alternate_scroll(0, alt), None);
    }

    #[test]
    fn scroll_accumulator_keeps_fractions() {
        let mut acc = ScrollAccumulator::default();
        let h = px(20.0);
        assert_eq!(acc.lines(px(10.0), h), 0);
        assert_eq!(acc.lines(px(10.0), h), 1);
        assert_eq!(acc.lines(px(-50.0), h), -2);
        assert_eq!(acc.lines(px(-10.0), h), -1);
        assert_eq!(acc.lines(px(1000.0), h), MAX_LINES_PER_EVENT);
        acc.reset();
        assert_eq!(acc.lines(px(19.0), h), 0);
        assert_eq!(acc.lines(px(0.0), px(0.0)), 0);
    }
}
