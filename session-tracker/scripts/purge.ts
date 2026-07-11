#!/usr/bin/env bun
/**
 * Purge: physically remove tombstoned sessions from THIS machine's data file.
 *
 * Deleting from the viewer only tombstones a session (sessions-meta*.js,
 * deleted: true) - the entry stays in the data file so other machines and
 * the backfill know about it. This script does the real removal, and it can
 * only touch the data file OWNED by the machine it runs on (the per-file
 * single-writer rule that keeps synced setups conflict-free).
 *
 * Tombstones are kept after purging so a later backfill still skips the
 * session. The transcript in ~/.claude/projects is NEVER touched.
 *
 * Usage:
 *   bun scripts/purge.ts            # dry-run: list what would be removed
 *   bun scripts/purge.ts --apply    # actually remove
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { loadSessions, saveSessions, HOST, BASE_DIR } from "../hooks/session-tracker.ts";

const APPLY = process.argv.includes("--apply");

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

async function main(): Promise<void> {
  const tombstones = loadTombstones();
  const sessions = await loadSessions();
  const doomed = sessions.filter(s => tombstones.has(s.id));

  console.log(`Machine: ${HOST} | sessions in own data file: ${sessions.length} | tombstoned here: ${doomed.length}`);
  if (doomed.length === 0) {
    console.log("Nothing to purge.");
    return;
  }
  for (const s of doomed) {
    console.log(`  - ${s.id}  "${s.title}" (${s.project})`);
  }
  if (!APPLY) {
    console.log("\nDry-run. Re-run with --apply to remove these entries.");
    return;
  }
  await saveSessions(sessions.filter(s => !tombstones.has(s.id)));
  console.log(`\nPurged ${doomed.length} entries from this machine's data file. Tombstones kept (backfill stays blocked).`);
}

main();
