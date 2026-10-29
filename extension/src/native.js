// native.js — typed wrapper around runtime.sendNativeMessage for the
// reddit_scraper_obsidian host (contract in docs/DESIGN.md).
import { api, NATIVE_HOST } from "./compat.js";

const BATCH_SIZE = 50;

function send(msg) {
  return api.runtime.sendNativeMessage(NATIVE_HOST, msg).then((resp) => {
    if (!resp || resp.ok !== true) {
      throw new Error(`native host: ${resp?.error || `no/bad response to ${msg.cmd} (is the host installed?)`}`);
    }
    return resp;
  }, (err) => {
    const m = String(err?.message || err);
    if (/not exist|not found|Access to the requested native application/i.test(m)) {
      throw new Error(`native host '${NATIVE_HOST}' is not installed for this browser: ${m}`);
    }
    throw new Error(`native host '${NATIVE_HOST}' call '${msg.cmd}' failed: ${m}`);
  });
}

export async function ping() {
  const r = await send({ cmd: "ping" });
  return { version: r.version };
}

export async function checkVault(vaultPath) {
  const r = await send({ cmd: "checkVault", vaultPath });
  return { exists: !!r.exists, isVault: !!r.isVault };
}

/**
 * Known ids + the vault's last sync id.
 * Returns {ids: string[], lastSyncId: string|null} — lastSyncId is the max
 * syncId among stored order keys (null when the vault holds nothing). 'Fill
 * gaps' reuses it so newly found older items sort below existing entries.
 * Tolerates hosts without lastSyncId support (-> null).
 */
export async function getKnownIds(vaultPath, folder) {
  const r = await send({ cmd: "getKnownIds", vaultPath, folder });
  return {
    ids: Array.isArray(r.ids) ? r.ids : [],
    lastSyncId: typeof r.lastSyncId === "string" && r.lastSyncId ? r.lastSyncId : null,
  };
}

/**
 * Write items in batches of <=50. Returns {added, updated, subreddits, batches}.
 * All batches share one syncId per DESIGN.md.
 */
export async function writeItems({ vaultPath, folder, syncId, items, onBatch }) {
  let added = 0;
  let updated = 0;
  const subreddits = new Set();
  let batches = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const r = await send({ cmd: "writeItems", vaultPath, folder, syncId, items: batch });
    added += r.added || 0;
    updated += r.updated || 0;
    for (const s of r.subreddits || []) subreddits.add(s);
    batches++;
    if (onBatch) onBatch({ batchIndex: batches, done: Math.min(i + BATCH_SIZE, items.length), total: items.length, added, updated });
  }
  return { added, updated, subreddits: [...subreddits], batches };
}

export { BATCH_SIZE };
