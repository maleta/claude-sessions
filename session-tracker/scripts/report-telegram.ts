#!/usr/bin/env bun
/**
 * Post a session digest to a Telegram chat / topic.
 *
 * Reads a `telegram.json` from the data dir (or env vars), builds a compact
 * "what I did in the last N days" message from the tracked sessions and sends
 * it via the Telegram Bot API. Meant to be run on a schedule (cron / Task
 * Scheduler); pair it with a bot you created via @BotFather.
 *
 *   <data dir>/telegram.json:
 *   {
 *     "botToken": "123456:ABC-DEF...",   // from @BotFather
 *     "chatId": "-1001234567890",         // channel/group id or your user id
 *     "threadId": 42,                     // optional: a forum topic's id
 *     "days": 7                           // optional: range, default 7
 *   }
 *
 * Env overrides: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID,
 * REPORT_DAYS. Flags: --dry-run (print, don't send), --days N.
 *
 * The bot token stays in your own config file; this script only reads it to
 * call the API. Never commit telegram.json (add it to .gitignore).
 */

import { readdirSync } from "fs";
import { join } from "path";
import { BASE_DIR, parseSessionsJs, type Session, type TokenUsage } from "../hooks/session-tracker.ts";

// -- Merged multi-machine load (mirrors serve.ts) --

async function readData(path: string): Promise<Session[]> {
  try { return parseSessionsJs(await Bun.file(path).text()); } catch { return []; }
}

async function loadMerged(): Promise<Session[]> {
  let names: string[] = [];
  try { names = readdirSync(BASE_DIR); } catch { return []; }
  const byId = new Map<string, Session>();
  for (const s of await readData(join(BASE_DIR, "sessions-data.js"))) byId.set(s.id, s);
  for (const f of names.filter(f => /^sessions-data\..+\.js$/.test(f)).sort()) {
    for (const s of await readData(join(BASE_DIR, f))) byId.set(s.id, s);
  }
  return Array.from(byId.values());
}

interface MetaEntry { ts?: number; deleted?: boolean; title?: string }

async function loadMeta(): Promise<Record<string, MetaEntry>> {
  let names: string[] = [];
  try { names = readdirSync(BASE_DIR); } catch { return {}; }
  const merged: Record<string, MetaEntry> = {};
  const files = ["sessions-meta.js", ...names.filter(f => /^sessions-meta\..+\.js$/.test(f)).sort()];
  for (const f of files) {
    try {
      const text = await Bun.file(join(BASE_DIR, f)).text();
      const m = JSON.parse(text.replace("window.SESSIONS_META = ", "").trimEnd().replace(/;$/, ""));
      for (const [id, entry] of Object.entries(m as Record<string, MetaEntry>)) {
        if (!merged[id] || (entry.ts ?? 0) >= (merged[id].ts ?? 0)) merged[id] = entry;
      }
    } catch { /* missing/unreadable */ }
  }
  return merged;
}

// -- Cost (mirrors serve.ts / the web UI) --

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
const FALLBACK_RATE = { in: 5, out: 25 };

function usageCost(tk: TokenUsage, rate: { in: number; out: number }): number {
  return ((tk.input ?? 0) * rate.in + (tk.output ?? 0) * rate.out
    + (tk.cache_read ?? 0) * 0.1 * rate.in + (tk.cache_write ?? 0) * 1.25 * rate.in) / 1e6;
}

function sessionCost(s: Session): number {
  const models = Object.entries(s.models ?? {});
  if (models.length > 0) {
    return models.reduce((sum, [id, tk]) => sum + usageCost(tk, resolveRate(id) ?? FALLBACK_RATE), 0);
  }
  return s.tokens ? usageCost(s.tokens, FALLBACK_RATE) : 0;
}

// -- Formatting --

function money(v: number): string {
  if (v >= 100) return "$" + Math.round(v).toLocaleString("en-US");
  return "$" + v.toFixed(2);
}
function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function intFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface TgConfig { botToken?: string; chatId?: string; threadId?: number; days?: number }

async function loadConfig(): Promise<TgConfig> {
  let file: TgConfig = {};
  try { file = await Bun.file(join(BASE_DIR, "telegram.json")).json(); } catch { /* none */ }
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? file.botToken,
    chatId: process.env.TELEGRAM_CHAT_ID ?? file.chatId,
    threadId: process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : file.threadId,
    days: intFlag("--days", Number(process.env.REPORT_DAYS) || file.days || 7),
  };
}

function buildMessage(sessions: Session[], meta: Record<string, MetaEntry>, days: number): string {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const live = sessions.filter(s => !meta[s.id]?.deleted);
  interface Row { s: Session; ts: number; cost: number }
  const inRange: Row[] = [];
  for (const s of live) {
    const ts = Date.parse((s.updated_at ?? s.started_at ?? "").replace(" ", "T") + "Z");
    if (isNaN(ts) || ts < cutoff) continue;
    inRange.push({ s, ts, cost: sessionCost(s) });
  }
  inRange.sort((a, b) => b.ts - a.ts);

  const byProject = new Map<string, { sessions: number; cost: number }>();
  let totalCost = 0, totalOut = 0;
  for (const { s, cost } of inRange) {
    const key = s.project || s.project_path || "unknown";
    const p = byProject.get(key) ?? { sessions: 0, cost: 0 };
    p.sessions++; p.cost += cost;
    byProject.set(key, p);
    totalCost += cost;
    totalOut += s.tokens?.output ?? 0;
  }
  const projects = Array.from(byProject.entries()).sort((a, b) => b[1].cost - a[1].cost);

  const label = days === 7 ? "last 7 days" : `last ${days} days`;
  const lines: string[] = [];
  lines.push(`<b>Claude sessions — ${label}</b>`);
  lines.push(`${inRange.length} sessions · ${money(totalCost)} API-equivalent · ${fmtTok(totalOut)} tokens out`);
  if (inRange.length === 0) return lines.join("\n") + "\n\nNo sessions in this range.";
  lines.push("");
  for (const [name, p] of projects.slice(0, 10)) {
    lines.push(`• <b>${esc(name)}</b> — ${p.sessions} · ${money(p.cost)}`);
  }
  if (projects.length > 10) lines.push(`… and ${projects.length - 10} more projects`);
  // A few most-recent session titles for flavor
  lines.push("");
  lines.push("<i>Recent:</i>");
  for (const { s } of inRange.slice(0, 5)) {
    const title = meta[s.id]?.title || s.title || "Untitled";
    lines.push(`· ${esc(title)}`);
  }
  let msg = lines.join("\n");
  if (msg.length > 3900) msg = msg.slice(0, 3900) + "\n…";
  return msg;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = await loadConfig();
  const [sessions, meta] = await Promise.all([loadMerged(), loadMeta()]);
  const msg = buildMessage(sessions, meta, cfg.days ?? 7);

  if (dryRun) {
    console.log("--- dry run (not sent) ---\n" + msg);
    return;
  }
  if (!cfg.botToken || !cfg.chatId) {
    console.error("Missing botToken/chatId. Set them in " + join(BASE_DIR, "telegram.json") +
      " or via TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. Use --dry-run to preview without sending.");
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    chat_id: cfg.chatId,
    text: msg,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (cfg.threadId) body.message_thread_id = cfg.threadId;

  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && (data as { ok?: boolean }).ok) {
    console.log("Report sent to Telegram.");
  } else {
    console.error("Telegram API error: " + JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }
}

main();
