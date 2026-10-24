import assert from "node:assert/strict";
import test from "node:test";

// The renderer runs the client Solid runtime entry. Importing it here makes the
// regression fail when the store is created on a different runtime.
import { createEffect, createRoot } from "solid-js/dist/solid.js";

import type { QuotaSnapshot } from "../src/quota.ts";
import { createQuotaStore } from "../src/tui.tsx";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function snapshot(generatedAt: string): QuotaSnapshot {
  return { providers: [], generatedAt };
}

test("store signals notify effects on the renderer runtime after a later poll", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());

  const first = snapshot("2026-10-24T12:00:00.000Z");
  const second = snapshot("2026-10-24T12:01:00.000Z");
  let calls = 0;
  const store = createQuotaStore(async () => (++calls === 1 ? first : second), {
    pollIntervalMs: 60_000,
    now: () => NOW,
  });
  t.after(() => store.dispose());

  const seen: Array<string | undefined> = [];
  createRoot((dispose) => {
    t.after(dispose);
    createEffect(() => {
      seen.push(store.snapshot()?.generatedAt);
    });
  });

  assert.deepEqual(seen, [undefined], "the effect runs once before the first load settles");

  await settle();
  assert.deepEqual(
    seen,
    [undefined, first.generatedAt],
    "the initial load must rerun the renderer effect",
  );

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(
    seen,
    [undefined, first.generatedAt, second.generatedAt],
    "a later poll must rerun the renderer effect",
  );
});
