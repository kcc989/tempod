//! Spike S11 (07): can GPUI Kit 0.7.1 carry the Tempo transcript?
//!
//! The main window with a filled `Sidebar`, `Resizable` panes, `Tabs` and a `MessageScroller` of
//! 10,000 `TextView::markdown` rows, the last of which streams 200 deltas a second. Pass criterion:
//! frame time p99 under 16 ms on an M1. Build with the `profiler` feature to print GPUI's draw
//! histogram every 5 s:
//!
//!     cargo run --release -p tempo-mac --example s11_transcript --features profiler -- \
//!         --rows 10000 --rate 200 --seconds 60
use gpui_kit::{App, AsyncApp, SharedString};
use std::time::{Duration, Instant};
use tempo_mac::views::chat::TranscriptRow;
use tempo_mac::views::main_window::{self, MainWindowContent, WorkspaceContent};
use tempo_mac::views::sidebar::{SidebarRow, SidebarSection};
use tempo_mac::views::top_bar::TopBar;
use tempo_mac::{image_policy, keymap, menus};

struct Args {
    rows: usize,
    rate: u64,
    seconds: u64,
}

fn args() -> Args {
    let mut out = Args {
        rows: 10_000,
        rate: 200,
        seconds: 60,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    for pair in argv.chunks(2) {
        let value = pair.get(1).and_then(|v| v.parse::<u64>().ok());
        match (pair[0].as_str(), value) {
            ("--rows", Some(v)) => out.rows = v.max(1) as usize,
            ("--rate", Some(v)) => out.rate = v.max(1),
            ("--seconds", Some(v)) => out.seconds = v,
            _ => eprintln!("ignored argument {}", pair[0]),
        }
    }
    out
}

const SAMPLES: [&str; 6] = [
    "I looked at `src/server/rpc.ts`. The handler decodes the input with the same schema as the web wrapper, so both paths agree.",
    "Plan:\n\n1. Read the failing test\n2. Fix the off-by-one in `paginate()`\n3. Run `bun run test`",
    "```ts\nexport const page = <T,>(xs: T[], n: number) => xs.slice(0, n);\n```\n\nThat keeps the generic `<T>` intact.",
    "### Changes\n\n- **Added** a retry with backoff\n- *Removed* the unused import\n- Kept `Vec<u8>` as is\n\nSee [the docs](https://example.com/docs) for details.",
    "| File | Lines |\n| --- | --- |\n| `a.rs` | 12 |\n| `b.rs` | 40 |",
    "Raw HTML must not render: <img src=\"https://example.com/pixel.png\"> <b>bold?</b> <a href=\"https://example.com\">link</a>\n\nA remote image must not load: ![pixel](https://example.com/pixel.png)",
];

fn content(rows: usize) -> MainWindowContent {
    let sections = ["acme/api", "acme/web", "acme/infra"]
        .iter()
        .enumerate()
        .map(|(p, project)| SidebarSection {
            label: (*project).into(),
            rows: (0..8)
                .map(|w| SidebarRow {
                    id: format!("w{p}{w}").into(),
                    title: format!("Workspace {}", p * 8 + w + 1).into(),
                    detail: format!("tempo/branch-{w} · city-{w}").into(),
                })
                .collect(),
        })
        .collect();
    let mut transcript: Vec<TranscriptRow> = (0..rows.saturating_sub(1))
        .map(|i| {
            TranscriptRow::new(
                format!("row-{i}"),
                format!("**#{i}** {}", SAMPLES[i % SAMPLES.len()]),
            )
        })
        .collect();
    transcript.push(TranscriptRow::new("row-stream", "Streaming: "));
    MainWindowContent {
        sections,
        active: Some(SharedString::from("w00")),
        workspace: Some(WorkspaceContent {
            top_bar: TopBar {
                title: "Fix pagination".into(),
                branch: "tempo/fix-pagination".into(),
                base_branch: "main".into(),
                pill: "Running · standard".into(),
                primary: Some("Commit and push".into()),
            },
            tabs: vec!["Claude Code".into(), "Codex".into()],
            rows: transcript,
        }),
    }
}

fn main() {
    let args = args();
    gpui_kit::application()
        .with_http_client(image_policy::blocked_http_client())
        .run(move |cx: &mut App| {
            gpui_kit::init(cx);
            keymap::bind(cx);
            menus::set(cx);
            let (handle, view) = main_window::open(content(args.rows), cx).expect("open window");
            let transcript = view.read(cx).transcript().clone();
            #[cfg(feature = "profiler")]
            let _ = handle.update(cx, |_, window, _| {
                window.set_debug_frame_overlay_mode(gpui_kit::DebugFrameOverlayMode::Minimal)
            });
            let stream_ix = args.rows - 1;
            let interval = Duration::from_micros(1_000_000 / args.rate);
            let seconds = args.seconds;
            cx.spawn(async move |cx: &mut AsyncApp| {
                let start = Instant::now();
                let mut last_report = start;
                let mut sent: u64 = 0;
                while start.elapsed() < Duration::from_secs(seconds) {
                    cx.background_executor().timer(interval).await;
                    let due = (start.elapsed().as_micros() / interval.as_micros().max(1)) as u64;
                    let delta = if (sent + 1).is_multiple_of(40) {
                        "word\n\n"
                    } else {
                        "word "
                    };
                    let batch = due.saturating_sub(sent).max(1);
                    let text = delta.repeat(batch as usize);
                    sent += batch;
                    transcript.update(cx, |t, cx| t.append_delta(stream_ix, &text, cx));
                    if last_report.elapsed() >= Duration::from_secs(5) {
                        last_report = Instant::now();
                        report(handle, sent, start.elapsed(), cx);
                    }
                }
                report(handle, sent, start.elapsed(), cx);
            })
            .detach();
            cx.activate(true);
        });
}

#[cfg(feature = "profiler")]
fn report(handle: gpui_kit::AnyWindowHandle, sent: u64, elapsed: Duration, cx: &mut AsyncApp) {
    use gpui_kit::AppContext as _;
    let _ = cx.update_window(handle, |_, window, _| {
        let snap = window.frame_duration_snapshot();
        let draw = &snap.draw_duration_histogram;
        let present = &snap.present_interval_histogram;
        let ms = |ns: u64| ns as f64 / 1e6;
        println!(
            "S11 {:>6.1}s deltas={sent} frames={} draw p50={:.2}ms p99={:.2}ms max={:.2}ms present p99={:.2}ms",
            elapsed.as_secs_f64(),
            draw.len(),
            ms(draw.value_at_quantile(0.50)),
            ms(draw.value_at_quantile(0.99)),
            ms(draw.max()),
            ms(present.value_at_quantile(0.99)),
        );
    });
}

#[cfg(not(feature = "profiler"))]
fn report(_: gpui_kit::AnyWindowHandle, sent: u64, elapsed: Duration, _: &mut AsyncApp) {
    println!(
        "S11 {:>6.1}s deltas={sent} (build with --features profiler for frame times)",
        elapsed.as_secs_f64()
    );
}
