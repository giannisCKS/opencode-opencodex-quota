/**
 * Tests for the RPC definition that the server and the TUI share.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { QUOTA_RPC_ID, quotaRpc, type QuotaSnapshotInput } from "../src/rpc.ts";
import type { QuotaSnapshot } from "../src/quota.ts";

type Validator = {
  "~standard": { validate: (value: unknown) => unknown };
};

async function validate(schema: unknown, value: unknown) {
  return (await (schema as Validator)["~standard"].validate(value)) as {
    value?: unknown;
    issues?: { message: string }[];
  };
}

const SNAPSHOT: QuotaSnapshot = {
  providers: [
    {
      provider: "openai-codex",
      pooled: {
        windows: [
          {
            kind: "weekly",
            label: "Weekly",
            usedPercent: 62,
            resetsAt: "2026-10-30T00:00:00.000Z",
            source: "measured",
            observedAt: "2026-10-24T10:00:00.000Z",
            exhausted: false,
          },
        ],
        headroom: 38,
        nextResetAt: "2026-10-24T15:00:00.000Z",
      },
      accounts: [
        {
          label: "Team",
          plan: "Pro",
          state: "exhausted",
          windows: [],
        },
      ],
    },
  ],
  generatedAt: "2026-10-24T10:00:05.000Z",
  diagnostics: { endpoint: "http://127.0.0.1:10100/api/quota-pool", tokenConfigured: true },
};

test("quotaRpc is the opencodex.quota namespace with a single snapshot method", () => {
  assert.equal(QUOTA_RPC_ID, "opencodex.quota");
  assert.equal(quotaRpc.id, "opencodex.quota");
  assert.deepEqual(Object.keys(quotaRpc.methods), ["snapshot"]);
  assert.deepEqual(quotaRpc.events, {});
});

test("the snapshot input has no reset or refresh flag", async () => {
  const input = quotaRpc.methods.snapshot.input;
  const empty: QuotaSnapshotInput = {};
  assert.deepEqual(await validate(input, empty), { value: empty });
  assert.deepEqual(await validate(input, undefined), { value: undefined });
  assert.equal((await validate(input, "quota")).issues?.length, 1);
  assert.equal((await validate(input, { notifyReset: true })).issues?.length, 1);
  assert.equal((await validate(input, { refresh: true })).issues?.length, 1);
});

test("the snapshot output accepts a normalized pool and rejects malformed shapes", async () => {
  const output = quotaRpc.methods.snapshot.output;
  assert.deepEqual(await validate(output, SNAPSHOT), { value: SNAPSHOT });
  assert.deepEqual(
    await validate(output, {
      providers: [],
      error: "Local quota service unavailable",
      diagnostics: { endpoint: "http://127.0.0.1:10100/api/quota-pool", tokenConfigured: false },
    }),
    {
      value: {
        providers: [],
        error: "Local quota service unavailable",
        diagnostics: { endpoint: "http://127.0.0.1:10100/api/quota-pool", tokenConfigured: false },
      },
    },
  );

  const invalid = [
    undefined,
    null,
    {},
    { providers: "nope", diagnostics: { endpoint: "x", tokenConfigured: true } },
    { providers: [], diagnostics: undefined },
    { providers: [], diagnostics: { endpoint: "x" } },
    { providers: [], error: 7, diagnostics: { endpoint: "x", tokenConfigured: true } },
    { providers: [], generatedAt: "yesterday", diagnostics: { endpoint: "x", tokenConfigured: true } },
  ];
  for (const value of invalid) {
    assert.equal((await validate(output, value)).issues?.length, 1);
  }

  const badAccount = structuredClone(SNAPSHOT) as unknown as {
    providers: { accounts: { state: string }[] }[];
  };
  badAccount.providers[0]!.accounts[0]!.state = "disabled";
  assert.equal((await validate(output, badAccount)).issues?.length, 1);

  const badWindow = structuredClone(SNAPSHOT) as unknown as {
    providers: { pooled: { windows: { usedPercent: number }[] } }[];
  };
  badWindow.providers[0]!.pooled.windows[0]!.usedPercent = 101;
  assert.equal((await validate(output, badWindow)).issues?.length, 1);
});

test("the snapshot output accepts windowSeconds zero and rejects negative values", async () => {
  const output = quotaRpc.methods.snapshot.output;

  const zero = structuredClone(SNAPSHOT) as unknown as {
    providers: { pooled: { windows: { windowSeconds?: number }[] } }[];
  };
  zero.providers[0]!.pooled.windows[0]!.windowSeconds = 0;
  assert.deepEqual(await validate(output, zero), { value: zero });

  const negative = structuredClone(SNAPSHOT) as unknown as {
    providers: { pooled: { windows: { windowSeconds?: number }[] } }[];
  };
  negative.providers[0]!.pooled.windows[0]!.windowSeconds = -1;
  assert.equal((await validate(output, negative)).issues?.length, 1);
});
