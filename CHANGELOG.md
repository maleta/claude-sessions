# Changelog

## [1.1.0] - 2026-07-11

Three features built on top of upstream 1.0.3, developed and tested end-to-end on
Windows 11 (the Linux/macOS terminal launchers follow the standard invocations).

### Multi-account / subscription tracking

Transcripts don't record which account a session ran under, so the hook now stamps
it at analysis time: it reads `oauthAccount` from the `.claude.json` of the Claude
Code process that fired the hook (`CLAUDE_CONFIG_DIR` respected - that's how people
usually separate multiple subscriptions) and stores `{ uuid, email, plan }` on the
session. The plan label is derived from the org's rate-limit tier (`Max 20x`, `Pro`,
`Team`, ...). First stamp wins: a session belongs to the account it started under.

UI: when 2+ accounts exist in the data, one filter chip per account (email + plan +
count, dot color hashed from the email), an account dot + plan badge per card, and
search matches email/plan. Single-account users see no change. Pre-feature sessions
show as "untracked account".

### Click-to-resume (optional local server)

New `server/serve.ts` (auto-provisioned into the data dir like the UI). Served over
`http://127.0.0.1:4457`, clicking a session card POSTs to `/api/resume`, which opens
a new terminal window already running `claude --resume <id>` in the session's
project directory (Windows Terminal/cmd, Terminal.app, gnome-terminal/konsole/xterm).

Safety: localhost bind by default; required custom header forces a CORS preflight
(other origins can't trigger it from a browser); ids validated against tracked data;
the working directory always comes from stored data, never the request.

Also: `SESSION_TRACKER_READONLY=1` (resume disabled - for serving the UI from a
machine that doesn't hold the sessions, e.g. a NAS container over a synced data
dir), `SESSION_TRACKER_HOST` (container binds), `SESSION_TRACKER_PORT`, and
`GET /api/config` so the UI can fall back to copy-only buttons. `file://` usage is
unchanged.

Windows note: Windows Terminal's `wt.exe` is an app-execution alias (reparse point)
that Bun can neither `stat` nor `spawn` - it's detected via `where.exe` and launched
through `cmd /c start`.

### Backfill

`scripts/backfill.ts` imports pre-existing history: scans
`<config>/projects/**/*.jsonl`, skips already-tracked and empty transcripts, pulls
metadata (cwd, branch, dates, tokens) from the transcript itself and runs the same
Haiku analysis as the live hook. Saves after every session (safe to interrupt and
re-run), small worker pool (`--concurrency`, default 3), `--dry-run`, `--limit`,
`--exclude <regex>` (reported, for throwaway test-harness dirs). Never writes
`SESSION_SUMMARIES.md` during bulk import; backfilled sessions carry `account: null`.

The hook was refactored to export its transcript/analysis helpers and only run
`main()` when executed directly (`import.meta.main`), so backfill and hook share
one implementation.

### Multi-machine support

Sessions live on the machine that ran them, but people work from several
machines (and from headless servers running Claude Code remotely). Every
session now records its `host`, and each machine writes its own
`sessions-data.<host>.js` - syncing the data dir (e.g. Syncthing) is safe by
construction because no two machines ever write the same file. `serve.ts`
merges every data file it finds; the UI gains host filter chips, a per-card
host badge, and groups by project NAME instead of absolute path (a synced dev
folder puts the same repo at different paths per machine).

Resume became host-aware: local sessions open a terminal as before; sessions
from another machine copy a command defined in an optional `remote-hosts.json`
(`{id}`/`{path}`/`{project}` placeholders - e.g. ssh + docker exec + tmux into
a server). `/api/resume` refuses foreign sessions. Single-machine setups are
unaffected (legacy `sessions-data.js` and `file://` browsing keep working).

Also fixed along the way: the UI fetched server config from a blok `init()`
hook that the framework never calls (latent upstream bug - the relative-time
refresher never ran either); config is now fetched before mount.

`--account <email[:plan]>` was added to the backfill for the same
multi-machine reality: transcripts don't record the account, but you often
know which subscription a machine or an era of history ran under.

### Internal

- `SESSION_TRACKER_DIR` env override for the data directory (isolated testing).
- Data migration: `account` defaults to `null` on load; old files keep working.
- Demo page regenerated with multi-account example data.

## [1.0.3] - upstream

Baseline from [maleta/claude-sessions](https://github.com/maleta/claude-sessions):
Stop/SessionEnd hooks, Haiku summaries, per-project `SESSION_SUMMARIES.md`, static
web UI with search/grouping/hide/copy-resume, token accounting, stale-session
cleanup, `/clear` handling, session-history skill.
