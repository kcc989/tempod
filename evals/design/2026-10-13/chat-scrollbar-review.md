# Chat scrollbar correction

The transcript viewport now spans the chat panel. The 820 pt reading track is inside each native message row; it no longer bounds the scroll viewport. Native scrollbars use GPUI Kit Scrolling mode and fade after idle. Web transcript scrollbars keep their edge gutter and become visible on scroll, then hide after one second of idle.

The Mac capture `dark/chat-panel-scrollbar/idle-window.png` shows Info below both bars and no idle scrollbar. A subsequent desktop scroll visibly revealed the thumb at the chat panel edge and Jump to latest. That active frame was shown by the desktop tool but was not saved before the next interaction was interrupted. The earlier `idle.png` still contains the thumb from a stale/transition capture and is not idle-hide proof.

The user confirmed: “I was wrong. The new scroll bar behavior is working.” This confirms the installed Mac behavior for this correction; it does not accept the whole app design.

Mac binary build and signing verification passed. Web typecheck and changed-file lint passed. No test suites ran. Browser interaction remains pending.
