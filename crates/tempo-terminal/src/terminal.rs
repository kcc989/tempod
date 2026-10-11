//! Terminal state: alacritty's `Term` and the VTE parser, fed from the output channel.
use crate::event::EventProxy;
use crate::mouse::SelectionType;
use alacritty_terminal::event::Event;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType as AlacSelectionType};
use alacritty_terminal::term::{Config, Term, TermMode, viewport_to_point};
use alacritty_terminal::vte::ansi::Processor;
use std::sync::mpsc;
use std::time::Instant;

/// Scrollback history kept by the grid (07, Terminal).
pub const SCROLLBACK_LINES: usize = 10_000;
pub const MIN_COLS: u16 = 2;
pub const MIN_ROWS: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GridDims {
    cols: usize,
    rows: usize,
}

impl Dimensions for GridDims {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

fn dims(cols: u16, rows: u16) -> GridDims {
    GridDims {
        cols: usize::from(cols.max(MIN_COLS)),
        rows: usize::from(rows.max(MIN_ROWS)),
    }
}

pub struct TerminalState {
    term: Term<EventProxy>,
    parser: Processor,
    events: mpsc::Receiver<Event>,
}

impl TerminalState {
    pub fn new(cols: u16, rows: u16) -> Self {
        let (tx, events) = mpsc::channel();
        let config = Config {
            scrolling_history: SCROLLBACK_LINES,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &dims(cols, rows), EventProxy::new(tx)),
            parser: Processor::new(),
            events,
        }
    }

    pub fn process_bytes(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    /// When a synchronized update (DECSET 2026) is open, the time it must be flushed by.
    pub fn sync_deadline(&self) -> Option<Instant> {
        self.parser.sync_timeout().sync_timeout()
    }

    pub fn flush_sync(&mut self) {
        if self.sync_deadline().is_some() {
            self.parser.stop_sync(&mut self.term);
        }
    }

    /// Resizes the grid. Returns whether the size changed.
    pub fn resize(&mut self, cols: u16, rows: u16) -> bool {
        let next = dims(cols, rows);
        if (self.term.columns(), self.term.screen_lines()) == (next.cols, next.rows) {
            return false;
        }
        self.term.resize(next);
        true
    }

    /// `(cols, rows)`.
    pub fn size(&self) -> (u16, u16) {
        (
            u16::try_from(self.term.columns()).unwrap_or(u16::MAX),
            u16::try_from(self.term.screen_lines()).unwrap_or(u16::MAX),
        )
    }

    pub fn mode(&self) -> TermMode {
        *self.term.mode()
    }

    pub fn term(&self) -> &Term<EventProxy> {
        &self.term
    }

    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    pub fn history_size(&self) -> usize {
        self.term.history_size()
    }

    /// Positive scrolls up into the history.
    pub fn scroll_lines(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
    }

    pub fn scroll_to_bottom(&mut self) {
        if self.display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
        }
    }

    /// A viewport cell (row 0 is the top visible line) as a grid point.
    pub fn viewport_to_grid(&self, row: usize, col: usize) -> Point {
        viewport_to_point(self.display_offset(), Point::new(row, Column(col)))
    }

    pub fn start_selection(&mut self, kind: SelectionType, point: Point, side: Side) {
        let ty = match kind {
            SelectionType::Simple => AlacSelectionType::Simple,
            SelectionType::Word => AlacSelectionType::Semantic,
            SelectionType::Line => AlacSelectionType::Lines,
        };
        self.term.selection = Some(Selection::new(ty, point, side));
    }

    pub fn update_selection(&mut self, point: Point, side: Side) {
        if let Some(selection) = self.term.selection.as_mut() {
            selection.update(point, side);
        }
    }

    pub fn clear_selection(&mut self) {
        self.term.selection = None;
    }

    pub fn has_selection(&self) -> bool {
        self.term
            .selection
            .as_ref()
            .is_some_and(|selection| !selection.is_empty())
    }

    pub fn selection_text(&self) -> Option<String> {
        self.term
            .selection_to_string()
            .filter(|text| !text.is_empty())
    }

    pub(crate) fn take_events(&mut self) -> Vec<Event> {
        self.events.try_iter().collect()
    }

    /// The text of one grid line (negative lines are history), without trailing blanks.
    pub fn line_text(&self, line: i32) -> String {
        let grid = self.term.grid();
        let row = &grid[Line(line)];
        let mut text: String = (0..self.term.columns())
            .map(|col| row[Column(col)].c)
            .collect();
        text.truncate(text.trim_end().len());
        text
    }

    /// The visible lines, top to bottom.
    pub fn screen_lines(&self) -> Vec<String> {
        let top = -(self.display_offset() as i32);
        (0..self.term.screen_lines() as i32)
            .map(|row| self.line_text(top + row))
            .collect()
    }

    /// The cursor as a viewport `(row, col)`.
    pub fn cursor(&self) -> (i32, usize) {
        let point = self.term.grid().cursor.point;
        (point.line.0, point.column.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::term::cell::Flags;

    fn fed(cols: u16, rows: u16, bytes: &[u8]) -> TerminalState {
        let mut state = TerminalState::new(cols, rows);
        state.process_bytes(bytes);
        state
    }

    #[test]
    fn bytes_update_the_grid_and_cursor() {
        let state = fed(20, 5, b"hello\r\nworld");
        assert_eq!(state.line_text(0), "hello");
        assert_eq!(state.line_text(1), "world");
        assert_eq!(state.cursor(), (1, 5));
    }

    #[test]
    fn escape_sequences_move_the_cursor_and_style_cells() {
        let state = fed(20, 5, b"\x1b[3;4H\x1b[1;31mX\x1b[0m");
        assert_eq!(state.cursor(), (2, 4));
        let cell = &state.term().grid()[Line(2)][Column(3)];
        assert_eq!(cell.c, 'X');
        assert!(cell.flags.contains(Flags::BOLD));
    }

    #[test]
    fn bytes_split_across_frames_parse_as_one_stream() {
        let mut state = TerminalState::new(20, 5);
        state.process_bytes(b"\x1b[3");
        state.process_bytes(b"1mA\xe2\x82");
        state.process_bytes(b"\xac");
        assert_eq!(state.line_text(0), "A€");
    }

    #[test]
    fn scrollback_is_capped_at_10000_lines() {
        let mut state = TerminalState::new(10, 4);
        let mut bytes = Vec::new();
        for n in 0..(SCROLLBACK_LINES + 500) {
            bytes.extend_from_slice(format!("{n}\r\n").as_bytes());
        }
        state.process_bytes(&bytes);
        assert_eq!(state.history_size(), SCROLLBACK_LINES);
        let oldest = -(SCROLLBACK_LINES as i32);
        assert_eq!(state.line_text(oldest), "497");
    }

    #[test]
    fn scrolling_moves_the_viewport_through_history() {
        let mut state = TerminalState::new(10, 3);
        state.process_bytes(b"a\r\nb\r\nc\r\nd\r\ne");
        assert_eq!(state.screen_lines(), ["c", "d", "e"]);
        state.scroll_lines(2);
        assert_eq!(state.display_offset(), 2);
        assert_eq!(state.screen_lines(), ["a", "b", "c"]);
        state.scroll_lines(100);
        assert_eq!(state.display_offset(), 2);
        state.scroll_to_bottom();
        assert_eq!(state.screen_lines(), ["c", "d", "e"]);
    }

    #[test]
    fn alternate_screen_has_no_scrollback_and_restores_the_primary() {
        let mut state = TerminalState::new(10, 3);
        state.process_bytes(b"one\r\ntwo\r\nthree\r\nfour");
        state.process_bytes(b"\x1b[?1049h\x1b[Hvim");
        assert!(state.mode().contains(TermMode::ALT_SCREEN));
        assert_eq!(state.screen_lines(), ["vim", "", ""]);
        state.process_bytes(b"\x1b[?1049l");
        assert_eq!(state.screen_lines(), ["two", "three", "four"]);
    }

    #[test]
    fn resize_reports_only_real_changes() {
        let mut state = TerminalState::new(80, 24);
        assert!(!state.resize(80, 24));
        assert!(state.resize(100, 30));
        assert_eq!(state.size(), (100, 30));
        assert!(!state.resize(100, 30));
        assert!(state.resize(0, 0));
        assert_eq!(state.size(), (MIN_COLS, MIN_ROWS));
    }

    #[test]
    fn resize_reflows_wrapped_lines() {
        let mut state = TerminalState::new(10, 4);
        state.process_bytes(b"abcdefghijkl");
        assert_eq!(state.screen_lines()[..2], ["abcdefghij", "kl"]);
        state.resize(20, 4);
        assert_eq!(state.screen_lines()[0], "abcdefghijkl");
    }

    fn select(
        state: &mut TerminalState,
        kind: SelectionType,
        from: (usize, usize),
        to: (usize, usize),
    ) {
        let start = state.viewport_to_grid(from.0, from.1);
        state.start_selection(kind, start, Side::Left);
        let end = state.viewport_to_grid(to.0, to.1);
        state.update_selection(end, Side::Right);
    }

    #[test]
    fn selection_across_lines_joins_them_with_newlines() {
        let mut state = fed(20, 4, b"first line\r\nsecond line\r\nthird");
        select(&mut state, SelectionType::Simple, (0, 6), (2, 2));
        assert_eq!(state.selection_text().unwrap(), "line\nsecond line\nthi");
    }

    #[test]
    fn selection_across_a_wrapped_line_has_no_newline() {
        let mut state = fed(10, 4, b"abcdefghijklmno\r\nnext");
        select(&mut state, SelectionType::Simple, (0, 2), (1, 2));
        assert_eq!(state.selection_text().unwrap(), "cdefghijklm");
        select(&mut state, SelectionType::Line, (0, 0), (0, 0));
        assert_eq!(state.selection_text().unwrap(), "abcdefghijklmno\n");
    }

    #[test]
    fn word_selection_uses_semantic_boundaries() {
        let mut state = fed(30, 2, b"git commit --amend");
        select(&mut state, SelectionType::Word, (0, 6), (0, 6));
        assert_eq!(state.selection_text().unwrap(), "commit");
    }

    #[test]
    fn selection_in_scrollback_uses_the_display_offset() {
        let mut state = fed(10, 2, b"old\r\nmid\r\nnew");
        state.scroll_lines(1);
        assert_eq!(state.screen_lines(), ["old", "mid"]);
        select(&mut state, SelectionType::Simple, (0, 0), (0, 2));
        assert_eq!(state.selection_text().unwrap(), "old");
    }

    #[test]
    fn an_empty_or_cleared_selection_copies_nothing() {
        let mut state = fed(10, 2, b"text");
        let point = state.viewport_to_grid(0, 1);
        state.start_selection(SelectionType::Simple, point, Side::Left);
        assert!(!state.has_selection());
        assert_eq!(state.selection_text(), None);
        select(&mut state, SelectionType::Simple, (0, 0), (0, 1));
        assert!(state.has_selection());
        state.clear_selection();
        assert_eq!(state.selection_text(), None);
    }

    #[test]
    fn queries_produce_pty_writes() {
        let mut state = TerminalState::new(10, 3);
        state.process_bytes(b"\x1b[5n\x1b[6n");
        let writes: Vec<String> = state
            .take_events()
            .into_iter()
            .filter_map(|event| match event {
                Event::PtyWrite(text) => Some(text),
                _ => None,
            })
            .collect();
        assert_eq!(writes, ["\x1b[0n", "\x1b[1;1R"]);
    }

    #[test]
    fn synchronized_updates_hold_output_until_flushed() {
        let mut state = TerminalState::new(10, 3);
        state.process_bytes(b"\x1b[?2026hheld");
        assert!(state.sync_deadline().is_some());
        assert_eq!(state.line_text(0), "");
        state.flush_sync();
        assert_eq!(state.sync_deadline(), None);
        assert_eq!(state.line_text(0), "held");
    }
}
