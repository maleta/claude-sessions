#!/usr/bin/env bun
/**
 * Optional local server for the session tracker web UI.
 *
 * Serves the same static UI over http://127.0.0.1 and adds one endpoint,
 * POST /api/resume, that opens a NEW terminal window running
 * `claude --resume <session-id>` in the session's project directory.
 * With the UI served this way, clicking a session card resumes it.
 *
 * Opening index.html directly (file://) keeps working as before - the
 * server is only needed for click-to-resume.
 *
 * Usage:  bun ~/.claude/session-tracker/serve.ts   (auto-provisioned there)
 * Port:   4457 by default, override with SESSION_TRACKER_PORT.
 */

import { homedir } from "os";
import { join } from "path";
import { statSync } from "fs";

const BASE_DIR = process.env.SESSION_TRACKER_DIR
  ?? join(homedir(), ".claude", "session-tracker");
const SESSIONS_JS_FILE = join(BASE_DIR, "sessions-data.js");
const PORT = Number(process.env.SESSION_TRACKER_PORT ?? 4457);
// Read-only mode: browse/filter only, no resume endpoint. For serving the
// UI from a machine that doesn't hold the sessions (e.g. a NAS container).
const READONLY = process.env.SESSION_TRACKER_READONLY === "1";
// Bind address. Keep the localhost default; set 0.0.0.0 explicitly when
// running in a container (pair it with READONLY=1 unless you trust the LAN).
const HOST = process.env.SESSION_TRACKER_HOST ?? "127.0.0.1";

interface StoredSession {
  id: string;
  project_path?: string;
}

async function loadSessions(): Promise<StoredSession[]> {
  try {
    const text = await Bun.file(SESSIONS_JS_FILE).text();
    const jsonStr = text.replace("window.SESSIONS_DATA = ", "").trimEnd().replace(/;$/, "");
    return JSON.parse(jsonStr);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// -- Terminal launchers --

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function trySpawn(cmd: string[], cwd?: string): boolean {
  try {
    Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    return true;
  } catch {
    return false; // binary not found
  }
}

// Windows Terminal is an app-execution alias (reparse point) that Bun's fs
// stat/exists calls can't see and Bun.spawn can't launch directly - so detect
// it with where.exe and launch it through `cmd /c start`.
let _hasWt: boolean | null = null;
function hasWindowsTerminal(): boolean {
  if (_hasWt === null) {
    try {
      _hasWt = Bun.spawnSync(["where.exe", "wt.exe"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      _hasWt = false;
    }
  }
  return _hasWt;
}

/** Opens a new terminal window running `claude --resume <id>` in `dir`. */
function launchTerminal(sessionId: string, dir: string): string | null {
  const resume = `claude --resume ${sessionId}`;

  if (process.platform === "win32") {
    if (hasWindowsTerminal() && trySpawn(["cmd", "/c", "start", "", "wt", "-w", "-1", "nt", "-d", dir, "cmd", "/k", resume])) {
      return "Windows Terminal";
    }
    if (trySpawn(["cmd", "/c", "start", "ClaudeSession", "/D", dir, "cmd", "/k", resume])) {
      return "cmd";
    }
    return null;
  }

  if (process.platform === "darwin") {
    const shellCmd = `cd ${shQuote(dir)} && ${resume}`;
    const appleScript = shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (trySpawn([
      "osascript",
      "-e", 'tell application "Terminal" to activate',
      "-e", `tell application "Terminal" to do script "${appleScript}"`,
    ])) {
      return "Terminal.app";
    }
    return null;
  }

  // Linux: keep the shell open after claude exits
  const inner = `cd ${shQuote(dir)} && ${resume}; exec bash`;
  const candidates: Array<[string, string[]]> = [
    ["x-terminal-emulator", ["x-terminal-emulator", "-e", "bash", "-lc", inner]],
    ["gnome-terminal", ["gnome-terminal", "--working-directory", dir, "--", "bash", "-lc", `${resume}; exec bash`]],
    ["konsole", ["konsole", "--workdir", dir, "-e", "bash", "-lc", `${resume}; exec bash`]],
    ["xterm", ["xterm", "-e", "bash", "-lc", inner]],
  ];
  for (const [name, cmd] of candidates) {
    if (trySpawn(cmd)) return name;
  }
  return null;
}

// -- HTTP server --

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleResume(req: Request): Promise<Response> {
  if (READONLY) {
    return json({ error: "resume disabled (read-only server)" }, 403);
  }
  // Custom header forces a CORS preflight, which same-origin-only serving
  // rejects - so random web pages can't POST here from the browser.
  if (req.headers.get("x-session-tracker") !== "1") {
    return json({ error: "missing x-session-tracker header" }, 403);
  }

  let id = "";
  try {
    const body = await req.json();
    id = String(body.id ?? "");
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!/^[0-9a-zA-Z-]{8,64}$/.test(id)) {
    return json({ error: "invalid session id" }, 400);
  }

  // Whitelist: only sessions we tracked can be resumed, and the working
  // directory comes from our own data, never from the client.
  const sessions = await loadSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) {
    return json({ error: "unknown session id" }, 404);
  }

  const dir = session.project_path && isDirectory(session.project_path)
    ? session.project_path
    : homedir();

  const terminal = launchTerminal(session.id, dir);
  if (!terminal) {
    return json({ error: "no supported terminal emulator found" }, 500);
  }
  console.log(`resume ${session.id} in ${dir} (${terminal})`);
  return json({ ok: true, terminal });
}

// When running from the repo (before the hook ever provisioned BASE_DIR),
// fall back to the checked-in web UI next to this script.
const REPO_UI = join(import.meta.dir, "..", "web", "index.html");

function firstExisting(...paths: string[]): string {
  for (const p of paths) {
    try { if (statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return paths[0];
}

function serveStatic(pathname: string): Response {
  const files: Record<string, [string, string]> = {
    "/": [firstExisting(join(BASE_DIR, "index.html"), REPO_UI), "text/html; charset=utf-8"],
    "/index.html": [firstExisting(join(BASE_DIR, "index.html"), REPO_UI), "text/html; charset=utf-8"],
    "/sessions-data.js": [SESSIONS_JS_FILE, "text/javascript; charset=utf-8"],
  };
  const entry = files[pathname];
  if (!entry) return new Response("Not found", { status: 404 });
  const [path, type] = entry;
  const file = Bun.file(path);
  return new Response(file, { headers: { "Content-Type": type } });
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/config" && req.method === "GET") {
      return json({ resume: !READONLY });
    }
    if (url.pathname === "/api/resume" && req.method === "POST") {
      return handleResume(req);
    }
    if (req.method === "GET") {
      return serveStatic(url.pathname);
    }
    return new Response("Method not allowed", { status: 405 });
  },
});

console.log(`Claude Sessions UI: http://${HOST}:${PORT}`);
if (READONLY) {
  console.log("Read-only mode: resume disabled.");
} else {
  console.log("Click a session card to resume it in a new terminal window.");
}
