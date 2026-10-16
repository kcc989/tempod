# Friction log

The owner fills in this log for one week before Phase 3 starts (13 Loop). That week is the exit baseline. The owner fills it in again for the week used for done-proof 5.

## How to log

Add one row to a copy of `template.csv` each time you lose time. Do not log time that was spent on useful work.

| Column | Value |
|---|---|
| `time` | Local time when it started, `YYYY-MM-DDTHH:MM` |
| `code` | One code from the list below. If two codes apply, add two rows and split the minutes. |
| `doing` | What you were doing, in at most one sentence |
| `minutes_lost` | Your estimate, in whole minutes |

Keep the filled log out of the repo when `doing` holds personal text. Commit only the summary:

```sh
python3 -I summarize.py my-log.csv > ../loop-baseline/data/friction-week-<YYYY-MM-DD>.json
```

## Codes

The first nine codes are the same as in the message labels (`../loop-baseline/label-prompt.md`), so the two sources compare.

| Code | Log it when |
|---|---|
| `DIRECTION` | The agent misread what you wanted and you had to redirect it |
| `VERIFY` | You had to check by hand that a change works or looks right, or it did not when the agent said it did |
| `UNCLEAR_IMPL` | You could not tell what the agent built or changed |
| `STACK` | You restated the stack, a library or a platform choice |
| `CI_SLOW` | You waited for CI, or fixed or re-ran a failed CI run |
| `DESIGN_IGNORED` | You gave the same design critique again |
| `CF_PERMS` | Cloudflare tokens, scopes, account IDs or deploy access |
| `API_KEYS` | You created, found, pasted or configured a key or token |
| `ACCESS_UNAWARE` | The agent did not know it could use a tool, service or credential |
| `EXIT_GITHUB` | You opened GitHub (web or `gh`) to do something Tempo should do |
| `EXIT_CF_DASHBOARD` | You opened the Cloudflare dashboard or ran `wrangler` yourself |
| `EXIT_OTHER` | You left Tempo for any other tool for loop work. Name the tool in `doing`. |
