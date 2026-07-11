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
  summary?: string;
  status?: string;
  branch?: string;
  messages?: number;
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

/**
 * Optional terminal preferences, read from <data dir>/terminal.json:
 *   { "wtProfile": "PowerShell", "shell": "pwsh", "linux": "konsole" }
 * - wtProfile: Windows Terminal profile name (wt -p <profile>)
 * - shell: what runs the resume command on Windows: "cmd" (default) or "pwsh"
 * - linux: preferred launcher (x-terminal-emulator|gnome-terminal|konsole|xterm)
 */
interface TerminalConfig {
  wtProfile?: string;
  shell?: string;
  linux?: string;
}

async function loadTerminalConfig(): Promise<TerminalConfig> {
  try {
    const cfg = await Bun.file(join(BASE_DIR, "terminal.json")).json();
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

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
function launchTerminal(sessionId: string, dir: string, fork = false, cfg: TerminalConfig = {}): string | null {
  const resume = `claude --resume ${sessionId}${fork ? " --fork-session" : ""}`;

  if (process.platform === "win32") {
    const inner = cfg.shell === "pwsh"
      ? ["pwsh", "-NoExit", "-Command", resume]
      : ["cmd", "/k", resume];
    const profile = cfg.wtProfile ? ["-p", cfg.wtProfile] : [];
    if (hasWindowsTerminal() && trySpawn(["cmd", "/c", "start", "", "wt", "-w", "-1", "nt", ...profile, "-d", dir, ...inner])) {
      return cfg.wtProfile ? `Windows Terminal (${cfg.wtProfile})` : "Windows Terminal";
    }
    if (trySpawn(["cmd", "/c", "start", "ClaudeSession", "/D", dir, ...inner])) {
      return cfg.shell === "pwsh" ? "pwsh" : "cmd";
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
  // Preferred launcher first, if configured
  if (cfg.linux) candidates.sort((a, b) => (b[0] === cfg.linux ? 1 : 0) - (a[0] === cfg.linux ? 1 : 0));
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

  const terminal = launchTerminal(session.id, dir, fork, await loadTerminalConfig());
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

// -- Transcript viewer --

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const PROJECTS_DIR = join(CONFIG_DIR, "projects");

/** Locate a session transcript on THIS machine (projects dirs are per-cwd). */
function findTranscript(id: string): string | null {
  let projects: string[] = [];
  try { projects = readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const proj of projects) {
    const p = join(PROJECTS_DIR, proj, `${id}.jsonl`);
    try { if (statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

interface TranscriptMessage {
  role: string;
  ts: string;
  text: string;
  tools: string[];
  model?: string;
}

/** One-line human label for a tool_use block. */
function toolLabel(block: Record<string, unknown>): string {
  const name = String(block.name ?? "tool");
  const input = (block.input ?? {}) as Record<string, unknown>;
  const hint = String(input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.prompt ?? "");
  const clean = hint.replace(/\s+/g, " ").trim();
  return clean ? `${name}: ${clean.slice(0, 160)}` : name;
}

/**
 * Parse a transcript into displayable messages: user text, assistant text and
 * tool calls. Tool RESULTS are skipped (they dominate transcript size and are
 * rarely what you're searching for). Consecutive lines of the same streamed
 * assistant message are merged into one entry.
 */
async function parseTranscript(path: string): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  let lastAssistantId = "";
  const text = await Bun.file(path).text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const message = (entry.message ?? {}) as Record<string, unknown>;
    const content = message.content;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";

    if (entry.type === "user") {
      lastAssistantId = "";
      let userText = "";
      if (typeof content === "string") {
        userText = content;
      } else if (Array.isArray(content)) {
        userText = content
          .filter(b => b && b.type === "text" && typeof b.text === "string")
          .map(b => b.text)
          .join("\n");
      }
      if (userText.trim()) {
        messages.push({ role: "user", ts, text: userText, tools: [] });
      }
      continue;
    }

    // assistant: text blocks + tool_use labels, merged per streamed message id
    const blocks = Array.isArray(content) ? content : [];
    const textParts: string[] = [];
    const tools: string[] = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) textParts.push(b.text);
      if (b.type === "tool_use") tools.push(toolLabel(b as Record<string, unknown>));
    }
    if (textParts.length === 0 && tools.length === 0) continue;
    const id = String(message.id ?? "");
    const model = typeof message.model === "string" && message.model !== "<synthetic>" ? message.model : undefined;
    const prev = messages[messages.length - 1];
    if (id && id === lastAssistantId && prev && prev.role === "assistant") {
      if (textParts.length) prev.text += (prev.text ? "\n" : "") + textParts.join("\n");
      prev.tools.push(...tools);
    } else {
      messages.push({ role: "assistant", ts, text: textParts.join("\n"), tools, model });
      lastAssistantId = id;
    }
  }
  return messages;
}

async function handleTranscript(url: URL): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(id)) {
    return json({ error: "invalid session id" }, 400);
  }
  // Same whitelist as resume: only sessions we track.
  const sessions = await loadSessions();
  if (!sessions.some(s => s.id === id)) {
    return json({ error: "unknown session id" }, 404);
  }
  const path = findTranscript(id);
  if (!path) {
    return json({ error: "transcript not found on this machine" }, 404);
  }
  try {
    const messages = await parseTranscript(path);
    return json({ id, count: messages.length, messages });
  } catch (e) {
    return json({ error: `failed to read transcript: ${e}` }, 500);
  }
}

// -- Markdown report ("what did I do this week") --

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDay(dateStr: string): string {
  const ts = Date.parse((dateStr || "").replace(" ", "T") + "Z");
  if (isNaN(ts)) return dateStr || "?";
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtMoney(v: number): string {
  if (v >= 100) return "$" + Math.round(v).toLocaleString("en-US");
  return "$" + v.toFixed(2);
}

function fmtDur(startStr: string, endStr: string): string {
  const a = Date.parse((startStr || "").replace(" ", "T") + "Z");
  const b = Date.parse((endStr || "").replace(" ", "T") + "Z");
  if (isNaN(a) || isNaN(b) || b <= a) return "";
  const min = Math.round((b - a) / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

async function handleReport(url: URL): Promise<Response> {
  const daysRaw = url.searchParams.get("days") ?? "7";
  const days = daysRaw === "all" ? Infinity : Math.max(1, Number(daysRaw) || 7);
  const sessions = (await mergedSessions()).filter(s => !s.meta?.deleted);
  const cutoff = days === Infinity ? -Infinity : Date.now() - days * 24 * 60 * 60 * 1000;

  interface ReportSession extends StoredSession { _ts: number; _cost: number }
  const inRange: ReportSession[] = [];
  for (const s of sessions) {
    const ts = Date.parse((s.updated_at ?? s.started_at ?? "").replace(" ", "T") + "Z");
    if (isNaN(ts) || ts < cutoff) continue;
    inRange.push({ ...s, _ts: ts, _cost: sessionCost(s) });
  }
  inRange.sort((a, b) => b._ts - a._ts);

  const byProject = new Map<string, ReportSession[]>();
  for (const s of inRange) {
    const key = s.project || s.project_path || "unknown";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(s);
  }
  const projects = Array.from(byProject.entries())
    .map(([name, list]) => ({ name, list, cost: list.reduce((sum, s) => sum + s._cost, 0) }))
    .sort((a, b) => b.cost - a.cost);

  const totalCost = inRange.reduce((sum, s) => sum + s._cost, 0);
  const totalOut = inRange.reduce((sum, s) => sum + (s.tokens?.output ?? 0), 0);
  const rangeLabel = days === Infinity ? "all time" : days === 7 ? "last 7 days" : `last ${days} days`;

  const lines: string[] = [];
  lines.push(`# Claude Code sessions — ${rangeLabel}`);
  lines.push("");
  const now = new Date();
  lines.push(`_Generated ${now.getDate()} ${MONTHS_SHORT[now.getMonth()]} ${now.getFullYear()} · ${inRange.length} sessions · ` +
    `${fmtMoney(totalCost)} API-equivalent · ${fmtTok(totalOut)} tokens generated_`);
  lines.push("");
  for (const proj of projects) {
    lines.push(`## ${proj.name} — ${proj.list.length} session${proj.list.length !== 1 ? "s" : ""} · ${fmtMoney(proj.cost)}`);
    lines.push("");
    for (const s of proj.list) {
      const m = s.meta ?? {};
      const title = m.title || s.title || "Untitled session";
      const summary = m.summary || s.summary || "";
      const status = m.status || s.status || "";
      const dur = fmtDur(s.started_at ?? "", s.updated_at ?? "");
      const startDay = fmtDay(s.started_at ?? "");
      const endDay = fmtDay(s.updated_at ?? "");
      const facts = [
        status,
        startDay + (endDay && endDay !== startDay ? ` → ${endDay}` : ""),
        dur,
        fmtMoney(s._cost),
        s.branch && s.branch !== "n/a" ? `\`${s.branch}\`` : "",
      ].filter(Boolean).join(" · ");
      lines.push(`- **${title}** — ${facts}`);
      if (summary) lines.push(`  ${summary}`);
      if (m.note) lines.push(`  > ${String(m.note).replace(/\n/g, " ")}`);
    }
    lines.push("");
  }
  if (inRange.length === 0) lines.push("_No sessions in this range._");

  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
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
    if (url.pathname === "/api/transcript" && req.method === "GET") {
      return handleTranscript(url);
    }
    if (url.pathname === "/api/report" && req.method === "GET") {
      return handleReport(url);
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
