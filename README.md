# Claude Session Tracker

Automatically tracks and summarizes Claude Code sessions using Claude Haiku. Provides a web UI for browsing session history and generates per-project `SESSION_SUMMARIES.md` files for context in future conversations.

![Claude Sessions Web UI](demo/screenshot.png)

## Features

- **Automatic tracking** - Hooks fire on every response and session end
- **AI summaries** - Claude Haiku generates title, summary, topics, and status
- **Per-project summaries** - `SESSION_SUMMARIES.md` in each project directory for future session context
- **Web UI** - Sidebar facets (project, machine, account, status), cards or a dense sortable table, sort by recency/start date/cost/tokens/duration/messages in either direction, comfortable/compact density, and search with operators (`host:`, `status:`, `project:`, `model:`, `account:`, `branch:`, `before:`/`after:`)
- **Transcript viewer** - Read any session's full conversation (user + assistant messages, tool calls) in the browser, with in-transcript search, match highlighting and prev/next navigation
- **Cost & model per session** - The hook records token usage per model, so every card shows what that session would have cost on the API, which model ran it, exact start/last-activity timestamps and duration
- **Multi-account aware** - Each session is stamped with the account/subscription it ran under (email + plan); filter sessions by account in the UI
- **Resume commands** - One-click copy of `claude --resume <id>` commands
- **Click-to-resume & fork** - With the optional local server, the ▶ resume button opens a new terminal already resuming that session; ⑂ fork resumes it as a new branched session (`--fork-session`) leaving the original untouched
- **Backfill** - One command imports your whole pre-existing transcript history into the tracker (`--update-tokens` re-stamps per-model usage on sessions imported before model tracking)
- **Editing** - Fix Haiku's titles/summaries, add your own searchable notes, pin, archive or delete sessions from the UI (synced across machines, never lost to re-analysis)
- **Usage dashboard** - Activity heatmap, tokens per day by machine, per-model and top-project rankings, and an API-equivalent cost that uses exact per-model rates where available, with range filters and a table view
- **Markdown report** - `GET /api/report?days=7` renders a "what did I do this week" markdown report grouped by project, with per-session costs (📄 button in the dashboard)
- **Terminal profiles** - Optional `terminal.json` picks the Windows Terminal profile/shell (or preferred Linux terminal) that click-to-resume opens
- **Summary endpoint** - `GET /api/summary` serves today/this-week aggregates (sessions, cost, tokens) for widgets like a Glance custom-api panel
- **Session history skill** - Claude can read past session context via the plugin skill

## Requirements

- [Bun](https://bun.sh) 1.0+
- Claude Code CLI (uses your subscription via `claude -p --model haiku` - no API credits consumed)

## Installation

Add the marketplace and install the plugin:

```
/plugin marketplace add maleta/claude-sessions
/plugin install session-tracker@claude-session-tracker
```

That's it. The plugin auto-registers its hooks and provisions the web UI on first run.

## How it works

### Hooks

- **Stop** - Fires after each Claude response. Analyzes after 1+ user messages, re-analyzes every 5 additional messages.
- **SessionEnd** - Fires when a session ends. Consolidates all incremental summaries into a final one.

### SESSION_SUMMARIES.md

After each analysis, the hook writes/updates a `SESSION_SUMMARIES.md` file in the project directory. This file contains:
- Session title and summary from Haiku
- Date, branch, status, message count, topics
- Session ID and resume command

Future Claude sessions can read this file for context on past work (via the plugin's skill).

### Web UI

Static HTML file - no server needed, opens directly in the browser:

```bash
open ~/.claude/session-tracker/index.html
```

The web UI is auto-provisioned by the hook on first run. Layout: a sidebar of facet filters (projects with counts, machines, accounts, statuses, archived/deleted toggles) next to a single session feed, with a **clear filters** button whenever any filter or search is active. The feed renders as cards or as a dense table (sortable column headers), sorts by last activity, start date, cost, tokens, duration or messages in either direction, and has a comfortable/compact density toggle - view, sort and density are persisted per browser. Each card shows the session's API-equivalent cost and total tokens, the model(s) that ran it, exact start and last-activity timestamps in day-month-year format and local time (relative time alongside), duration, branch, message count, machine/account chips, summary, topics and your note. The search box combines free text with operators: `host:windpad status:debugging model:opus before:2026-07-01 broker`. Clicking a card opens the detail view; resume/fork are explicit buttons, so nothing launches by accident.

When served over http, the detail view also has a **📜 Transcript** button (sessions on the serving machine only): it loads the full conversation from the transcript - your messages, Claude's replies and one-line labels of every tool call (tool results are skipped; they dominate transcript size). The viewer has its own search with match highlighting, a match counter, prev/next jumps (Enter / Shift+Enter) and an "only matches" filter.

### Click-to-resume (optional local server)

To resume sessions by clicking their card, serve the UI locally instead of opening the file:

```bash
bun ~/.claude/session-tracker/serve.ts
# then open http://127.0.0.1:4457
```

The **▶ resume** button on a card opens a new terminal window (Windows Terminal/cmd, Terminal.app, or gnome-terminal/konsole/xterm) already running `claude --resume <id>` in that session's project directory. The **⑂ fork** button does the same with `--fork-session`: the conversation resumes as a NEW session id, so you can pick an old session's context back up without contaminating the original. The server binds to `127.0.0.1` only, and `/api/resume` only accepts session ids present in your own tracked data (the working directory always comes from the stored session, never from the request). Override the port with `SESSION_TRACKER_PORT`.

`serve.ts` is auto-provisioned to `~/.claude/session-tracker/` by the hook, same as the UI. Opening `index.html` directly (file://) keeps working - you just get copy-only buttons instead of click-to-resume.

Server environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_TRACKER_PORT` | `4457` | Listen port |
| `SESSION_TRACKER_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for containers) |
| `SESSION_TRACKER_READONLY` | unset | `1` disables `/api/resume` (browse/copy only) |
| `SESSION_TRACKER_DIR` | `~/.claude/session-tracker` | Data directory |

Since the hook provisions `index.html` and `serve.ts` into the data directory, you can serve the UI read-only from another machine (e.g. a NAS container) by syncing that directory and running:

```bash
SESSION_TRACKER_DIR=/data SESSION_TRACKER_HOST=0.0.0.0 SESSION_TRACKER_READONLY=1 bun /data/serve.ts
```

The UI asks the server (`GET /api/config`) whether resume is available and falls back to copy-only buttons when it isn't.

API endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/` , `/index.html` | GET | Web UI (falls back to the repo copy if the data dir has none) |
| `/sessions-data.js` | GET | Session data consumed by the UI |
| `/api/config` | GET | `{ "resume": bool }` - feature discovery for the UI |
| `/api/resume` | POST | `{ "id": "<session-id>", "fork": bool }` - opens a terminal resuming (or forking) that session |
| `/api/summary` | GET | Today/this-week aggregates (sessions, API-equivalent cost, output tokens) + last session - for widgets (e.g. a [Glance](https://github.com/glanceapp/glance) custom-api panel) |
| `/api/transcript` | GET | `?id=<session-id>` - parsed conversation (user/assistant text + tool-call labels) for the transcript viewer; sessions on this machine only |
| `/api/report` | GET | `?days=7\|30\|90\|all` - markdown report of the range, grouped by project with per-session costs |

Terminal preferences (optional): drop a `terminal.json` next to the data files to control what click-to-resume opens:

```json
{
  "wtProfile": "PowerShell",
  "shell": "pwsh",
  "linux": "konsole"
}
```

`wtProfile` is a Windows Terminal profile name (`wt -p <profile>`), `shell` picks what runs the resume command on Windows (`cmd`, the default, or `pwsh`), and `linux` puts your preferred launcher first (`x-terminal-emulator`, `gnome-terminal`, `konsole` or `xterm`). Omit the file for the previous defaults.

`/api/resume` safety model: localhost bind by default, a required custom header (`x-session-tracker: 1`) forces a CORS preflight so web pages on other origins can't trigger it, the session id must match the tracked data (400 on malformed, 404 on unknown), and the working directory comes from the stored session - never from the request. Terminal launchers per platform: `wt`/`cmd` on Windows (Windows Terminal is an app-execution alias that Bun can neither stat nor spawn, so it's detected with `where.exe` and launched through `cmd /c start`), `Terminal.app` via osascript on macOS, `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux.

### Editing, notes, archive and delete

Click a session's title (or its `details` button) to open the detail view: full metadata, the incremental summaries, and - when served over http - an edit form. You can override the title, summary, topics and status (the original values are kept and shown as a hint; saving a field back to its original clears the override), add a free-text **note** (shown on the card, searchable), **pin** the session to the top of its project, **archive** it (hidden behind a "show archived" toggle) or **delete** it.

Edits never touch the per-machine data files - the hooks own those and would overwrite your changes, and a removed entry would just be resurrected by the next backfill. Instead each serving machine writes its own `sessions-meta.<machine>.js` overlay (same zero-conflict single-writer rule as the data files), merged at read time. Practical consequences:

- Your edits always win over Haiku's analysis, even for still-active sessions.
- **Delete is a tombstone**: the session disappears everywhere, the backfill skips it, and it's restorable from "show deleted". For physical removal run `bun scripts/purge.ts` (dry-run; add `--apply`) on the machine that owns the entries - tombstones are kept so backfills stay blocked. Transcripts in `~/.claude/projects` are never touched.
- Set `SESSION_TRACKER_NO_EDIT=1` to disable the editing endpoint on a server.

The UI auto-refreshes every minute in server mode, so edits and new sessions from other machines/browsers appear on their own. On `file://` the UI stays read-only (with the old per-browser hide); existing localStorage hides are migrated to synced archives the first time you use an edit-capable server.

### Usage dashboard

The **📊 stats** button opens a usage dashboard over the same data: a KPI row (sessions, tokens generated, cache read, API-equivalent value), a GitHub-style activity heatmap, tokens-per-day stacked by machine, a by-model ranking, a top-projects ranking, and a per-project table. A range filter (7/30/90 days or all) scopes everything. The main UI's header shows the same idea at a glance: sessions today, $ today and $ last 7 days.

The cost figure is an *equivalent value*, not a bill - published API rates (input, output, cache read ≈0.1× input, cache write ≈1.25× input at 5-minute TTL) applied to the token counts. Sessions carry a per-model token breakdown (`models`), so each model is priced at its own rate. Sessions tracked before model recording (or whose transcripts live on another machine) fall back to the **fallback $** selector's rates and are marked as estimated (`~` on cards, "(assumed)" in the by-model chart); run `bun scripts/backfill.ts --update-tokens` on the machine that owns them to stamp exact data. For subscription users it reads as "what this usage would have cost on the API". Deleted sessions are excluded; archived ones count.

The **📄 report (md)** button (server mode) renders the current range as a markdown report - sessions grouped by project, each with status, dates, duration, cost and its summary - straight from `GET /api/report?days=<n|all>`. Pipe it wherever you like:

```bash
curl -s http://127.0.0.1:4457/api/report?days=7 > weekly-report.md
```

To push a recurring digest to Telegram, create a bot with [@BotFather](https://t.me/BotFather) and drop a `telegram.json` in the data dir:

```json
{
  "botToken": "123456:ABC-DEF...",
  "chatId": "-1001234567890",
  "threadId": 42,
  "days": 7
}
```

`chatId` is your user id or a group/channel id; `threadId` is optional (a forum topic). Then:

```bash
bun scripts/report-telegram.ts --dry-run   # preview the message
bun scripts/report-telegram.ts             # send it
```

Schedule it (cron / Task Scheduler) for a weekly summary. Env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_THREAD_ID`, `REPORT_DAYS`) override the file, and `--days N` overrides the range. Keep `telegram.json` out of version control (it's gitignored).

### Glance widget

If you run a [Glance](https://github.com/glanceapp/glance) dashboard, `/api/summary` slots straight into a `custom-api` widget:

```yaml
- type: custom-api
  title: Claude Sessions
  url: http://127.0.0.1:4457/api/summary
  cache: 5m
  template: |
    <div class="flex justify-between text-center">
      <div>
        <div class="color-highlight size-h3">{{ .JSON.Int "today.sessions" }}</div>
        <div class="size-h6">TODAY</div>
      </div>
      <div>
        <div class="color-highlight size-h3">${{ .JSON.Float "today.cost" | printf "%.2f" }}</div>
        <div class="size-h6">$ TODAY</div>
      </div>
      <div>
        <div class="color-highlight size-h3">${{ .JSON.Float "week.cost" | printf "%.0f" }}</div>
        <div class="size-h6">$ 7 DAYS</div>
      </div>
    </div>
    <div class="margin-top-15 size-h5 text-truncate">{{ .JSON.String "last_session.title" }}</div>
    <div class="size-h6 color-subdue">{{ .JSON.String "last_session.project" }} · {{ .JSON.Int "last_session.ago_minutes" }}m ago</div>
```

Point the URL at whichever machine serves your (synced) data dir; the summary covers all machines' sessions.

### Backfill your history

The tracker only records sessions from the moment it's installed. To import everything you did before, run (from the plugin directory):

```bash
bun scripts/backfill.ts [--dry-run] [--limit N] [--concurrency N] [--exclude <regex>] [--account <email[:plan]>] [--update-tokens]
```

It scans `~/.claude/projects/**/*.jsonl`, skips sessions already tracked and empty transcripts, extracts metadata (project, branch, dates, tokens) straight from each transcript and asks Haiku for the title/summary/topics - the same analysis the live hook does. Progress is saved after every session, so it's safe to interrupt and re-run. Use `--exclude` to leave out transcripts whose path matches a regex (e.g. throwaway test-harness dirs); exclusions are counted and reported.

Backfilled sessions have no account info by default (transcripts don't record it), but if you know which subscription a machine or an era of history was used with, `--account "old@example.com:Pro"` stamps it on everything imported by that run - so old-account sessions get their own filter chip. Unlike the live hook, the backfill never writes `SESSION_SUMMARIES.md` into your project directories.

`--update-tokens` is a separate maintenance mode: it recomputes `tokens` AND the per-model breakdown (`models`) for sessions **already tracked** on this machine, straight from the transcripts - no Haiku calls, titles/summaries untouched. Run it once after upgrading to get exact per-model costs on your existing history.

### Multiple machines

Every session records the machine it ran on (`host`, from the hostname; `SESSION_TRACKER_HOSTNAME` overrides). Each machine writes its own `sessions-data.<host>.js`, so you can sync the data directory between machines (e.g. with Syncthing) and never get sync conflicts - no two machines write the same file. `serve.ts` merges all data files it finds and serves the combined set.

With 2+ machines in the data the UI shows host filter chips and a host badge per card, and groups sessions by **project name** rather than absolute path - with a synced dev folder the same repo lives at a different path on every machine, and this keeps it as one column (all paths are in the group tooltip).

Resume is host-aware: clicking a session from the machine the server runs on opens a terminal as usual; clicking one from another machine copies a command instead. Drop an optional `remote-hosts.json` in the data dir to control what gets copied:

```json
{
  "my-server": {
    "label": "dev server",
    "command": "ssh me@server \"cd {path} && claude --resume {id}\""
  }
}
```

`{id}`, `{path}` and `{project}` are filled from the session. Without an entry, the plain `claude --resume <id>` is copied. `/api/resume` refuses sessions from other hosts either way.

Single-machine setups are unaffected: the legacy `sessions-data.js` keeps being written (and `file://` browsing keeps working) until a second machine's data file appears in the dir.

### Multiple accounts / subscriptions

Every session is stamped with the account it ran under - email and plan (`Max 20x`, `Pro`, `Team`, ...) - read from the `.claude.json` of the Claude Code process that fired the hook (`CLAUDE_CONFIG_DIR` is respected, so per-account config dirs are attributed correctly).

If your data contains sessions from 2+ accounts, the web UI shows one filter chip per account (click to filter, click again to clear) and each card gets a colored account dot. Sessions tracked before this feature existed appear as "untracked account".

### Configuration

Disable `SESSION_SUMMARIES.md` for a specific project by adding to `<project>/.claude/settings.local.json`:

```json
{
  "sessionTracker": {
    "summaryFile": false
  }
}
```

## Data flow

```
Hook fires (Stop/SessionEnd)                 scripts/backfill.ts (one-shot)
  |                                             |
  v  (count messages from transcript)           v  (scan ~/.claude/projects/**/*.jsonl)
  |                                             |
  v  (threshold: 1st message, then every 5)     v  (skip tracked/empty transcripts)
  |                                             |
  v  (Haiku summary via claude -p)              v  (same Haiku analysis)
  |                                             |
  v  (stamp account from .claude.json)          v  (account: null - not recorded)
  |                                             |
  +---------------------+-----------------------+
                        v
~/.claude/session-tracker/sessions-data.js    <-- single source of truth
        |                       |
        v (live hook only)      v (serve.ts, optional)
<project>/SESSION_SUMMARIES.md  http://127.0.0.1:4457 (click-to-resume,
    per-project context           or READONLY=1 remote viewer)
```

## Session data format

Each entry in `sessions-data.js` is a JSON object:

| Field | Meaning |
|---|---|
| `id` | Session UUID (= transcript filename, what `claude --resume` takes) |
| `started_at` / `updated_at` | `YYYY-MM-DD HH:mm` timestamps |
| `project` / `project_path` | Directory name / absolute path the session ran in |
| `branch` | Git branch at analysis time (`n/a` outside a repo) |
| `title` / `summary` / `topics` / `status` | Haiku analysis (`status`: completed, in-progress, exploring, debugging) |
| `messages` | Count of real user messages (tool results excluded) |
| `tokens` | `{ input, output, cache_write, cache_read }` accumulated from the transcript |
| `models` | Same shape keyed by raw model id (e.g. `claude-opus-4-8`) - per-model usage for exact cost; `{}` on pre-feature data until `--update-tokens` runs |
| `resume` | Ready-to-paste `claude --resume <id>` command |
| `account` | `{ uuid, email, plan }` of the subscription the session ran under, or `null` if unknown (pre-feature or backfilled) |
| `last_analyzed_at` / `analysis_count` / `summaries` | Incremental-analysis bookkeeping used by the hook |

Old data files migrate transparently: missing fields are defaulted on load.

## Uninstall

Disable the plugin in Claude Code settings or remove it from `enabledPlugins` in `~/.claude/settings.json`.

To also remove session data:

```bash
rm -rf ~/.claude/session-tracker/
```

## License

MIT
