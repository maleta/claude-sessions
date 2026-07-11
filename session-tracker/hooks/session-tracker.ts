#!/usr/bin/env bun
/**
 * Session Tracker Hook for Claude Code.
 *
 * Fires on Stop (async) and SessionEnd (--final) events.
 * - After 1st user message: full analysis, captures started_at
 * - Every 5 messages after: delta-only analysis (new messages since last)
 * - On session end: consolidates all incremental summaries into a final one
 */

import { mkdirSync, statSync, copyFileSync, unlinkSync, readdirSync } from "fs";
import { homedir, hostname } from "os";
import { join, basename } from "path";

export const BASE_DIR = process.env.SESSION_TRACKER_DIR
  ?? join(homedir(), ".claude", "session-tracker");

/** Sanitized machine name: filename-safe, stable across runs. */
export function sanitizeHost(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}
export const HOST = sanitizeHost(process.env.SESSION_TRACKER_HOSTNAME ?? hostname());

// One data file per machine: multi-machine setups sync the data dir and every
// machine only ever writes its own file, so the sync never sees two writers.
const SESSIONS_JS_FILE = join(BASE_DIR, "sessions-data.js"); // legacy / single-host merged
const HOST_JS_FILE = join(BASE_DIR, `sessions-data.${HOST}.js`);
const SUMMARIES_FILENAME = "SESSION_SUMMARIES.md";
const WEB_UI_SOURCE = join(import.meta.dir, "..", "web", "index.html");
const WEB_UI_TARGET = join(BASE_DIR, "index.html");
const SERVER_SOURCE = join(import.meta.dir, "..", "server", "serve.ts");
const SERVER_TARGET = join(BASE_DIR, "serve.ts");

const FIRST_THRESHOLD = 1;
const RE_ANALYSIS_INTERVAL = 5;
const MAX_CONVERSATION_CHARS = 4000;
const MAX_ASSISTANT_BLOCK_CHARS = 500;
const STALE_SESSION_DAYS = 4;

const SUMMARY_PROMPT = `Analyze this Claude Code conversation excerpt and return a JSON object with these fields:
- "title": short descriptive title (5-10 words)
- "summary": 2-3 sentence summary of what was discussed/accomplished
- "topics": comma-separated list of key topics (3-6 topics)
- "status": one of "completed", "in-progress", "exploring", "debugging"

Conversation:
{conversation}

Return ONLY valid JSON, nothing else.`;

const FINAL_SUMMARY_PROMPT = `You are summarizing a complete Claude Code session. Below are incremental summaries captured during the session. Create a final consolidated summary.

Incremental summaries:
{summaries}

Return a JSON object with these fields:
- "title": short descriptive title for the entire session (5-10 words)
- "summary": 2-3 sentence summary of the complete session
- "topics": comma-separated list of all key topics covered (3-8 topics)
- "status": one of "completed", "in-progress", "exploring", "debugging"

Return ONLY valid JSON, nothing else.`;

// -- Types --

export interface TokenUsage {
  input: number;        // uncached input tokens (full price)
  output: number;       // output tokens
  cache_write: number;  // cache_creation_input_tokens
  cache_read: number;   // cache_read_input_tokens (cache hits)
}

export interface UsageBreakdown {
  totals: TokenUsage;
  /** Per-model usage, keyed by the raw model id from the transcript. */
  models: Record<string, TokenUsage>;
}

export interface AccountInfo {
  uuid: string;
  email: string;
  plan: string;
}

export interface Session {
  id: string;
  started_at: string;
  updated_at: string;
  project: string;
  project_path: string;
  branch: string;
  title: string;
  summary: string;
  topics: string;
  status: string;
  messages: number;
  resume: string;
  last_analyzed_at: number;
  analysis_count: number;
  summaries: string[];
  tokens: TokenUsage;
  models: Record<string, TokenUsage>;
  account: AccountInfo | null;
  host: string;
}

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  session_end_reason?: string;
}

export interface SummaryResult {
  title?: string;
  summary?: string;
  topics?: string;
  status?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptEntry {
  type: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: Usage;
  };
}

// -- Data I/O --

export function parseSessionsJs(text: string): Session[] {
  try {
    const jsonStr = text.replace("window.SESSIONS_DATA = ", "").trimEnd().replace(/;$/, "");
    const sessions: Session[] = JSON.parse(jsonStr);
    for (const s of sessions) {
      // Migrate old format: date -> started_at + updated_at
      const legacy = s as Record<string, unknown>;
      if (legacy.date && !s.started_at) {
        s.started_at = legacy.date as string;
        s.updated_at = legacy.date as string;
        delete legacy.date;
      }
      if (!s.summaries) s.summaries = [];
      if (!s.tokens) s.tokens = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
      if (!s.models) s.models = {};
      if (s.account === undefined) s.account = null;
      if (!s.host) s.host = "";
    }
    return sessions;
  } catch {
    return [];
  }
}

export async function loadSessionsFrom(path: string): Promise<Session[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return parseSessionsJs(await file.text());
}

/** Other machines' data files present in the (possibly synced) data dir. */
export function otherHostFiles(): string[] {
  try {
    return readdirSync(BASE_DIR)
      .filter(f => /^sessions-data\..+\.js$/.test(f) && f !== `sessions-data.${HOST}.js`)
      .map(f => join(BASE_DIR, f));
  } catch {
    return [];
  }
}

/**
 * Sessions tracked by THIS machine. First run migrates the legacy
 * single-file data (pre multi-host) into this host's file.
 */
export async function loadSessions(): Promise<Session[]> {
  const own = await loadSessionsFrom(HOST_JS_FILE);
  if (own.length > 0) return own;
  // Migration: adopt the legacy file's sessions as ours (stamping host)
  const legacy = await loadSessionsFrom(SESSIONS_JS_FILE);
  for (const s of legacy) if (!s.host) s.host = HOST;
  return legacy;
}

export async function saveSessions(sessions: Session[]): Promise<void> {
  mkdirSync(BASE_DIR, { recursive: true });
  for (const s of sessions) if (!s.host) s.host = HOST;
  const content = "window.SESSIONS_DATA = " + JSON.stringify(sessions, null, 2) + ";\n";
  await Bun.write(HOST_JS_FILE, content);
  // Single-machine setups keep the legacy file in sync so opening
  // index.html via file:// still works. On multi-machine (other host files
  // present) the legacy file is left alone - two writers over a synced file
  // means conflicts; serve.ts is the merge point there.
  if (otherHostFiles().length === 0) {
    await Bun.write(SESSIONS_JS_FILE, content);
  }
}

function findSession(sessions: Session[], sessionId: string): Session | undefined {
  return sessions.find(s => s.id === sessionId);
}

// -- Hook input --

async function readHookInput(): Promise<HookInput> {
  try {
    const text = await Bun.stdin.text();
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// -- Transcript analysis --

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === "text")
      .map(block => block.text ?? "")
      .join("\n");
  }
  return "";
}

export async function countUserMessages(transcriptPath: string): Promise<number> {
  let count = 0;
  try {
    const text = await Bun.file(transcriptPath).text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: TranscriptEntry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (entry.type !== "user") continue;

      const content = entry.message?.content;
      if (!content) continue;

      if (typeof content === "string" && content.trim()) {
        count++;
        continue;
      }

      if (Array.isArray(content)) {
        const hasText = content.some(
          block => block.type === "text" && block.text?.trim()
        );
        const hasOnlyToolResult = content.every(
          block => block.type === "tool_result"
        );
        if (hasText && !hasOnlyToolResult) count++;
      }
    }
  } catch {
    // File not found or permission error
  }
  return count;
}

export async function computeTokenUsage(transcriptPath: string): Promise<UsageBreakdown> {
  const totals: TokenUsage = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  const models: Record<string, TokenUsage> = {};
  // Streamed multi-block turns repeat the same message id across several lines,
  // and output_tokens can grow between them; keep the LAST (final) usage per id.
  const byId = new Map<string, { usage: Usage; model: string }>();
  try {
    const text = await Bun.file(transcriptPath).text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: TranscriptEntry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (entry.type !== "assistant") continue;

      const usage = entry.message?.usage;
      if (!usage) continue;

      const model = entry.message?.model ?? "";
      const id = entry.message?.id;
      if (id) {
        byId.set(id, { usage, model });
        continue;
      }
      addUsage(totals, models, usage, model);
    }
    for (const { usage, model } of byId.values()) addUsage(totals, models, usage, model);
  } catch {
    // File not found or permission error
  }
  return { totals, models };
}

function addUsage(totals: TokenUsage, models: Record<string, TokenUsage>, usage: Usage, model: string): void {
  const add = (t: TokenUsage) => {
    t.input += usage.input_tokens ?? 0;
    t.output += usage.output_tokens ?? 0;
    t.cache_write += usage.cache_creation_input_tokens ?? 0;
    t.cache_read += usage.cache_read_input_tokens ?? 0;
  };
  add(totals);
  // "<synthetic>" entries are error placeholders, not billable model output
  if (!model || model === "<synthetic>") return;
  add(models[model] ??= { input: 0, output: 0, cache_write: 0, cache_read: 0 });
}

export async function buildConversationText(
  transcriptPath: string,
  skipUserMessages = 0
): Promise<string> {
  const parts: string[] = [];
  let totalChars = 0;
  let userMsgsSeen = 0;
  let capturing = skipUserMessages === 0;

  try {
    const text = await Bun.file(transcriptPath).text();
    for (const line of text.split("\n")) {
      if (totalChars >= MAX_CONVERSATION_CHARS) break;

      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: TranscriptEntry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (entry.type !== "user" && entry.type !== "assistant") continue;

      // Track user messages for skip logic
      if (entry.type === "user") {
        const content = entry.message?.content;
        const isRealMsg = typeof content === "string"
          ? content.trim().length > 0
          : Array.isArray(content) && content.some(b => b.type === "text" && b.text?.trim());

        if (isRealMsg) {
          userMsgsSeen++;
          if (!capturing && userMsgsSeen > skipUserMessages) {
            capturing = true;
          }
        }
      }

      if (!capturing) continue;

      const role = entry.message?.role ?? entry.type;
      let entryText = extractText(entry.message?.content ?? "");
      if (!entryText.trim()) continue;

      if (role === "assistant" && entryText.length > MAX_ASSISTANT_BLOCK_CHARS) {
        entryText = entryText.slice(0, MAX_ASSISTANT_BLOCK_CHARS) + "...";
      }

      const prefix = role === "user" ? "USER" : "ASSISTANT";
      let chunk = `[${prefix}]: ${entryText}\n`;

      if (totalChars + chunk.length > MAX_CONVERSATION_CHARS) {
        chunk = chunk.slice(0, MAX_CONVERSATION_CHARS - totalChars) + "...";
      }

      parts.push(chunk);
      totalChars += chunk.length;
    }
  } catch {
    // File not found or permission error
  }

  return parts.join("");
}

// -- Claude CLI --

async function callCli(prompt: string): Promise<SummaryResult> {
  const proc = Bun.spawn(
    ["claude", "-p", "--model", "haiku", "--no-session-persistence"],
    { stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" }
  );

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude CLI error: ${stderr.slice(0, 200)}`);
  }

  const text = stdout.trim();
  if (!text) throw new Error("Empty response from claude CLI");

  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);

  throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);
}

export async function analyzeConversation(conversationText: string): Promise<SummaryResult> {
  const prompt = SUMMARY_PROMPT.replace("{conversation}", conversationText);
  return callCli(prompt);
}

async function consolidateSummaries(summaries: string[]): Promise<SummaryResult> {
  const numbered = summaries.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const prompt = FINAL_SUMMARY_PROMPT.replace("{summaries}", numbered);
  return callCli(prompt);
}

// -- Account / subscription --

function planLabel(oa: Record<string, unknown>): string {
  const tier = String(oa.organizationRateLimitTier ?? oa.userRateLimitTier ?? "");
  const max = tier.match(/max_(\d+x)/);
  if (max) return `Max ${max[1]}`;
  const orgType = String(oa.organizationType ?? "");
  if (orgType === "claude_max" || tier.includes("max")) return "Max";
  if (orgType === "claude_pro" || tier.includes("pro")) return "Pro";
  if (orgType === "claude_enterprise") return "Enterprise";
  if (orgType === "claude_team") return "Team";
  if (String(oa.billingType ?? "").includes("api")) return "API";
  return orgType || "unknown";
}

/**
 * Reads the account active for THIS Claude Code process from .claude.json.
 * Users running multiple subscriptions typically separate them via
 * CLAUDE_CONFIG_DIR, which the hook inherits - so each session gets
 * stamped with the account it actually ran under.
 */
async function readAccount(): Promise<AccountInfo | null> {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const configFile = configDir
    ? join(configDir, ".claude.json")
    : join(homedir(), ".claude.json");
  try {
    const config = await Bun.file(configFile).json();
    const oa = config.oauthAccount;
    if (!oa || typeof oa !== "object") return null;
    return {
      uuid: String(oa.accountUuid ?? ""),
      email: String(oa.emailAddress ?? ""),
      plan: planLabel(oa),
    };
  } catch {
    return null;
  }
}

// -- Git --

async function getGitBranch(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode === 0) return stdout.trim();
  } catch {
    // git not available or not a repo
  }
  return "n/a";
}

// -- Per-project summaries --

async function isSummaryEnabled(cwd: string): Promise<boolean> {
  try {
    const file = Bun.file(join(cwd, ".claude", "settings.local.json"));
    if (await file.exists()) {
      const settings = await file.json();
      const config = settings.sessionTracker;
      if (config && typeof config === "object") {
        return config.summaryFile !== false;
      }
    }
  } catch {
    // Ignore parse/permission errors
  }
  return true;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

async function updateProjectSummaries(session: Session): Promise<void> {
  const cwd = session.project_path;
  if (!cwd) return;
  try { if (!statSync(cwd).isDirectory()) return; } catch { return; }
  if (!(await isSummaryEnabled(cwd))) return;

  const summariesPath = join(cwd, SUMMARIES_FILENAME);
  const markerStart = `<!-- session:${session.id} -->`;
  const markerEnd = `<!-- /session:${session.id} -->`;

  const entry = `${markerStart}
### ${session.title}

- **Started**: ${session.started_at}
- **Updated**: ${session.updated_at}
- **Branch**: \`${session.branch}\`
- **Status**: ${session.status}
- **Messages**: ${session.messages}
- **Tokens (regular)**: ${fmtTokens(session.tokens.input)} in / ${fmtTokens(session.tokens.output)} out
- **Tokens (cached)**: ${fmtTokens(session.tokens.cache_read)} read / ${fmtTokens(session.tokens.cache_write)} write
- **Topics**: ${session.topics}
- **Session ID**: \`${session.id}\`
- **Resume**: \`claude --resume ${session.id}\`

${session.summary}
${markerEnd}`;

  try {
    const file = Bun.file(summariesPath);
    if (await file.exists()) {
      let content = await file.text();
      if (content.includes(markerStart)) {
        const pattern = new RegExp(
          escapeRegExp(markerStart) + "[\\s\\S]*?" + escapeRegExp(markerEnd)
        );
        content = content.replace(pattern, entry);
      } else {
        content = content.trimEnd() + "\n\n" + entry + "\n";
      }
      await Bun.write(summariesPath, content);
    } else {
      const header = "# Session Summaries\n\n" +
        "> Auto-generated by claude-session-tracker.\n" +
        "> Contains summaries of Claude Code sessions in this project.\n\n";
      await Bun.write(summariesPath, header + entry + "\n");
    }
  } catch {
    // Permission or OS error
  }
}

// -- Stale session cleanup --

function closeStaleSession(session: Session): void {
  session.status = "completed";
  if (!session.updated_at) session.updated_at = session.started_at;
}

function cleanupStaleSessions(sessions: Session[]): boolean {
  const cutoff = Date.now() - STALE_SESSION_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const s of sessions) {
    if (s.status === "completed") continue;
    const ts = Date.parse((s.updated_at || s.started_at).replace(" ", "T"));
    if (!isNaN(ts) && ts < cutoff) {
      closeStaleSession(s);
      changed = true;
    }
  }
  return changed;
}

// -- Analysis threshold --

function shouldAnalyze(msgCount: number, lastAnalyzedAt: number): boolean {
  if (lastAnalyzedAt === 0) return msgCount >= FIRST_THRESHOLD;
  return msgCount >= lastAnalyzedAt + RE_ANALYSIS_INTERVAL;
}

// -- Auto-provision web UI --

function provisionFile(source: string, target: string): void {
  try {
    const srcStat = statSync(source);
    let needsCopy = true;
    try {
      const dstStat = statSync(target);
      needsCopy = srcStat.mtimeMs > dstStat.mtimeMs || srcStat.size !== dstStat.size;
    } catch {
      // Target doesn't exist
    }
    if (needsCopy) {
      copyFileSync(source, target);
    }
  } catch {
    // Source not found - skip (e.g. running outside plugin context)
  }
}

function provisionWebUI(): void {
  mkdirSync(BASE_DIR, { recursive: true });
  provisionFile(WEB_UI_SOURCE, WEB_UI_TARGET);
  provisionFile(SERVER_SOURCE, SERVER_TARGET);
}

// -- Main --

async function main(): Promise<void> {
  provisionWebUI();

  const isFinal = process.argv.includes("--final");
  const finalBgIdx = process.argv.indexOf("--final-bg");
  const isFinalBg = finalBgIdx !== -1;

  // SessionEnd: save input and fork to a detached background process,
  // then exit immediately so Claude Code's shutdown isn't blocked.
  if (isFinal) {
    mkdirSync(BASE_DIR, { recursive: true });
    const inputText = await Bun.stdin.text();
    const inputFile = join(BASE_DIR, `final-${Date.now()}.json`);
    await Bun.write(inputFile, inputText);
    const scriptPath = import.meta.filename;
    const logFile = join(BASE_DIR, "session-end.log");
    Bun.spawn([
      "sh", "-c",
      `bun "${scriptPath}" --final-bg "${inputFile}" </dev/null >>"${logFile}" 2>&1 &`,
    ]);
    process.exit(0);
  }

  // Read hook input: from temp file (detached) or stdin (normal Stop hook)
  let hookInput: HookInput;
  if (isFinalBg) {
    const inputFile = process.argv[finalBgIdx + 1];
    try {
      hookInput = JSON.parse(await Bun.file(inputFile).text());
      unlinkSync(inputFile);
    } catch {
      process.exit(0);
    }
  } else {
    hookInput = await readHookInput();
  }

  const sessionId = hookInput.session_id ?? "";
  const transcriptPath = hookInput.transcript_path ?? "";
  const cwd = hookInput.cwd ?? process.cwd();
  const endReason = hookInput.session_end_reason ?? "";
  const isClear = isFinalBg && endReason === "clear";

  if (!sessionId || !transcriptPath) process.exit(0);
  if (!(await Bun.file(transcriptPath).exists())) process.exit(0);

  const msgCount = await countUserMessages(transcriptPath);
  const usage = await computeTokenUsage(transcriptPath);
  const sessions = await loadSessions();

  // Cleanup stale sessions (handles terminal close / Ctrl+C / crash)
  if (cleanupStaleSessions(sessions)) {
    await saveSessions(sessions);
  }

  const existing = findSession(sessions, sessionId);
  const lastAnalyzedAt = existing?.last_analyzed_at ?? 0;

  // Detect transcript reset (/clear fallback): fewer messages than we last analyzed
  const isTranscriptReset = lastAnalyzedAt > 0 && msgCount < lastAnalyzedAt;

  // On /clear: finalize the current session and reset tracking state
  if (isClear && existing) {
    closeStaleSession(existing);
    existing.last_analyzed_at = 0;
    existing.summaries = [];
    await saveSessions(sessions);
    console.error("Session closed via /clear.");
    process.exit(0);
  }

  // On transcript reset (fallback for /clear without reason): reset tracking
  if (isTranscriptReset && existing) {
    existing.last_analyzed_at = 0;
    existing.summaries = [];
    await saveSessions(sessions);
    // Continue - treat this as a fresh first analysis
  }

  const effectiveLastAnalyzed = isTranscriptReset ? 0 : lastAnalyzedAt;

  // Final: always fire if there are messages (skip only empty sessions)
  // Incremental: respect threshold (1st message, then every 5)
  if (isFinalBg) {
    if (msgCount === 0) process.exit(0);
  } else {
    if (!shouldAnalyze(msgCount, effectiveLastAnalyzed)) process.exit(0);
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  const branch = await getGitBranch(cwd);
  // First stamp wins: the session belongs to the account it started under
  const account = existing?.account ?? await readAccount();
  const projectName = cwd ? basename(cwd) : "unknown";
  const isFirstAnalysis = effectiveLastAnalyzed === 0;
  const priorSummaries = isTranscriptReset ? [] : (existing?.summaries ?? []);

  if (isFinalBg) {
    console.error("See ya! Saving session summary...");
  } else if (isFirstAnalysis) {
    console.error("Session started, capturing context...");
  } else {
    console.error(`Session tracked: ${msgCount} messages, analyzing new activity...`);
  }

  let summary: SummaryResult;
  const updatedSummaries = [...priorSummaries];

  try {
    if (isFinalBg) {
      // Analyze any remaining delta since last analysis
      if (msgCount > effectiveLastAnalyzed) {
        const delta = await buildConversationText(transcriptPath, effectiveLastAnalyzed);
        if (delta.trim()) {
          const deltaSummary = await analyzeConversation(delta);
          if (deltaSummary.summary) updatedSummaries.push(deltaSummary.summary);
        }
      }

      // Consolidate all summaries into one final summary
      if (updatedSummaries.length > 1) {
        summary = await consolidateSummaries(updatedSummaries);
      } else if (updatedSummaries.length === 1) {
        // Only one summary - analyze full conversation for a better final result
        const fullText = await buildConversationText(transcriptPath);
        summary = fullText.trim()
          ? await analyzeConversation(fullText)
          : { summary: updatedSummaries[0], status: "completed" };
      } else {
        // No prior summaries at all - full analysis
        const fullText = await buildConversationText(transcriptPath);
        if (!fullText.trim()) process.exit(0);
        summary = await analyzeConversation(fullText);
      }
      // Override status to completed on session end
      summary.status = "completed";
    } else {
      // Incremental: first analysis is full, subsequent are delta-only
      const conversationText = await buildConversationText(
        transcriptPath,
        isFirstAnalysis ? 0 : effectiveLastAnalyzed
      );
      if (!conversationText.trim()) process.exit(0);
      summary = await analyzeConversation(conversationText);
      if (summary.summary) updatedSummaries.push(summary.summary);
    }
  } catch (e) {
    console.error(`session-tracker: error: ${e}`);
    process.exit(0);
  }

  // Re-read sessions right before save to avoid race conditions with concurrent hooks
  const freshSessions = await loadSessions();
  const freshExisting = findSession(freshSessions, sessionId);
  const analysisCount = (freshExisting?.analysis_count ?? 0) + 1;

  const sessionObj: Session = {
    id: sessionId,
    started_at: freshExisting?.started_at ?? existing?.started_at ?? now,
    updated_at: now,
    project: projectName,
    project_path: cwd,
    branch,
    title: summary.title ?? freshExisting?.title ?? "Untitled session",
    summary: summary.summary ?? "No summary available.",
    topics: summary.topics ?? freshExisting?.topics ?? "general",
    status: summary.status ?? "in-progress",
    messages: msgCount,
    resume: `claude --resume ${sessionId}`,
    last_analyzed_at: msgCount,
    analysis_count: analysisCount,
    summaries: updatedSummaries,
    tokens: usage.totals,
    models: usage.models,
    account: freshExisting?.account ?? account,
    host: HOST,
  };

  if (freshExisting) {
    const idx = freshSessions.indexOf(freshExisting);
    freshSessions[idx] = sessionObj;
  } else {
    freshSessions.push(sessionObj);
  }

  await saveSessions(freshSessions);
  await updateProjectSummaries(sessionObj);

  const title = summary.title ?? "session";
  const t = sessionObj.tokens;
  const tokLine = `${fmtTokens(t.input)} in / ${fmtTokens(t.output)} out, cache ${fmtTokens(t.cache_read)} read / ${fmtTokens(t.cache_write)} write`;
  if (isFinalBg) {
    console.error(`Session logged: "${title}" (${tokLine})`);
  } else {
    console.error(`Session snapshot saved: "${title}" (${tokLine})`);
  }
}

// Only run as a hook when executed directly (backfill.ts imports this file)
if (import.meta.main) {
  main();
}
