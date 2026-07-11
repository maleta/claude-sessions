# Changelog

## [1.2.0] - 2026-07-11

### Per-model token tracking & session cost

`computeTokenUsage` now also splits usage by the raw model id found on each
assistant transcript line (`message.model`, `<synthetic>` error entries excluded),
stored as `models: { "<model-id>": { input, output, cache_write, cache_read } }`
next to the existing totals. Both the live hook and the backfill stamp it, and
`bun scripts/backfill.ts --update-tokens` re-stamps tokens + models on already
tracked sessions straight from the transcripts (no Haiku calls) so existing
history gets exact data.

Cost model shared by UI and server: family/version rates resolved from the model
id (Fable 5, Opus ≥4.5 vs older, Sonnet, Haiku ≥4.5 vs older; cache read 0.1×
input, cache write 1.25× input). Sessions without `models` fall back to a
selectable rate and are marked estimated (`~` on cards, "(assumed)" in charts).

### Web UI redesign

Full rewrite of the layout on a refreshed dark palette (Claude-coral accent for
primary actions and annotations, semantic status colors kept separate), larger
type throughout:

- **Sidebar facets** replace the 500px project columns and the three filter-chip
  rows: projects with counts (top 12 + expand), machines, accounts, statuses,
  archived/deleted toggles. One vertical feed instead of horizontal scrolling;
  cards carry a project chip (click = filter).
- **Cards** now answer "when, how much, with what": API-equivalent cost + total
  tokens top-right (per-model breakdown in the tooltip/detail), model chip,
  duration, exact start/last timestamps in local time with relative time
  alongside, plus the existing status/branch/msgs/machine/account meta.
- **Explicit actions**: clicking a card opens details (it no longer launches a
  terminal); ▶ resume is the primary button and ⑂ fork resumes with
  `--fork-session` (new session id, original untouched). `/api/resume` accepts
  `{ fork: true }`.
- **Search operators**: free text combines with `host:`, `status:`, `project:`,
  `model:`, `account:`, `branch:`, `before:`/`after:` (dates, YYYY-MM-DD).
- **Sort & density**: feed sorts by last activity / cost / tokens / duration;
  comfortable/compact density. Both persisted in localStorage.
- **Header KPIs**: sessions today, $ today, $ last 7 days.
- **Detail modal**: exact timestamps, duration, per-model cost breakdown with
  estimated-data note, and Resume/Fork buttons.

### Usage dashboard redesign

Same visual system as the main UI, bigger legible type. Costs everywhere now use
the exact per-model data where available ("$ as" became "fallback $", applied
only to sessions without a breakdown; the KPI notes how many were estimated).
New **By model** ranking (output tokens + cost per model). Heatmap/daily-bars
tooltips gained a ≈value line; top-projects bars and the table show per-project
cost computed per-session.

### Summary endpoint

`GET /api/summary`: `{ host, today: { sessions, cost, tokens_out }, week: {...},
last_session: { title, project, host, updated_at, ago_minutes } }` over the
merged multi-machine data (deleted excluded) - made for personal-dashboard
widgets (e.g. a Glance custom-api panel).

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

### Session editing (metadata overlay)

Titles, summaries, topics and status can be edited from a new detail view
(click a session title); sessions gain user notes (searchable, shown on the
card), pin, archive and delete. Edits live in per-machine
`sessions-meta.<machine>.js` overlay files - never in the data files, which
the hooks own and would overwrite (and where a removed entry would be
resurrected by the next backfill). The overlay is merged at read time
(newest entry per session wins, snapshotting the merged state so edits from
different machines compose), so user edits survive re-analysis of active
sessions by design.

Delete is a tombstone: hidden everywhere, skipped by backfill, restorable
via "show deleted"; physical removal via `scripts/purge.ts` (dry-run by
default, `--apply`), which only touches the running machine's own data file.
Archive replaces the old per-browser localStorage hide whenever an
edit-capable server is available (existing hides migrate automatically);
`SESSION_TRACKER_NO_EDIT=1` disables editing on a server. Plus: per-status
filter chips, minute-level auto-refresh in server mode, and a single-column
mobile layout.

### Usage dashboard

A stats view over the tracked data: KPI tiles (sessions, tokens generated,
cache read, API-equivalent value with a model-rate selector), a GitHub-style
activity heatmap, tokens-per-day columns stacked by machine, a top-projects
bar ranking with an explicit "other (N)" bucket, and a per-project table as
the accessibility twin. One filter row (date range + rate model) scopes every
chart; caps are labeled, never silent (heatmap ≤52 weeks, daily chart ≤90
days on "all"). Colors were validated with a CVD/contrast checker against the
dark surface (categorical worst adjacent ΔE 41.3; sequential ramp monotone).
Cost is an equivalent-value estimate at published API rates — sessions don't
record the model per turn, so the rate model is user-selectable.

### Internal

- `SESSION_TRACKER_DIR` env override for the data directory (isolated testing).
- Data migration: `account` defaults to `null` on load; old files keep working.
- Demo page regenerated with multi-account example data.

## [1.0.3] - upstream

Baseline from [maleta/claude-sessions](https://github.com/maleta/claude-sessions):
Stop/SessionEnd hooks, Haiku summaries, per-project `SESSION_SUMMARIES.md`, static
web UI with search/grouping/hide/copy-resume, token accounting, stale-session
cleanup, `/clear` handling, session-history skill.
