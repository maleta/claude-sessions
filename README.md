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
Hook fires (Stop/SessionEnd)
  |
  v  (count messages from transcript)
  |
  v  (check threshold: 1+ messages first time, then every 5 more)
  |
  v  (call Haiku via claude -p for summary)
  |
  v
~/.claude/session-tracker/sessions-data.js    <-- single source of truth
  |
  v  (also written per project)
  |
  v
<project>/SESSION_SUMMARIES.md                <-- per-project context
```

## Uninstall

Disable the plugin in Claude Code settings or remove it from `enabledPlugins` in `~/.claude/settings.json`.

To also remove session data:

```bash
rm -rf ~/.claude/session-tracker/
```

## License

MIT
