#!/usr/bin/env bun
/**
 * Backfill: import historical Claude Code sessions into the tracker.
 *
 * Scans <config>/projects/<project>/<session-id>.jsonl transcripts, skips
 * sessions already tracked and empty ones, extracts metadata straight from
 * the transcript (cwd, branch, timestamps, tokens) and asks Haiku for the
 * title/summary/topics - same analysis the live hook does.
 *
 * Unlike the live hook it does NOT write SESSION_SUMMARIES.md into project
 * directories (a bulk import shouldn't touch your repos) and does not stamp
 * an account (transcripts don't record it; they show as "untracked account").
 *
 * Usage:
 *   bun scripts/backfill.ts [--dry-run] [--limit N] [--concurrency N]
 *                           [--exclude <regex>] [--account <email[:plan]>]
 *
 * --exclude matches against the transcript path (e.g. --exclude "ab-runs"
 * to leave out test-harness working dirs). Excluded counts are reported.
 *
 * --account stamps every session imported by THIS run with the given
 * account (transcripts don't record it, but you often know which
 * subscription a machine or an era of history was used with), e.g.
 * --account "old@example.com:Pro". Omit for account: null (untracked).
 *
 * Respects CLAUDE_CONFIG_DIR (transcripts) and SESSION_TRACKER_DIR (output).
 * Safe to interrupt and re-run: progress is saved after every session.
 */

import { readdirSync, statSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import {
  loadSessions,
  saveSessions,
  countUserMessages,
  computeTokenUsage,
  buildConversationText,
  analyzeConversation,
  HOST,
  BASE_DIR,
  type Session,
} from "../hooks/session-tracker.ts";

/**
 * Ids tombstoned via the viewer (sessions-meta*.js, deleted: true).
 * The backfill must not resurrect sessions the user deleted.
 */
function loadTombstones(): Set<string> {
  const dead = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(BASE_DIR); } catch { return dead; }
  for (const f of names) {
    if (!/^sessions-meta(\..+)?\.js$/.test(f)) continue;
    try {
      const text = readFileSync(join(BASE_DIR, f), "utf-8");
      const meta = JSON.parse(text.replace("window.SESSIONS_META = ", "").trimEnd().replace(/;$/, ""));
      for (const [id, entry] of Object.entries(meta)) {
        if ((entry as { deleted?: boolean }).deleted) dead.add(id);
      }
    } catch { /* unreadable meta file */ }
  }
  return dead;
}

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const PROJECTS_DIR = join(CONFIG_DIR, "projects");

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = intFlag("--limit", Infinity);
const CONCURRENCY = intFlag("--concurrency", 3);
const EXCLUDE = strFlag("--exclude");
const ACCOUNT = accountFlag("--account");

function strFlag(name: string): RegExp | null {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return null;
  return new RegExp(process.argv[i + 1]);
}

function accountFlag(name: string): { uuid: string; email: string; plan: string } | null {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return null;
  const value = process.argv[i + 1];
  const sep = value.lastIndexOf(":");
  const email = sep === -1 ? value : value.slice(0, sep);
  const plan = sep === -1 ? "" : value.slice(sep + 1);
  return { uuid: "", email, plan };
}

function intFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fmtDate(iso: string): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "";
}

interface TranscriptMeta {
  cwd: string;
  branch: string;
  first: string;
  last: string;
}

async function transcriptMeta(path: string): Promise<TranscriptMeta> {
  const meta: TranscriptMeta = { cwd: "", branch: "", first: "", last: "" };
  try {
    const text = await Bun.file(path).text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
      if (ts) {
        if (!meta.first) meta.first = ts;
        meta.last = ts;
      }
      if (!meta.cwd && typeof entry.cwd === "string") meta.cwd = entry.cwd;
      if (typeof entry.gitBranch === "string" && entry.gitBranch) meta.branch = entry.gitBranch;
    }
  } catch {
    // unreadable transcript
  }
  return meta;
}

function listTranscripts(): string[] {
  const out: string[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const proj of projects) {
    const dir = join(PROJECTS_DIR, proj);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) out.push(join(dir, f));
      }
    } catch {
      // skip unreadable project dir
    }
  }
  return out;
}

async function backfillOne(path: string): Promise<Session | null> {
  const id = basename(path, ".jsonl");
  const msgCount = await countUserMessages(path);
  if (msgCount === 0) return null;

  const conversationText = await buildConversationText(path);
  if (!conversationText.trim()) return null;

  const [meta, tokens, summary] = await Promise.all([
    transcriptMeta(path),
    computeTokenUsage(path),
    analyzeConversation(conversationText),
  ]);

  return {
    id,
    started_at: fmtDate(meta.first),
    updated_at: fmtDate(meta.last),
    project: meta.cwd ? basename(meta.cwd) : "unknown",
    project_path: meta.cwd,
    branch: meta.branch || "n/a",
    title: summary.title ?? "Untitled session",
    summary: summary.summary ?? "No summary available.",
    topics: summary.topics ?? "general",
    status: "completed",
    messages: msgCount,
    resume: `claude --resume ${id}`,
    last_analyzed_at: msgCount,
    analysis_count: 1,
    summaries: [],
    tokens,
    account: ACCOUNT,
    host: HOST,
  };
}

async function main(): Promise<void> {
  const sessions = await loadSessions();
  const known = new Set(sessions.map(s => s.id));
  const tombstones = loadTombstones();
  const all = listTranscripts();
  const notDeleted = all.filter(p => !tombstones.has(basename(p, ".jsonl")));
  const skippedDeleted = all.length - notDeleted.length;
  const notTracked = notDeleted.filter(p => !known.has(basename(p, ".jsonl")));
  const excluded = EXCLUDE ? notTracked.filter(p => EXCLUDE.test(p)).length : 0;
  const candidates = notTracked
    .filter(p => !EXCLUDE || !EXCLUDE.test(p))
    .slice(0, LIMIT);

  console.log(
    `Transcripts found: ${all.length} | already tracked: ${notDeleted.length - notTracked.length}` +
    (skippedDeleted ? ` | deleted (tombstoned): ${skippedDeleted}` : "") +
    (EXCLUDE ? ` | excluded by ${EXCLUDE}: ${excluded}` : "") +
    ` | to process: ${candidates.length}`
  );
  if (ACCOUNT) {
    console.log(`Stamping account on imported sessions: ${ACCOUNT.email}${ACCOUNT.plan ? ` (${ACCOUNT.plan})` : ""}`);
  }

  if (DRY_RUN) {
    for (const p of candidates) {
      const msgs = await countUserMessages(p);
      console.log(`${msgs === 0 ? "SKIP (empty)" : `OK (${msgs} msgs)`}  ${basename(p, ".jsonl")}  [${basename(join(p, ".."))}]`);
    }
    return;
  }

  let done = 0, imported = 0, skipped = 0, failed = 0;
  const queue = [...candidates];

  // Serialize saves across workers (and re-read fresh each time: the live
  // hook may write sessions-data.js while the backfill runs).
  let saveChain: Promise<void> = Promise.resolve();
  function saveOne(session: Session): Promise<void> {
    saveChain = saveChain.then(async () => {
      const fresh = await loadSessions();
      if (!fresh.some(s => s.id === session.id)) fresh.push(session);
      await saveSessions(fresh);
    });
    return saveChain;
  }

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const path = queue.shift()!;
      const id = basename(path, ".jsonl");
      try {
        const session = await backfillOne(path);
        if (session) {
          await saveOne(session);
          imported++;
          console.log(`[${++done}/${candidates.length}] + "${session.title}" (${session.project}, ${session.messages} msgs)`);
        } else {
          skipped++;
          console.log(`[${++done}/${candidates.length}] - skipped (empty): ${id}`);
        }
      } catch (e) {
        failed++;
        console.log(`[${++done}/${candidates.length}] ! failed: ${id}: ${e}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nBackfill done: ${imported} imported, ${skipped} empty, ${failed} failed.`);
}

main();
