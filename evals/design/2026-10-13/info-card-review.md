# Freestanding workspace Info correction

The user requested a freestanding panel like the attached Codex reference. Info was previously a full-height tool tab. That interpretation was wrong.

## Change

Info now has a separate 360 px/pt rail, 12 px/pt outer space, a content-height muted card, 16 px/pt inner padding and 16 px/pt corners. It has no tool tab bar. Related tools retain their tabs and saved width. Close Info hides the rail. Workspace controls are inside a disclosure. Action rows have contextual icons; changes align additions and deletions at the right. Web and Mac specifications were updated together.

## Evidence and limits

- Mac binary build passed: `cargo build --locked -p tempo-mac --bin Tempo`, using the shared target directory. This built the application only.
- Web TypeScript check and changed-file lint passed.
- No tests or native test targets ran, as requested.
- The corrected binary is built but has not been installed or verified in the native app. Desktop control reports the Mac locked. A manual-unlock request is pending. Keeping the Mac awake is also pending explicit authorization.
- No screen is accepted. There is no app aggregate pass.

## Before review

The old installed panel was captured in `dark/info-initial/full.png`, with accessibility text in `ax.txt`. The fresh Guides capture is in `dark/guides-initial/full.png`. The visible chat title differs from the accessibility label because the tab sets its accessible name to the agent tooltip; that difference alone does not prove stale pixels. Earlier startup frames were excluded.

Four stateless Cloudflare Workers AI Clef requests returned HTTP 200 for layout, spacing, color/depth and usability, using unchanged review-v2.1 area questions. Raw answers and request hashes are in `dark/info-initial`. Layout's space-fit answer was 0.1753. Secondary contrast, action affordance and disabled-control answers had low confidence; they require review, not a pass. These observations support the structural correction but do not establish acceptance or validate the new card.

The user's Codex reference screenshot was used locally only. It was not uploaded to Clef.

## Next native check

Quit Tempo, install/sign the built binary without re-signing the Keychain helper, relaunch, and capture Info. Confirm content height, outer space, no Info tab, controls disclosure, Close Info, and transitions to/from Changes and Guides. Then obtain the four independent Clef reviews of the corrected capture. No test suites are part of this check.
