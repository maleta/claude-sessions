# Claude Session Tracker

Automatically tracks and summarizes Claude Code sessions using Claude Haiku. Provides a web UI for browsing session history and generates per-project `SESSION_SUMMARIES.md` files for context in future conversations.

![Claude Sessions Web UI](demo/screenshot.png)

## Features

- **Automatic tracking** - Hooks fire on every response and session end
- **AI summaries** - Claude Haiku generates title, summary, topics, and status
- **Per-project summaries** - `SESSION_SUMMARIES.md` in each project directory for future session context
- **Web UI** - Search, filter, hide/restore sessions grouped by project
- **Multi-account aware** - Each session is stamped with the account/subscription it ran under (email + plan); filter sessions by account in the UI
- **Resume commands** - One-click copy of `claude --resume <id>` commands
- **Click-to-resume** - With the optional local server, clicking a session card opens a new terminal already resuming that session
- **Backfill** - One command imports your whole pre-existing transcript history into the tracker
- **Editing** - Fix Haiku's titles/summaries, add your own searchable notes, pin, archive or delete sessions from the UI (synced across machines, never lost to re-analysis)
- **Usage dashboard** - Activity heatmap, tokens per day by machine, top projects, and an API-equivalent cost estimate (pick the model rates), with range filters and a table view
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

The web UI is auto-provisioned by the hook on first run. Features: search, project grouping, status badges, hide/restore, copy resume commands.

### Click-to-resume (optional local server)

To resume sessions by clicking their card, serve the UI locally instead of opening the file:

```bash
bun ~/.claude/session-tracker/serve.ts
# then open http://127.0.0.1:4457
```

Clicking a card opens a new terminal window (Windows Terminal/cmd, Terminal.app, or gnome-terminal/konsole/xterm) already running `claude --resume <id>` in that session's project directory. The server binds to `127.0.0.1` only, and `/api/resume` only accepts session ids present in your own tracked data (the working directory always comes from the stored session, never from the request). Override the port with `SESSION_TRACKER_PORT`.

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
| `/api/resume` | POST | `{ "id": "<session-id>" }` - opens a terminal resuming that session |

`/api/resume` safety model: localhost bind by default, a required custom header (`x-session-tracker: 1`) forces a CORS preflight so web pages on other origins can't trigger it, the session id must match the tracked data (400 on malformed, 404 on unknown), and the working directory comes from the stored session - never from the request. Terminal launchers per platform: `wt`/`cmd` on Windows (Windows Terminal is an app-execution alias that Bun can neither stat nor spawn, so it's detected with `where.exe` and launched through `cmd /c start`), `Terminal.app` via osascript on macOS, `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux.

### Editing, notes, archive and delete

Click a session's title (or its `details` button) to open the detail view: full metadata, the incremental summaries, and - when served over http - an edit form. You can override the title, summary, topics and status (the original values are kept and shown as a hint; saving a field back to its original clears the override), add a free-text **note** (shown on the card, searchable), **pin** the session to the top of its project, **archive** it (hidden behind a "show archived" toggle) or **delete** it.

Edits never touch the per-machine data files - the hooks own those and would overwrite your changes, and a removed entry would just be resurrected by the next backfill. Instead each serving machine writes its own `sessions-meta.<machine>.js` overlay (same zero-conflict single-writer rule as the data files), merged at read time. Practical consequences:

- Your edits always win over Haiku's analysis, even for still-active sessions.
- **Delete is a tombstone**: the session disappears everywhere, the backfill skips it, and it's restorable from "show deleted". For physical removal run `bun scripts/purge.ts` (dry-run; add `--apply`) on the machine that owns the entries - tombstones are kept so backfills stay blocked. Transcripts in `~/.claude/projects` are never touched.
- Set `SESSION_TRACKER_NO_EDIT=1` to disable the editing endpoint on a server.

The UI auto-refreshes every minute in server mode, so edits and new sessions from other machines/browsers appear on their own. On `file://` the UI stays read-only (with the old per-browser hide); existing localStorage hides are migrated to synced archives the first time you use an edit-capable server.

### Usage dashboard

The **📊 stats** button opens a usage dashboard over the same data: a KPI row (sessions, tokens generated, cache read, API-equivalent value), a GitHub-style activity heatmap, tokens-per-day stacked by machine, a top-projects ranking, and a per-project table. A range filter (7/30/90 days or all) scopes everything, and the **$ as** selector picks which model's API rates the cost estimate uses.

The cost figure is an *equivalent value*, not a bill: sessions don't record which model each turn ran on, so the dashboard applies one model's published API rates (input, output, cache read ≈0.1× input, cache write ≈1.25× input at 5-minute TTL) to the accumulated token counts. For subscription users it reads as "what this usage would have cost on the API". Deleted sessions are excluded; archived ones count.

### Backfill your history

The tracker only records sessions from the moment it's installed. To import everything you did before, run (from the plugin directory):

```bash
bun scripts/backfill.ts [--dry-run] [--limit N] [--concurrency N] [--exclude <regex>] [--account <email[:plan]>]
```

It scans `~/.claude/projects/**/*.jsonl`, skips sessions already tracked and empty transcripts, extracts metadata (project, branch, dates, tokens) straight from each transcript and asks Haiku for the title/summary/topics - the same analysis the live hook does. Progress is saved after every session, so it's safe to interrupt and re-run. Use `--exclude` to leave out transcripts whose path matches a regex (e.g. throwaway test-harness dirs); exclusions are counted and reported.

Backfilled sessions have no account info by default (transcripts don't record it), but if you know which subscription a machine or an era of history was used with, `--account "old@example.com:Pro"` stamps it on everything imported by that run - so old-account sessions get their own filter chip. Unlike the live hook, the backfill never writes `SESSION_SUMMARIES.md` into your project directories.

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
