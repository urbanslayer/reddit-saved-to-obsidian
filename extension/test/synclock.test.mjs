// synclock.js tests: cross-tab "one sync at a time" flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUNNING_KEY, STALE_AFTER_MS, isStale, tryAcquire, heartbeat, release,
} from "../src/synclock.js";

function memoryStore() {
  const data = {};
  return {
    data,
    get: async (k) => data[k],
    set: async (obj) => Object.assign(data, obj),
    remove: async (k) => { delete data[k]; },
  };
}

const T0 = 1_700_000_000_000;

test("tryAcquire: first tab wins; a second tab is refused while the lock is fresh", async () => {
  const store = memoryStore();
  const a = await tryAcquire(store, "tabA", T0);
  assert.equal(a.acquired, true);
  assert.equal(store.data[RUNNING_KEY].tabId, "tabA");

  const b = await tryAcquire(store, "tabB", T0 + 1000);
  assert.equal(b.acquired, false);
  assert.equal(b.holder.tabId, "tabA");
  // the refusal must not steal the lock
  assert.equal(store.data[RUNNING_KEY].tabId, "tabA");
});

test("tryAcquire: re-acquiring your own lock keeps startedAt and refreshes updatedAt", async () => {
  const store = memoryStore();
  await tryAcquire(store, "tabA", T0);
  const again = await tryAcquire(store, "tabA", T0 + 5000);
  assert.equal(again.acquired, true);
  assert.equal(again.record.startedAt, T0);
  assert.equal(again.record.updatedAt, T0 + 5000);
});

test("stale after 2 min without a heartbeat; a fresh heartbeat keeps the lock alive", async () => {
  const store = memoryStore();
  await tryAcquire(store, "tabA", T0);
  assert.equal(isStale(store.data[RUNNING_KEY], T0 + STALE_AFTER_MS - 1), false);
  assert.equal(isStale(store.data[RUNNING_KEY], T0 + STALE_AFTER_MS + 1), true);

  await heartbeat(store, "tabA", T0 + 60_000);
  assert.equal(store.data[RUNNING_KEY].updatedAt, T0 + 60_000);
  assert.equal(isStale(store.data[RUNNING_KEY], T0 + STALE_AFTER_MS + 1), false);

  // heartbeat from a non-holder never hijacks the flag
  await heartbeat(store, "tabB", T0 + 61_000);
  assert.equal(store.data[RUNNING_KEY].tabId, "tabA");

  // crashed tab: once stale, another tab may take over
  const b = await tryAcquire(store, "tabB", T0 + 3 * STALE_AFTER_MS);
  assert.equal(b.acquired, true);
  assert.equal(store.data[RUNNING_KEY].tabId, "tabB");
});

test("release: only clears the lock it owns", async () => {
  const store = memoryStore();
  await tryAcquire(store, "tabA", T0);
  await release(store, "tabB");
  assert.equal(store.data[RUNNING_KEY].tabId, "tabA", "wrong tab must not clear it");
  await release(store, "tabA");
  assert.equal(store.data[RUNNING_KEY], undefined);
  await release(store, "tabA"); // idempotent
});

test("garbage or absent flag is treated as free", async () => {
  const store = memoryStore();
  assert.equal(isStale(undefined, T0), true);
  assert.equal(isStale({ nonsense: true }, T0), true);
  store.data[RUNNING_KEY] = "not an object";
  const a = await tryAcquire(store, "tabA", T0);
  assert.equal(a.acquired, true);
});
