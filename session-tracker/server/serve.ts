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

import { homedir, hostname } from "os";
import { join } from "path";
import { statSync, readdirSync } from "fs";

const BASE_DIR = process.env.SESSION_TRACKER_DIR
  ?? join(homedir(), ".claude", "session-tracker");
const SESSIONS_JS_FILE = join(BASE_DIR, "sessions-data.js");
const REMOTES_FILE = join(BASE_DIR, "remote-hosts.json");

// Must match the hook's sanitization (serve.ts is provisioned standalone)
function sanitizeHost(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}
const MACHINE = sanitizeHost(process.env.SESSION_TRACKER_HOSTNAME ?? hostname());
const PORT = Number(process.env.SESSION_TRACKER_PORT ?? 4457);
// Read-only mode: browse/filter only, no resume endpoint. For serving the
// UI from a machine that doesn't hold the sessions (e.g. a NAS container).
// Editing session METADATA (titles, notes, archive/delete) is independent
// of resume and stays available unless explicitly disabled.
const READONLY = process.env.SESSION_TRACKER_READONLY === "1";
const NO_EDIT = process.env.SESSION_TRACKER_NO_EDIT === "1";
// Bind address. Keep the localhost default; set 0.0.0.0 explicitly when
// running in a container (pair it with READONLY=1 unless you trust the LAN).
const HOST = process.env.SESSION_TRACKER_HOST ?? "127.0.0.1";

interface TokenUsage {
  input?: number;
  output?: number;
  cache_write?: number;
  cache_read?: number;
}

interface StoredSession {
  id: string;
  project?: string;
  project_path?: string;
  title?: string;
  started_at?: string;
  updated_at?: string;
  tokens?: TokenUsage;
  models?: Record<string, TokenUsage>;
  host?: string;
  meta?: MetaEntry | null;
}

async function parseDataFile(path: string): Promise<StoredSession[]> {
  try {
    const text = await Bun.file(path).text();
    const jsonStr = text.replace("window.SESSIONS_DATA = ", "").trimEnd().replace(/;$/, "");
    return JSON.parse(jsonStr);
  } catch {
    return [];
  }
}

/**
 * Merge every data file in the dir: the legacy single-host file plus one
 * sessions-data.<host>.js per machine (multi-machine setups sync the dir;
 * each machine only writes its own file). Host files win on duplicate ids.
 */
async function loadSessions(): Promise<StoredSession[]> {
  let names: string[] = [];
  try { names = readdirSync(BASE_DIR); } catch { /* no data dir yet */ }
  const hostFiles = names.filter(f => /^sessions-data\..+\.js$/.test(f)).sort();
  const byId = new Map<string, StoredSession>();
  for (const s of await parseDataFile(SESSIONS_JS_FILE)) byId.set(s.id, s);
  for (const f of hostFiles) {
    for (const s of await parseDataFile(join(BASE_DIR, f))) byId.set(s.id, s);
  }
  return Array.from(byId.values());
}

// -- Session metadata overlay --
//
// User edits (title/summary/topics/status), notes, pin, archive and delete
// tombstones live in sessions-meta.<machine>.js files, NEVER in the data
// files (those belong to each machine's hook, which would overwrite edits;
// and deleting a data entry would just get resurrected by the next
// backfill). Each serving machine only writes its own meta file - same
// zero-conflict-by-design rule as the data files. Merge: newest ts wins.

interface MetaEntry {
  ts?: number;
  deleted?: boolean;
  archived?: boolean;
  pinned?: boolean;
  note?: string;
  title?: string;
  summary?: string;
  topics?: string;
  status?: string;
}

const META_FIELDS = ["deleted", "archived", "pinned", "note", "title", "summary", "topics", "status"] as const;
const OWN_META_FILE = join(BASE_DIR, `sessions-meta.${MACHINE}.js`);
const LEGACY_META_FILE = join(BASE_DIR, "sessions-meta.js");

async function parseMetaFile(path: string): Promise<Record<string, MetaEntry>> {
  try {
    const text = await Bun.file(path).text();
    const jsonStr = text.replace("window.SESSIONS_META = ", "").trimEnd().replace(/;$/, "");
    const meta = JSON.parse(jsonStr);
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}

async function loadAllMeta(): Promise<Record<string, MetaEntry>> {
  let names: string[] = [];
  try { names = readdirSync(BASE_DIR); } catch { /* no data dir yet */ }
  const metaFiles = names.filter(f => /^sessions-meta\..+\.js$/.test(f)).sort();
  const merged: Record<string, MetaEntry> = await parseMetaFile(LEGACY_META_FILE);
  for (const f of metaFiles) {
    const m = await parseMetaFile(join(BASE_DIR, f));
    for (const [id, entry] of Object.entries(m)) {
      if (!merged[id] || (entry.ts ?? 0) >= (merged[id].ts ?? 0)) merged[id] = entry;
    }
  }
  return merged;
}

async function saveOwnMeta(meta: Record<string, MetaEntry>): Promise<void> {
  const content = "window.SESSIONS_META = " + JSON.stringify(meta, null, 2) + ";\n";
  await Bun.write(OWN_META_FILE, content);
  // Single-machine mirror so file:// browsing sees edits too
  let names: string[] = [];
  try { names = readdirSync(BASE_DIR); } catch { /* ignore */ }
  const others = names.filter(f => /^sessions-meta\..+\.js$/.test(f) && f !== `sessions-meta.${MACHINE}.js`);
  if (others.length === 0) {
    await Bun.write(LEGACY_META_FILE, content);
  }
}

interface RemoteHost {
  command?: string;
  label?: string;
}

/** All sessions with their metadata overlay attached. */
async function mergedSessions(): Promise<StoredSession[]> {
  const sessions = await loadSessions();
  const meta = await loadAllMeta();
  for (const s of sessions) s.meta = meta[s.id] ?? null;
  return sessions;
}

async function handleMetaUpdate(req: Request): Promise<Response> {
  if (NO_EDIT) {
    return json({ error: "editing disabled on this server" }, 403);
  }
  if (req.headers.get("x-session-tracker") !== "1") {
    return json({ error: "missing x-session-tracker header" }, 403);
  }
  let id = "", patch: Record<string, unknown> = {};
  try {
    const body = await req.json();
    id = String(body.id ?? "");
    if (body.patch && typeof body.patch === "object") patch = body.patch;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const sessions = await loadSessions();
  if (!sessions.some(s => s.id === id)) {
    return json({ error: "unknown session id" }, 404);
  }

  // Base the new entry on the MERGED view so an edit made on machine A
  // doesn't drop a note made on machine B (whole-entry-newest-wins merge).
  const current = (await loadAllMeta())[id] ?? {};
  const entry: MetaEntry = { ...current };
  for (const field of META_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null || value === undefined || value === false || value === "") {
      delete entry[field]; // reset to the original value
    } else if (field === "deleted" || field === "archived" || field === "pinned") {
      entry[field] = true;
    } else {
      entry[field] = String(value).slice(0, 10000);
    }
  }
  entry.ts = Date.now();

  const own = await parseMetaFile(OWN_META_FILE);
  own[id] = entry; // kept even when empty: a newer empty entry shadows older ones
  await saveOwnMeta(own);
  return json({ ok: true, meta: entry });
}

async function loadRemotes(): Promise<Record<string, RemoteHost>> {
  try {
    const remotes = await Bun.file(REMOTES_FILE).json();
    return remotes && typeof remotes === "object" ? remotes : {};
  } catch {
    return {};
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
function launchTerminal(sessionId: string, dir: string, fork = false): string | null {
  const resume = `claude --resume ${sessionId}${fork ? " --fork-session" : ""}`;

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

  let id = "", fork = false;
  try {
    const body = await req.json();
    id = String(body.id ?? "");
    fork = body.fork === true;
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

  // Sessions live on the machine that ran them - we can only resume our own
  if (session.host && session.host !== MACHINE) {
    return json({ error: `session belongs to host "${session.host}" - resume it there` }, 400);
  }

  const dir = session.project_path && isDirectory(session.project_path)
    ? session.project_path
    : homedir();

  const terminal = launchTerminal(session.id, dir, fork);
  if (!terminal) {
    return json({ error: "no supported terminal emulator found" }, 500);
  }
  console.log(`${fork ? "fork" : "resume"} ${session.id} in ${dir} (${terminal})`);
  return json({ ok: true, terminal, fork });
}

// -- Summary (for widgets, e.g. a Glance custom-api panel) --

// API-equivalent $/1M tokens by model family/version. Cache read ≈ 0.1× input,
// cache write ≈ 1.25× input (5-minute TTL). Mirrors the web UI's table.
function resolveRate(modelId: string): { in: number; out: number } | null {
  const m = modelId.toLowerCase().match(/(opus|sonnet|haiku|fable)[-\s]?(\d+)(?:[.-](\d+))?/);
  if (!m) return null;
  const ver = parseFloat(`${m[2]}.${m[3] ?? "0"}`);
  switch (m[1]) {
    case "fable": return { in: 10, out: 50 };
    case "opus": return ver >= 4.5 ? { in: 5, out: 25 } : { in: 15, out: 75 };
    case "sonnet": return { in: 3, out: 15 };
    case "haiku": return ver >= 4.5 ? { in: 1, out: 5 } : { in: 0.8, out: 4 };
    default: return null;
  }
}

const FALLBACK_RATE = { in: 5, out: 25 }; // Opus 4.8, for sessions without model data

function usageCost(tk: TokenUsage, rate: { in: number; out: number }): number {
  return ((tk.input ?? 0) * rate.in + (tk.output ?? 0) * rate.out
    + (tk.cache_read ?? 0) * 0.1 * rate.in + (tk.cache_write ?? 0) * 1.25 * rate.in) / 1e6;
}

function sessionCost(s: StoredSession): number {
  const models = Object.entries(s.models ?? {});
  if (models.length > 0) {
    return models.reduce((sum, [id, tk]) => sum + usageCost(tk, resolveRate(id) ?? FALLBACK_RATE), 0);
  }
  return s.tokens ? usageCost(s.tokens, FALLBACK_RATE) : 0;
}

async function handleSummary(): Promise<Response> {
  const sessions = (await mergedSessions()).filter(s => !s.meta?.deleted);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const bucket = () => ({ sessions: 0, cost: 0, tokens_out: 0 });
  const today = bucket(), week = bucket();
  let last: StoredSession | null = null;
  let lastTs = 0;

  for (const s of sessions) {
    const ts = Date.parse((s.updated_at ?? s.started_at ?? "").replace(" ", "T") + "Z");
    if (isNaN(ts)) continue;
    const cost = sessionCost(s);
    const out = s.tokens?.output ?? 0;
    if (ts >= todayStart) { today.sessions++; today.cost += cost; today.tokens_out += out; }
    if (ts >= weekStart) { week.sessions++; week.cost += cost; week.tokens_out += out; }
    if (ts > lastTs) { lastTs = ts; last = s; }
  }
  const round = (b: ReturnType<typeof bucket>) => ({ ...b, cost: Math.round(b.cost * 100) / 100 });

  return json({
    host: MACHINE,
    generated_at: now.toISOString(),
    today: round(today),
    week: round(week),
    last_session: last ? {
      title: last.meta?.title ?? last.title ?? "",
      project: last.project ?? "",
      host: last.host ?? "",
      updated_at: last.updated_at ?? "",
      ago_minutes: Math.max(0, Math.round((now.getTime() - lastTs) / 60000)),
    } : null,
  });
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

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === "/sessions-data.js") {
    // Merged view across all machines' data files, with metadata attached
    const merged = await mergedSessions();
    const body = "window.SESSIONS_DATA = " + JSON.stringify(merged, null, 2) + ";\n";
    return new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
  }
  const files: Record<string, [string, string]> = {
    "/": [firstExisting(join(BASE_DIR, "index.html"), REPO_UI), "text/html; charset=utf-8"],
    "/index.html": [firstExisting(join(BASE_DIR, "index.html"), REPO_UI), "text/html; charset=utf-8"],
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
      // host lets the UI tell local sessions (clickable resume) from remote
      // ones (copy a remote command from remote-hosts.json, if configured)
      return json({ resume: !READONLY, edit: !NO_EDIT, host: MACHINE, remotes: await loadRemotes() });
    }
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return json(await mergedSessions());
    }
    if (url.pathname === "/api/summary" && req.method === "GET") {
      return handleSummary();
    }
    if (url.pathname === "/api/meta" && req.method === "POST") {
      return handleMetaUpdate(req);
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
