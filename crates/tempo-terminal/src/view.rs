use crate::colors::ColorPalette;
use crate::{TerminalEvent, TerminalInput, TerminalIo, TerminalState, input, mouse};
use alacritty_terminal::event::Event;
use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::term::cell::Flags;
use gpui_kit::component::{ActiveTheme as _, v_flex};
use gpui_kit::{
    ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Task,
    Window, canvas, div, px,
};

pub struct TerminalView {
    pub state: TerminalState,
    io: async_channel::Sender<TerminalInput>,
    focus: FocusHandle,
    selecting: bool,
    cell_width: gpui_kit::Pixels,
    bounds: gpui_kit::Bounds<gpui_kit::Pixels>,
    _reader: Task<()>,
    sync_flush: Option<Task<()>>,
}
impl EventEmitter<TerminalEvent> for TerminalView {}
impl Focusable for TerminalView {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus.clone()
    }
}
impl TerminalView {
    pub fn new(io: TerminalIo, cx: &mut Context<Self>) -> Self {
        let reader = cx.spawn(async move |this, cx| {
            while let Ok(bytes) = io.output.recv().await {
                if this
                    .update(cx, |this, cx| {
                        this.state.process_bytes(&bytes);
                        this.events(cx);
                        this.sync_flush.take();
                        if let Some(deadline) = this.state.sync_deadline() {
                            let wait =
                                deadline.saturating_duration_since(std::time::Instant::now());
                            this.sync_flush = Some(cx.spawn(async move |this, cx| {
                                cx.background_executor().timer(wait).await;
                                let _ = this.update(cx, |v, cx| {
                                    v.state.flush_sync();
                                    v.events(cx);
                                    cx.notify();
                                });
                            }));
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
            }
            let _ = this.update(cx, |_, cx| cx.emit(TerminalEvent::Exited));
        });
        Self {
            state: TerminalState::new(80, 24),
            io: io.input,
            focus: cx.focus_handle(),
            selecting: false,
            cell_width: px(7.8),
            bounds: Default::default(),
            _reader: reader,
            sync_flush: None,
        }
    }
    fn events(&mut self, cx: &mut Context<Self>) {
        for event in self.state.take_events() {
            match event {
                Event::PtyWrite(text) => {
                    let _ = self.io.try_send(TerminalInput::Bytes(text.into_bytes()));
                }
                Event::Title(title) => cx.emit(TerminalEvent::Title(title)),
                Event::Bell => cx.emit(TerminalEvent::Bell),
                Event::ClipboardStore(_, text) => cx.emit(TerminalEvent::ClipboardStore(text)),
                _ => {}
            }
        }
    }
    pub fn resize(&mut self, cols: u16, rows: u16, cx: &mut Context<Self>) {
        if self.state.resize(cols, rows) {
            let _ = self.io.try_send(TerminalInput::Resize { cols, rows });
            cx.notify();
        }
    }
    fn cell(
        &self,
        position: gpui_kit::Point<gpui_kit::Pixels>,
        bounds: gpui_kit::Bounds<gpui_kit::Pixels>,
    ) -> GridPoint {
        let (cols, rows) = self.state.size();
        let row = ((f32::from(position.y - bounds.origin.y) / 18.)
            .floor()
            .max(0.) as usize)
            .min(usize::from(rows) - 1);
        let col = ((f32::from(position.x - bounds.origin.x) / f32::from(self.cell_width))
            .floor()
            .max(0.) as usize)
            .min(usize::from(cols) - 1);
        GridPoint::new(
            Line(row as i32 - self.state.display_offset() as i32),
            Column(col),
        )
    }
}
impl Render for TerminalView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let family = cx.theme().mono_font_family.clone();
        let font = cx
            .text_system()
            .resolve_font(&gpui_kit::font(family.clone()));
        let cell_width = cx
            .text_system()
            .em_advance(font, px(13.))
            .unwrap_or(px(7.8))
            .max(px(1.));
        self.cell_width = cell_width;
        let weak = cx.weak_entity();
        let palette = ColorPalette::from_theme(cx.theme());
        let (cols, rows) = self.state.size();
        let selection = self
            .state
            .term()
            .selection
            .as_ref()
            .and_then(|s| s.to_range(self.state.term()));
        let cursor = self.state.cursor();
        let base = gpui_kit::font(family.clone());
        let default_bg = palette.background();
        let show_cursor = self
            .state
            .mode()
            .contains(alacritty_terminal::term::TermMode::SHOW_CURSOR)
            && self.state.display_offset() == 0;
        // One shaped text per row; per-cell elements made every echo re-layout the whole grid.
        let lines: Vec<_> = (0..usize::from(rows))
            .map(|row| {
                let line = Line(row as i32 - self.state.display_offset() as i32);
                let mut text = String::new();
                let mut runs: Vec<gpui_kit::TextRun> = Vec::new();
                for col in 0..usize::from(cols) {
                    let cell = &self.state.term().grid()[line][Column(col)];
                    if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                        continue;
                    }
                    let mut fg = palette.resolve(cell.fg, self.state.term().colors());
                    let mut bg = palette.resolve(cell.bg, self.state.term().colors());
                    if cell.flags.contains(Flags::INVERSE) {
                        std::mem::swap(&mut fg, &mut bg);
                    }
                    if cell.flags.contains(Flags::DIM) {
                        fg = crate::colors::dim(fg);
                    }
                    if selection
                        .as_ref()
                        .is_some_and(|s| s.contains(GridPoint::new(line, Column(col))))
                    {
                        bg = palette.selection();
                    }
                    if show_cursor && cursor == (line.0, col) {
                        bg = palette.cursor();
                        fg = palette.background();
                    }
                    let start = text.len();
                    if cell.flags.contains(Flags::HIDDEN) || cell.c == '\0' {
                        text.push(' ');
                    } else {
                        text.push(cell.c);
                        if let Some(chars) = cell.zerowidth() {
                            text.extend(chars);
                        }
                    }
                    let len = text.len() - start;
                    let mut font = base.clone();
                    if cell.flags.contains(Flags::BOLD) {
                        font.weight = gpui_kit::FontWeight::BOLD;
                    }
                    let background_color = (bg != default_bg).then_some(bg);
                    match runs.last_mut() {
                        Some(last)
                            if last.color == fg
                                && last.background_color == background_color
                                && last.font == font =>
                        {
                            last.len += len
                        }
                        _ => runs.push(gpui_kit::TextRun {
                            len,
                            font,
                            color: fg,
                            background_color,
                            underline: None,
                            strikethrough: None,
                        }),
                    }
                }
                gpui_kit::StyledText::new(text)
                    .with_runs(runs)
                    .into_any_element()
            })
            .collect();
        div()
            .id("terminal-grid")
            .role(gpui_kit::Role::Terminal)
            .aria_label("Remote workspace terminal")
            .size_full()
            .relative()
            .key_context("Terminal")
            .track_focus(&self.focus)
            .font_family(family)
            .text_size(px(13.))
            .line_height(px(18.))
            .overflow_hidden()
            .on_mouse_up_out(
                gpui_kit::MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.selecting = false;
                    cx.notify();
                }),
            )
            .on_key_down(cx.listener(|this, event: &gpui_kit::KeyDownEvent, _, cx| {
                if input::is_app_shortcut(&event.keystroke) {
                    if event.keystroke.key == "c"
                        && let Some(text) = this.state.selection_text()
                    {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                        cx.stop_propagation();
                    }
                    if event.keystroke.key == "v"
                        && let Some(text) = cx.read_from_clipboard().and_then(|c| c.text())
                    {
                        let _ = this.io.try_send(TerminalInput::Bytes(input::paste_bytes(
                            &text,
                            this.state.mode(),
                        )));
                        cx.stop_propagation();
                    }
                    return;
                }
                let bytes = input::keystroke_to_bytes(&event.keystroke, this.state.mode(), true);
                if let Some(bytes) = bytes {
                    this.state.scroll_to_bottom();
                    let _ = this.io.try_send(TerminalInput::Bytes(bytes));
                    cx.notify();
                }
                cx.stop_propagation();
            }))
            .on_scroll_wheel(
                cx.listener(|this, event: &gpui_kit::ScrollWheelEvent, _, cx| {
                    let delta = event.delta.pixel_delta(px(18.));
                    this.state
                        .scroll_lines((f32::from(delta.y) / 18.).round() as i32);
                    cx.notify();
                    cx.stop_propagation();
                }),
            )
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.bounds = bounds;
                            if let Some((cols, rows)) =
                                mouse::grid_size(bounds.size, cell_width, px(18.))
                            {
                                this.resize(cols, rows, cx);
                            }
                        });
                        let _ = window;
                        bounds
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(
                v_flex().children(lines.into_iter().enumerate().map(|(row, line)| {
                    div()
                        .id(("terminal-row", row))
                        .h(px(18.))
                        .whitespace_nowrap()
                        .child(line)
                        .on_mouse_down(
                            gpui_kit::MouseButton::Left,
                            cx.listener(
                                move |this, event: &gpui_kit::MouseDownEvent, window, cx| {
                                    window.focus(&this.focus, cx);
                                    this.selecting = true;
                                    let point = this.cell(event.position, this.bounds);
                                    this.state.start_selection(
                                        mouse::selection_type_from_clicks(event.click_count),
                                        point,
                                        Side::Left,
                                    );
                                    cx.notify();
                                },
                            ),
                        )
                        .on_mouse_move(cx.listener(
                            move |this, event: &gpui_kit::MouseMoveEvent, _, cx| {
                                if this.selecting
                                    && event.pressed_button == Some(gpui_kit::MouseButton::Left)
                                {
                                    let point = this.cell(event.position, this.bounds);
                                    this.state.update_selection(point, Side::Right);
                                    cx.notify();
                                }
                            },
                        ))
                        .on_mouse_up(
                            gpui_kit::MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                this.selecting = false;
                                cx.notify();
                            }),
                        )
                })),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AppContext as _, TestAppContext};
    #[gpui_kit::test]
    fn remote_frames_are_parsed_and_terminal_queries_return_to_the_same_channel(
        cx: &mut TestAppContext,
    ) {
        let (io, remote) = TerminalIo::pair();
        let view = cx.new(|cx| TerminalView::new(io, cx));
        remote.output.try_send(b"hello\x1b[6n".to_vec()).unwrap();
        cx.run_until_parked();
        view.read_with(cx, |v, _| assert_eq!(v.state.line_text(0), "hello"));
        assert_eq!(
            remote.input.try_recv().unwrap(),
            TerminalInput::Bytes(b"\x1b[1;6R".to_vec())
        );
        view.update(cx, |v, cx| v.resize(100, 30, cx));
        assert_eq!(
            remote.input.try_recv().unwrap(),
            TerminalInput::Resize {
                cols: 100,
                rows: 30
            }
        );
    }
}
