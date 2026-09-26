#!/usr/bin/env bun
/**
 * Session Tracker Hook for Claude Code.
 *
 * Fires on Stop (async) and SessionEnd (--final) events.
 * - After 1st user message: full analysis, captures started_at
 * - Every 5 messages after: delta-only analysis (new messages since last)
 * - On session end: consolidates all incremental summaries into a final one
 */

import { mkdirSync, statSync, copyFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join, basename, dirname } from "path";

const BASE_DIR = join(homedir(), ".claude", "session-tracker");
const SESSIONS_JS_FILE = join(BASE_DIR, "sessions-data.js");
const SUMMARIES_FILENAME = "SESSION_SUMMARIES.md";
const WEB_UI_SOURCE = join(import.meta.dir, "..", "web", "index.html");
const WEB_UI_TARGET = join(BASE_DIR, "index.html");

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

interface TokenUsage {
  input: number;        // uncached input tokens (full price)
  output: number;       // output tokens
  cache_write: number;  // cache_creation_input_tokens
  cache_read: number;   // cache_read_input_tokens (cache hits)
}

interface ArtifactLink {
  title: string;
  url: string;
}

interface Session {
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
  artifacts: ArtifactLink[];
}

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  session_end_reason?: string;
}

interface SummaryResult {
  title?: string;
  summary?: string;
  topics?: string;
  status?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { file_path?: string; title?: string };
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptEntry {
  type: string;
  frameUrl?: string;
  title?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
    usage?: Usage;
  };
}

// -- Data I/O --

async function loadSessions(): Promise<Session[]> {
  const file = Bun.file(SESSIONS_JS_FILE);
  if (await file.exists()) {
    try {
      const text = await file.text();
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
        if (!s.artifacts) s.artifacts = [];
      }
      return sessions;
    } catch {
      return [];
    }
  }
  return [];
}

async function saveSessions(sessions: Session[]): Promise<void> {
  mkdirSync(BASE_DIR, { recursive: true });
  const content = "window.SESSIONS_DATA = " + JSON.stringify(sessions, null, 2) + ";\n";
  await Bun.write(SESSIONS_JS_FILE, content);
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

async function countUserMessages(transcriptPath: string): Promise<number> {
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

async function computeTokenUsage(transcriptPath: string): Promise<TokenUsage> {
  const totals: TokenUsage = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  // Streamed multi-block turns repeat the same message id across several lines,
  // and output_tokens can grow between them; keep the LAST (final) usage per id.
  const byId = new Map<string, Usage>();
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

      const id = entry.message?.id;
      if (id) {
        byId.set(id, usage);
        continue;
      }
      addUsage(totals, usage);
    }
    for (const usage of byId.values()) addUsage(totals, usage);
  } catch {
    // File not found or permission error
  }
  return totals;
}

function addUsage(totals: TokenUsage, usage: Usage): void {
  totals.input += usage.input_tokens ?? 0;
  totals.output += usage.output_tokens ?? 0;
  totals.cache_write += usage.cache_creation_input_tokens ?? 0;
  totals.cache_read += usage.cache_read_input_tokens ?? 0;
}

async function extractArtifacts(transcriptPath: string): Promise<ArtifactLink[]> {
  // Artifact publishes: assistant tool_use (name "Artifact") followed by a
  // tool_result whose text reads "Published <path> at <url>". The CLI writes a
  // "frame-link" entry per publish carrying the artifact's real title.
  const titleByToolUseId = new Map<string, string>();
  const frameTitleByUrl = new Map<string, string>();
  const byUrl = new Map<string, ArtifactLink>();
  try {
    const text = await Bun.file(transcriptPath).text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: TranscriptEntry;
      try { entry = JSON.parse(trimmed); } catch { continue; }

      if (entry.type === "frame-link" && entry.frameUrl && entry.title) {
        frameTitleByUrl.set(entry.frameUrl, entry.title);
        continue;
      }

      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (entry.type === "assistant" && block.type === "tool_use" && block.name === "Artifact" && block.id) {
          const input = block.input ?? {};
          const title = input.title || (input.file_path ? basename(input.file_path) : "artifact");
          titleByToolUseId.set(block.id, title);
        }
        if (entry.type === "user" && block.type === "tool_result" && block.tool_use_id) {
          const title = titleByToolUseId.get(block.tool_use_id);
          if (!title) continue;
          const match = extractText(block.content ?? "").match(/^Published .+ at (https:\/\/\S+)/m);
          if (match) byUrl.set(match[1], { title, url: match[1] });
        }
      }
    }
  } catch {
    // File not found or permission error
  }
  for (const link of byUrl.values()) {
    link.title = frameTitleByUrl.get(link.url) ?? link.title;
  }
  return [...byUrl.values()];
}

async function buildConversationText(
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

async function analyzeConversation(conversationText: string): Promise<SummaryResult> {
  const prompt = SUMMARY_PROMPT.replace("{conversation}", conversationText);
  return callCli(prompt);
}

async function consolidateSummaries(summaries: string[]): Promise<SummaryResult> {
  const numbered = summaries.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const prompt = FINAL_SUMMARY_PROMPT.replace("{summaries}", numbered);
  return callCli(prompt);
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

// -- Project path resolution --

// Claude Code stores transcripts under ~/.claude/projects/<escaped-launch-dir>/,
// fixed at session start; hookInput.cwd drifts when the session cd's elsewhere.
function escapeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function resolveProjectPath(cwd: string, transcriptPath: string, persisted?: string): string {
  const projectDirName = basename(dirname(transcriptPath));
  if (persisted && escapeProjectDir(persisted) === projectDirName) return persisted;
  let candidate = cwd;
  while (candidate && candidate !== dirname(candidate)) {
    if (escapeProjectDir(candidate) === projectDirName) return candidate;
    candidate = dirname(candidate);
  }
  return persisted || cwd;
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

function provisionWebUI(): void {
  mkdirSync(BASE_DIR, { recursive: true });
  try {
    const srcStat = statSync(WEB_UI_SOURCE);
    let needsCopy = true;
    try {
      const dstStat = statSync(WEB_UI_TARGET);
      needsCopy = srcStat.mtimeMs > dstStat.mtimeMs || srcStat.size !== dstStat.size;
    } catch {
      // Target doesn't exist
    }
    if (needsCopy) {
      copyFileSync(WEB_UI_SOURCE, WEB_UI_TARGET);
    }
  } catch {
    // Source not found - skip (e.g. running outside plugin context)
  }
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
  const tokens = await computeTokenUsage(transcriptPath);
  const artifacts = await extractArtifacts(transcriptPath);
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
  const projectPath = resolveProjectPath(cwd, transcriptPath, existing?.project_path);
  const branch = await getGitBranch(projectPath);
  const projectName = projectPath ? basename(projectPath) : "unknown";
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

  // Keep artifacts published before a transcript reset (/clear) in the union
  const mergedArtifacts = new Map<string, ArtifactLink>(
    (freshExisting?.artifacts ?? []).map(a => [a.url, a])
  );
  for (const a of artifacts) mergedArtifacts.set(a.url, a);

  const sessionObj: Session = {
    id: sessionId,
    started_at: freshExisting?.started_at ?? existing?.started_at ?? now,
    updated_at: now,
    project: projectName,
    project_path: projectPath,
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
    tokens,
    artifacts: [...mergedArtifacts.values()],
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

main();
