# Workspace layout verification

The screenshots show synthetic data in the real web components: desktop tool launcher, a file beside chat, and phone chat.

- Root typecheck, source lint and formatting passed.
- The production web app CI build task passed in 4.1 s.
- The complete root test command passed in Linux: Worker stage 118.7 s, other test tasks 130.0 s, then 13 root script tests in 3.2 s.
- Web suite: 19 permanent cases; a temporary capture case was removed. The measured run including capture was 9.6 s.
- Workspace browser regressions: 9 passed in 5.6 s.
- Mac suite: 264 passed in 5.45 s, including surface visibility after frame cleanup, popup hide/restore and browser-session teardown.
- The finish review found and then scored two native lifecycle fixes resolved at source/test scope.
- Root tests on macOS passed all stages except the Linux `/proc/net/tcp` daemon case. After cleanup restored disk space, the Linux CI command stopped in oxlint's allocator with SIGABRT. Separate Linux typecheck and the complete root test command passed.
- A broader Rust workspace run also stopped on an unchanged tempo-client artifact RPC fixture network error. The Mac suite itself passed.
- Organization policy blocked Computer Use for the native layout fixture. Native appearance, placement and overlay order are not visually accepted.
- No deployment, live Cloudflare Browser Run session, hosted acceptance or new remote CI result is claimed.

After rebasing onto `5eba4fb`, typecheck, lint, formatting and all 266 Mac tests passed (1.61 s native test execution). GitHub run `38470261533` passed the full suite on `23e6a64`, including 28 browser cases: 251.3 s checks, 305.7 s with setup and 319 s including cleanup. This exceeded the five-minute target; the unchanged Worker suite took 244.8 s. Native visual and hosted Browser Run acceptance remain open.
