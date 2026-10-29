// synclock.js — cross-tab guard: only one sync may run at a time.
//
// The sync page writes a small record to storage.local while it runs
// ({tabId, startedAt, updatedAt}); the runner refreshes updatedAt (heartbeat)
// periodically. A second tab refuses to start while a *fresh* record from
// another tab exists. A crash/browser kill leaves the record behind, so
// records older than STALE_AFTER_MS are considered abandoned and any tab may
// take over.
//
// Pure over an injected storage adapter (same shape as src/resume.js):
//   { get(key) -> Promise<value|undefined>, set(obj) -> Promise, remove(key) -> Promise }

export const RUNNING_KEY = "syncRunti…g";
export const STALE_AFTER_MS = 2 * 60 * 1000; // 2 min without a heartbeat => stale

function isRecord(r) {
  return !!r && typeof r === "object" && typeof r.tabId === "string"
    && Number.isFinite(r.startedAt) && Number.isFinite(r.updatedAt);
}

/** No/garbage/old record, or from a tab that died without releasing. */
export function isStale(record, nowMs = Date.now()) {
  return !isRecord(record) || nowMs - record.updatedAt > STALE_AFTER_MS;
}

/**
 * Try to claim the run. Returns {acquired:true, record} on success, or
 * {acquired:false, holder} when another tab holds a fresh lock. Re-acquiring
 * one's own lock keeps the original startedAt.
 */
export async function tryAcquire(store, tabId, nowMs = Date.now()) {
  let current = null;
  try {
    current = await store.get(RUNNING_KEY);
  } catch {
    current = null; // unreadable flag -> treat as free
  }
  if (!isStale(current, nowMs) && current.tabId !== tabId) {
    return { acquired: false, holder: current };
  }
  const record = {
    tabId,
    startedAt: isRecord(current) && current.tabId === tabId ? current.startedAt : nowMs,
    updatedAt: nowMs,
  };
  await store.set({ [RUNNING_KEY]: record });
  return { acquired: true, record };
}

/** Refresh our heartbeat; silently no-ops if we no longer hold the lock. */
export async function heartbeat(store, tabId, nowMs = Date.now()) {
  try {
    const current = await store.get(RUNNING_KEY);
    if (isRecord(current) && current.tabId === tabId) {
      await store.set({ [RUNNING_KEY]: { ...current, updatedAt: nowMs } });
    }
  } catch { /* best effort */ }
}

/** Release the lock (only ours). */
export async function release(store, tabId) {
  try {
    const current = await store.get(RUNNING_KEY);
    if (!isRecord(current) || current.tabId === tabId) {
      await store.remove(RUNNING_KEY);
    }
  } catch { /* nothing to release */ }
}
