// resume.js — pure helpers for the "resume an interrupted sync" cursor.
//
// After every listing page is successfully written to the vault, sync.js
// persists a cursor (below) to storage.local. If the run later dies (429
// retries exhausted, cancel, browser closed), the sync page offers to Resume
// from the cursor with the SAME syncId and rank, so vault ordering stays
// consistent. A normal completion clears the cursor.
//
// `store` is a tiny storage adapter so this module stays unit-testable:
//   { get(key) -> Promise<value|undefined>, set(obj) -> Promise, remove(key) -> Promise }

export const CURSOR_KEY = "***";

/** Build a validated cursor object (plain JSON, safe for storage.local). */
export function makeCursor({
  username, vaultPath, folder, syncId,
  nextUrl, nextRank, page, itemsWritten,
  skipKnown = false,
  updatedAt = new Date().toISOString(),
}) {
  return {
    username: String(username || ""),
    vaultPath: String(vaultPath || ""),
    folder: String(folder || ""),
    syncId: String(syncId || ""),
    nextUrl: nextUrl || null,
    nextRank: Math.max(0, Math.floor(Number(nextRank) || 0)),
    page: Math.max(0, Math.floor(Number(page) || 0)),
    itemsWritten: Math.max(0, Math.floor(Number(itemsWritten) || 0)),
    // True for cursors from skipKnown runs (fill-gaps, or resume of one):
    // a resumed run must keep skipping known items, not stop at them.
    // Absent on cursors written by older versions (treated as false).
    skipKnown: !!skipKnown,
    updatedAt,
  };
}

/** Shape validation — anything off and we treat the cursor as absent. */
export function isCursor(c) {
  return !!c && typeof c === "object"
    && typeof c.username === "string" && c.username !== ""
    && typeof c.nextUrl === "string" && c.nextUrl !== ""
    && typeof c.syncId === "string" && c.syncId !== ""
    && Number.isFinite(c.nextRank) && Number.isFinite(c.page)
    && Number.isFinite(c.itemsWritten)
    && (c.skipKnown === undefined || typeof c.skipKnown === "boolean");
}

export async function saveCursor(store, cursor) {
  await store.set({ [CURSOR_KEY]: cursor });
  return cursor;
}

export async function loadCursor(store) {
  try {
    const c = await store.get(CURSOR_KEY);
    return isCursor(c) ? c : null;
  } catch {
    return null;
  }
}

export async function clearCursor(store) {
  try {
    await store.remove(CURSOR_KEY);
  } catch { /* nothing to clear */ }
}

/** Does this cursor belong to the currently configured target? */
export function cursorMatches(cursor, { username, vaultPath, folder }) {
  return !!cursor
    && cursor.username === username
    && cursor.vaultPath === vaultPath
    && cursor.folder === folder;
}

/** Human one-liner for the sync page banner. */
export function describeCursor(cursor) {
  const n = cursor.itemsWritten;
  return `Previous sync stopped at page ${cursor.page} (${n} item${n === 1 ? "" : "s"} written)`;
}

/**
 * syncId for a 'Fill gaps' run: reuse the vault's lastSyncId so items the
 * interrupted sync never reached get the SAME order bucket as the existing
 * entries — new (older-in-listing) items land below them, preserving
 * save-order. Falls back to a fresh timestamp for an empty vault.
 */
export function fillGapsSyncId(lastSyncId, nowIso = new Date().toISOString()) {
  return typeof lastSyncId === "string" && lastSyncId !== "" ? lastSyncId : nowIso;
}
