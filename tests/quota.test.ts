/**
 * Core tests for the passive OpenCodex quota-pool fetching and normalization.
 * The local management endpoint is stubbed with `globalThis.fetch`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  fetchQuota,
  normalizeLabel,
  OPENCODEX_QUOTA_ENDPOINT,
  OPENCODEX_REFRESH_COOLDOWN_MS,
  OPENCODEX_REFRESH_ENDPOINT,
  parseQuotaPool,
  refreshQuota,
  type QuotaSnapshot,
  resolveAdminToken,
} from "../src/quota.ts";

const ENV_KEYS = [
  "HOME",
  "OPENCODEX_ADMIN_AUTH_TOKEN",
  "OPENCODEX_ADMIN_TOKEN_FILE",
  "OPENCODEX_HOME",
] as const;

type FetchCall = { url: string; init: RequestInit | undefined };
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function capture(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** The reading without its diagnostics, so a test can assert the safe error. */
async function failure(): Promise<{ providers: unknown[]; error?: string }> {
  const { providers, error } = await fetchQuota();
  return { providers, error };
}

function stubFetch(state: { calls: FetchCall[] }, behaviour: FetchStub): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    state.calls.push({ url: String(input), init });
    return behaviour(String(input), init);
  }) as typeof fetch;
}

function useEnv(): { restore: () => void } {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  return {
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** A clock well clear of the previous test's attempt, so cooldown state is isolated. */
let clockBase = 1_000_000_000_000;

function useClock(): { advance: (ms: number) => void; restore: () => void } {
  const original = Date.now;
  let now = (clockBase += OPENCODEX_REFRESH_COOLDOWN_MS * 2);
  Date.now = () => now;
  return {
    advance: (ms) => {
      now += ms;
    },
    restore: () => {
      // Start the next test clear of this test's last attempt, however far it ran.
      clockBase = Math.max(clockBase, now);
      Date.now = original;
    },
  };
}

let env: { restore: () => void };

beforeEach(() => {
  env = useEnv();
});

afterEach(() => {
  env.restore();
});

/** A valid token in the environment, so token resolution never touches the disk. */
function withEnvToken(): void {
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "test-token";
}

const OBSERVED = "2026-10-24T10:00:00.000Z";

const PAYLOAD = {
  schema: "ocx.quota-pool/1",
  producer: { version: "1.2.3", role: "standalone", homeId: "home_opaque_id" },
  generatedAt: "2026-10-24T10:00:05.000Z",
  providers: [
    {
      provider: "openai-codex",
      pooled: {
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 62,
            resetsAt: "2026-10-30T00:00:00.000Z",
            source: "measured",
            observedAt: OBSERVED,
            exhausted: false,
          },
          {
            id: "5h",
            kind: "burst_5h",
            label: "5-hour",
            usedPercent: 0,
            resetsAt: "2026-10-24T15:00:00.000Z",
            windowSeconds: 18_000,
            source: "header",
            observedAt: OBSERVED,
          },
          {
            id: "credits:usd",
            kind: "credits",
            label: "USD credits",
            used: 3,
            limit: 10,
            unit: "usd",
            source: "measured",
            observedAt: OBSERVED,
          },
        ],
        headroom: 38,
        nextResetAt: "2026-10-24T15:00:00.000Z",
      },
      accounts: [
        {
          provider: "openai-codex",
          accountRef: "acct_opaque_secret",
          label: "Team\nAccount",
          plan: "Pro",
          state: "exhausted",
          failure: "quota_exhausted",
          windows: [
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 100,
              source: "measured",
              observedAt: OBSERVED,
              exhausted: true,
            },
            {
              id: "family:claude",
              kind: "custom",
              label: "Claude",
              usedPercent: 40,
              scopeModel: "claude-sonnet-4",
              source: "estimated",
              observedAt: OBSERVED,
            },
          ],
        },
        {
          provider: "openai-codex",
          accountRef: "acct_unknown",
          state: "unknown",
          windows: [],
        },
      ],
    },
    {
      provider: "anthropic",
      pooled: { windows: [] },
      accounts: [],
    },
  ],
};

test("fetchQuota calls only the fixed quota-pool endpoint with a bearer token and rejects redirects", async () => {
  withEnvToken();
  const state = capture();
  stubFetch(state, async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));

  try {
    const snapshot = await fetchQuota();
    assert.equal(snapshot.error, undefined);
    assert.equal(state.calls.length, 1, "there is no fallback request");
    assert.equal(state.calls[0]?.url, OPENCODEX_QUOTA_ENDPOINT);
    assert.equal(OPENCODEX_QUOTA_ENDPOINT, "http://127.0.0.1:10100/api/quota-pool");
    const init = state.calls[0]?.init;
    assert.equal(init?.method, undefined, "the read is a GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal, "request is bounded by a timeout signal");
    assert.deepEqual(init?.headers, { Authorization: "Bearer test-token" });
  } finally {
    state.restore();
  }
});

test("fetchQuota normalizes pooled windows, accounts, states, and observation times", async () => {
  withEnvToken();
  const state = capture();
  stubFetch(state, async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));

  try {
    const snapshot = await fetchQuota();
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.generatedAt, "2026-10-24T10:00:05.000Z");
    assert.deepEqual(snapshot.providers, [
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
              observedAt: OBSERVED,
              exhausted: false,
            },
            {
              kind: "burst_5h",
              label: "5-hour",
              usedPercent: 0,
              resetsAt: "2026-10-24T15:00:00.000Z",
              windowSeconds: 18_000,
              source: "header",
              observedAt: OBSERVED,
            },
            {
              kind: "credits",
              label: "USD credits",
              used: 3,
              limit: 10,
              unit: "usd",
              source: "measured",
              observedAt: OBSERVED,
            },
          ],
          headroom: 38,
          nextResetAt: "2026-10-24T15:00:00.000Z",
        },
        accounts: [
          {
            label: "Team Account",
            plan: "Pro",
            state: "exhausted",
            windows: [
              {
                kind: "weekly",
                label: "Weekly",
                usedPercent: 100,
                source: "measured",
                observedAt: OBSERVED,
                exhausted: true,
              },
              {
                kind: "custom",
                label: "Claude",
                usedPercent: 40,
                scopeModel: "claude-sonnet-4",
                source: "estimated",
                observedAt: OBSERVED,
              },
            ],
          },
          { state: "unknown", windows: [] },
        ],
      },
      { provider: "anthropic", pooled: { windows: [] }, accounts: [] },
    ]);

    // Opaque identifiers and the upstream failure code stay out of the display shape.
    const serialized = JSON.stringify(snapshot);
    for (const hidden of ["home_opaque_id", "acct_opaque_secret", "accountRef", "quota_exhausted"]) {
      assert.doesNotMatch(serialized, new RegExp(hidden));
    }
  } finally {
    state.restore();
  }
});

test("a missing usedPercent remains unknown instead of becoming zero", () => {
  const parsed = parseQuotaPool({
    ...PAYLOAD,
    providers: [
      {
        provider: "kiro",
        pooled: {
          windows: [
            {
              id: "credits:kiro",
              kind: "credits",
              label: "Kiro credits",
              used: 4,
              limit: 10,
              unit: "credits",
              source: "measured",
              observedAt: OBSERVED,
            },
          ],
        },
        accounts: [{ provider: "kiro", accountRef: "acct", state: "unknown", windows: [] }],
      },
    ],
  });

  assert.equal(parsed.error, undefined);
  const window = parsed.providers[0]?.pooled.windows[0];
  assert.ok(window);
  assert.equal("usedPercent" in window, false);
  assert.equal(window.used, 4);
  assert.equal(window.limit, 10);
});

test("windowSeconds accepts zero, matching the upstream mirror", () => {
  const parsed = parseQuotaPool({
    ...PAYLOAD,
    providers: [
      {
        provider: "kiro",
        pooled: {
          windows: [
            {
              id: "burst",
              kind: "burst_5h",
              label: "5-hour",
              usedPercent: 10,
              windowSeconds: 0,
              source: "measured",
              observedAt: OBSERVED,
            },
          ],
        },
        accounts: [],
      },
    ],
  });

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.providers[0]?.pooled.windows[0]?.windowSeconds, 0);

  const negative = parseQuotaPool({
    ...PAYLOAD,
    providers: [
      {
        provider: "kiro",
        pooled: {
          windows: [
            {
              id: "burst",
              kind: "burst_5h",
              label: "5-hour",
              windowSeconds: -1,
              source: "measured",
              observedAt: OBSERVED,
            },
          ],
        },
        accounts: [],
      },
    ],
  });
  assert.equal(negative.error, "Invalid quota pool response");
});

test("an empty pool is valid and carries no invented quota", async () => {
  withEnvToken();
  const state = capture();
  stubFetch(
    state,
    async () =>
      new Response(
        JSON.stringify({
          schema: "ocx.quota-pool/1",
          producer: { version: "1.0.0", role: "hub", homeId: "home" },
          generatedAt: OBSERVED,
          providers: [],
        }),
        { status: 200 },
      ),
  );

  try {
    const snapshot = await fetchQuota();
    assert.deepEqual(snapshot, {
      providers: [],
      generatedAt: OBSERVED,
      diagnostics: { endpoint: OPENCODEX_QUOTA_ENDPOINT, tokenConfigured: true },
    });
  } finally {
    state.restore();
  }
});

test("rejects an incompatible schema and malformed pool data", () => {
  const cases: unknown[] = [
    { schema: "ocx.quota-pool/2", producer: PAYLOAD.producer, generatedAt: OBSERVED, providers: [] },
    { producer: PAYLOAD.producer, generatedAt: OBSERVED, providers: [] },
    { schema: "ocx.quota-pool/1", generatedAt: OBSERVED, providers: [] },
    { schema: "ocx.quota-pool/1", producer: PAYLOAD.producer, providers: [] },
    { schema: "ocx.quota-pool/1", producer: PAYLOAD.producer, generatedAt: "not-a-time", providers: [] },
    { schema: "ocx.quota-pool/1", producer: PAYLOAD.producer, generatedAt: OBSERVED, providers: "nope" },
    {
      schema: "ocx.quota-pool/1",
      producer: PAYLOAD.producer,
      generatedAt: OBSERVED,
      providers: [{ provider: "x", pooled: {}, accounts: [] }],
    },
    {
      schema: "ocx.quota-pool/1",
      producer: PAYLOAD.producer,
      generatedAt: OBSERVED,
      providers: [
        {
          provider: "x",
          pooled: { windows: [{ id: "w", kind: "hourly", label: "W", source: "measured", observedAt: OBSERVED }] },
          accounts: [],
        },
      ],
    },
    {
      schema: "ocx.quota-pool/1",
      producer: PAYLOAD.producer,
      generatedAt: OBSERVED,
      providers: [
        {
          provider: "x",
          pooled: { windows: [{ id: "w", kind: "weekly", label: "W", usedPercent: 101, source: "measured", observedAt: OBSERVED }] },
          accounts: [],
        },
      ],
    },
    {
      schema: "ocx.quota-pool/1",
      producer: PAYLOAD.producer,
      generatedAt: OBSERVED,
      providers: [
        {
          provider: "x",
          pooled: { windows: [{ id: "w", kind: "weekly", label: "W", source: "measured", observedAt: "yesterday" }] },
          accounts: [],
        },
      ],
    },
    {
      schema: "ocx.quota-pool/1",
      producer: PAYLOAD.producer,
      generatedAt: OBSERVED,
      providers: [
        {
          provider: "x",
          pooled: { windows: [] },
          accounts: [{ provider: "x", state: "disabled", windows: [] }],
        },
      ],
    },
    {
      schema: "ocx.quota-pool/1",
      producer: PAYLOAD.producer,
      generatedAt: OBSERVED,
      providers: [
        {
          provider: "x",
          pooled: { windows: [] },
          accounts: [{ provider: "x", accountRef: "a", state: "available", windows: [{ id: "w", kind: "weekly", label: "W", source: "measured" }] }],
        },
      ],
    },
  ];

  for (const payload of cases) {
    const parsed = parseQuotaPool(payload);
    assert.deepEqual(parsed.providers, [], "no partial provider list is shown");
    assert.match(parsed.error ?? "", /^(Invalid quota pool response|Unsupported quota pool schema)$/);
  }
  assert.deepEqual(parseQuotaPool(null), { providers: [], error: "Invalid quota pool response" });
  assert.deepEqual(parseQuotaPool("nope"), { providers: [], error: "Invalid quota pool response" });
});

test("fetchQuota reports invalid JSON, HTTP errors, redirects, and timeouts safely", async () => {
  withEnvToken();
  const state = capture();

  try {
    stubFetch(state, async () => new Response("not json", { status: 200 }));
    assert.deepEqual(await failure(), { providers: [], error: "Local quota service returned invalid JSON" });

    stubFetch(state, async () => new Response(JSON.stringify({ schema: "other" }), { status: 200 }));
    assert.deepEqual(await failure(), { providers: [], error: "Unsupported quota pool schema" });

    stubFetch(state, async () => new Response("boom", { status: 503 }));
    assert.deepEqual(await failure(), { providers: [], error: "Local quota service returned HTTP 503" });

    stubFetch(state, async () => {
      throw new TypeError("unexpected redirect");
    });
    assert.deepEqual(await failure(), { providers: [], error: "Local quota service unavailable" });

    stubFetch(state, async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    assert.deepEqual(await failure(), { providers: [], error: "Local quota service timed out" });
  } finally {
    state.restore();
  }
});

test("fetchQuota never echoes network or response-body details", async () => {
  withEnvToken();
  const state = capture();

  try {
    const redactionFixture = "Bearer test-token /home/example/.opencodex";
    stubFetch(state, async () => {
      throw new Error(`connect failed: ${redactionFixture}`);
    });
    const network = await failure();
    assert.deepEqual(network, { providers: [], error: "Local quota service unavailable" });
    assert.doesNotMatch(JSON.stringify(network), /test-token|\.opencodex/);

    stubFetch(state, async () => new Response(`failure: ${redactionFixture}`, { status: 500 }));
    const http = await failure();
    assert.deepEqual(http, { providers: [], error: "Local quota service returned HTTP 500" });
    assert.doesNotMatch(JSON.stringify(http), /test-token|\.opencodex/);
  } finally {
    state.restore();
  }
});

test("fetchQuota caps the body at 1MB, declared or streamed", async () => {
  withEnvToken();
  const state = capture();

  try {
    stubFetch(
      state,
      async () =>
        new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { "content-length": String(2_000_000) },
        }),
    );
    assert.deepEqual(await failure(), { providers: [], error: "Local quota response exceeds size limit" });

    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    });
    stubFetch(state, async () => new Response(chunks, { status: 200 }));
    assert.deepEqual(await failure(), { providers: [], error: "Local quota response exceeds size limit" });
  } finally {
    state.restore();
  }
});

test("fetchQuota cancels unread bodies on non-ok and declared oversize responses", async () => {
  withEnvToken();
  const state = capture();

  try {
    let nonOkCancelled = false;
    stubFetch(
      state,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("unread"));
            },
            cancel() {
              nonOkCancelled = true;
            },
          }),
          { status: 503 },
        ),
    );
    assert.deepEqual(await failure(), { providers: [], error: "Local quota service returned HTTP 503" });
    assert.equal(nonOkCancelled, true, "the non-ok body is cancelled");

    let oversizedCancelled = false;
    stubFetch(
      state,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("unread"));
            },
            cancel() {
              oversizedCancelled = true;
            },
          }),
          { status: 200, headers: { "content-length": String(2_000_000) } },
        ),
    );
    assert.deepEqual(await failure(), { providers: [], error: "Local quota response exceeds size limit" });
    assert.equal(oversizedCancelled, true, "the declared-oversize body is cancelled");

    stubFetch(
      state,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("unread"));
            },
            cancel() {
              throw new Error("cancel failure: secret detail");
            },
          }),
          { status: 500 },
        ),
    );
    const rejectedCancel = await failure();
    assert.deepEqual(rejectedCancel, { providers: [], error: "Local quota service returned HTTP 500" });
    assert.doesNotMatch(JSON.stringify(rejectedCancel), /secret detail/);
  } finally {
    state.restore();
  }
});

test("fetchQuota asks for a token and never calls the endpoint without one", async () => {
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_TOKEN_FILE = join(tmpdir(), "opencodex-quota-missing-token");
  const state = capture();
  stubFetch(state, async () => new Response("{}", { status: 200 }));

  try {
    const snapshot = await fetchQuota();
    assert.equal(state.calls.length, 0);
    assert.match(snapshot.error ?? "", /OPENCODEX_ADMIN_AUTH_TOKEN/);
    assert.deepEqual(snapshot.providers, []);
  } finally {
    state.restore();
  }
});

test("fetchQuota reports diagnostics without ever exposing the token", async () => {
  withEnvToken();
  const state = capture();
  stubFetch(state, async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));

  try {
    const snapshot = await fetchQuota();
    assert.deepEqual(snapshot.diagnostics, {
      endpoint: OPENCODEX_QUOTA_ENDPOINT,
      tokenConfigured: true,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /test-token/);
  } finally {
    state.restore();
  }
});

test("fetchQuota reports tokenConfigured false when no token is available", async () => {
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_TOKEN_FILE = join(tmpdir(), "opencodex-quota-missing-token");

  try {
    const snapshot = await fetchQuota();
    assert.deepEqual(snapshot.diagnostics, {
      endpoint: OPENCODEX_QUOTA_ENDPOINT,
      tokenConfigured: false,
    });
  } finally {
    // No fetch stub is installed; no request is made without a token.
  }
});

test("refreshQuota requests the fixed refresh endpoint, ignores its body, then reads the passive pool", async () => {
  withEnvToken();
  const clock = useClock();
  const state = capture();
  let bodyCancelled = false;

  stubFetch(state, async (url) => {
    if (url === OPENCODEX_REFRESH_ENDPOINT) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("unparsed refresh body"));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(PAYLOAD), { status: 200 });
  });

  try {
    const snapshot = await refreshQuota();
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.generatedAt, "2026-10-24T10:00:05.000Z");
    assert.deepEqual(snapshot.diagnostics, {
      endpoint: OPENCODEX_QUOTA_ENDPOINT,
      tokenConfigured: true,
    });

    assert.deepEqual(
      state.calls.map((call) => call.url),
      [OPENCODEX_REFRESH_ENDPOINT, OPENCODEX_QUOTA_ENDPOINT],
    );
    assert.equal(OPENCODEX_REFRESH_ENDPOINT, "http://127.0.0.1:10100/api/provider-quotas?refresh=1");

    const active = state.calls[0]?.init;
    assert.equal(active?.method, undefined, "the active call is a GET");
    assert.equal(active?.redirect, "error");
    assert.ok(active?.signal, "the active call is bounded by a timeout signal");
    assert.deepEqual(active?.headers, { Authorization: "Bearer test-token" });
    assert.equal(bodyCancelled, true, "the active response body is cancelled unread");
  } finally {
    state.restore();
    clock.restore();
  }
});

test("refreshQuota shares one active attempt across overlapping automatic and explicit calls", async () => {
  withEnvToken();
  const clock = useClock();
  const state = capture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  stubFetch(state, async (url) => {
    if (url === OPENCODEX_REFRESH_ENDPOINT) {
      await gate;
      return new Response("ignored", { status: 200 });
    }
    return new Response(JSON.stringify(PAYLOAD), { status: 200 });
  });

  try {
    const first = refreshQuota();
    const second = refreshQuota({ force: true });
    const third = refreshQuota();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      state.calls.map((call) => call.url),
      [OPENCODEX_REFRESH_ENDPOINT],
      "overlapping calls, including an explicit one, join the attempt",
    );

    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    assert.deepEqual(
      state.calls.map((call) => call.url),
      [OPENCODEX_REFRESH_ENDPOINT, OPENCODEX_QUOTA_ENDPOINT],
      "one active request and one passive read in total",
    );
  } finally {
    state.restore();
    clock.restore();
  }
});

test("refreshQuota enforces the five-minute cooldown and cools down to the passive pool", async () => {
  withEnvToken();
  const clock = useClock();
  const state = capture();

  stubFetch(state, async (url) =>
    url === OPENCODEX_REFRESH_ENDPOINT
      ? new Response("ignored", { status: 200 })
      : new Response(JSON.stringify(PAYLOAD), { status: 200 }),
  );

  try {
    assert.equal((await refreshQuota()).error, undefined);
    assert.equal(state.calls.length, 2);

    clock.advance(OPENCODEX_REFRESH_COOLDOWN_MS - 1);
    const cooled = await refreshQuota();
    assert.equal(cooled.error, undefined);
    assert.equal(state.calls.length, 3, "only the passive read runs inside the cooldown");
    assert.equal(state.calls[2]?.url, OPENCODEX_QUOTA_ENDPOINT);

    clock.advance(1);
    assert.equal((await refreshQuota()).error, undefined);
    assert.equal(state.calls.length, 5, "the active attempt resumes at the boundary");
    assert.equal(state.calls[3]?.url, OPENCODEX_REFRESH_ENDPOINT);
    assert.equal(state.calls[4]?.url, OPENCODEX_QUOTA_ENDPOINT);
  } finally {
    state.restore();
    clock.restore();
  }
});

test("an explicit force bypasses the cooldown and restarts automatic throttling", async () => {
  withEnvToken();
  const clock = useClock();
  const state = capture();

  stubFetch(state, async (url) =>
    url === OPENCODEX_REFRESH_ENDPOINT
      ? new Response("ignored", { status: 200 })
      : new Response(JSON.stringify(PAYLOAD), { status: 200 }),
  );

  try {
    assert.equal((await refreshQuota()).error, undefined);
    clock.advance(1);

    assert.equal((await refreshQuota({ force: false })).error, undefined);
    assert.equal(state.calls[2]?.url, OPENCODEX_QUOTA_ENDPOINT, "force false stays throttled");

    assert.equal((await refreshQuota({ force: true })).error, undefined);
    assert.equal(state.calls[3]?.url, OPENCODEX_REFRESH_ENDPOINT, "force runs the active rebuild");
    assert.equal(state.calls[4]?.url, OPENCODEX_QUOTA_ENDPOINT);

    clock.advance(OPENCODEX_REFRESH_COOLDOWN_MS - 1);
    assert.equal((await refreshQuota()).error, undefined);
    assert.equal(state.calls.length, 6, "the forced attempt restarts the cooldown");
    assert.equal(state.calls[5]?.url, OPENCODEX_QUOTA_ENDPOINT);

    clock.advance(1);
    assert.equal((await refreshQuota()).error, undefined);
    assert.deepEqual(
      state.calls.map((call) => call.url),
      [
        OPENCODEX_REFRESH_ENDPOINT,
        OPENCODEX_QUOTA_ENDPOINT,
        OPENCODEX_QUOTA_ENDPOINT,
        OPENCODEX_REFRESH_ENDPOINT,
        OPENCODEX_QUOTA_ENDPOINT,
        OPENCODEX_QUOTA_ENDPOINT,
        OPENCODEX_REFRESH_ENDPOINT,
        OPENCODEX_QUOTA_ENDPOINT,
      ],
      "automatic refreshes resume only after the forced attempt's cooldown",
    );
  } finally {
    state.restore();
    clock.restore();
  }
});

test("a failed active attempt consumes the cooldown and exposes no details", async () => {
  withEnvToken();
  const clock = useClock();
  const state = capture();
  const leaked = "Bearer test-token /home/example/.opencodex";

  stubFetch(state, async (url) => {
    if (url === OPENCODEX_REFRESH_ENDPOINT) {
      return new Response(`refresh failed: ${leaked}`, { status: 503 });
    }
    return new Response(JSON.stringify(PAYLOAD), { status: 200 });
  });

  try {
    const failed = await refreshQuota();
    assert.deepEqual(failed, {
      providers: [],
      error: "Local quota service returned HTTP 503",
      diagnostics: { endpoint: OPENCODEX_QUOTA_ENDPOINT, tokenConfigured: true },
    });
    assert.doesNotMatch(JSON.stringify(failed), /test-token|\.opencodex/);
    assert.equal(state.calls.length, 1, "no passive read after the active failure");

    clock.advance(OPENCODEX_REFRESH_COOLDOWN_MS - 1);
    const cooled = await refreshQuota();
    assert.equal(cooled.error, undefined);
    assert.ok(cooled.providers.length > 0);
    assert.deepEqual(
      state.calls.map((call) => call.url),
      [OPENCODEX_REFRESH_ENDPOINT, OPENCODEX_QUOTA_ENDPOINT],
      "the failure holds the cooldown instead of retrying",
    );
  } finally {
    state.restore();
    clock.restore();
  }
});

test("refreshQuota maps redirect rejection and timeouts to safe snapshot errors", async () => {
  withEnvToken();
  const clock = useClock();
  const state = capture();

  try {
    stubFetch(state, async (url) => {
      if (url === OPENCODEX_REFRESH_ENDPOINT) {
        throw new TypeError("unexpected redirect to /home/example Bearer test-token");
      }
      return new Response(JSON.stringify(PAYLOAD), { status: 200 });
    });
    const redirect = await refreshQuota();
    assert.deepEqual(redirect.providers, []);
    assert.equal(redirect.error, "Local quota service unavailable");
    assert.doesNotMatch(JSON.stringify(redirect), /test-token|\.opencodex|\/home\/example/);

    // Move past the failure cooldown with a fresh, isolated attempt time.
    clock.advance(OPENCODEX_REFRESH_COOLDOWN_MS);
    stubFetch(state, async (url) => {
      if (url === OPENCODEX_REFRESH_ENDPOINT) {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return new Response(JSON.stringify(PAYLOAD), { status: 200 });
    });
    const timeout = await refreshQuota();
    assert.deepEqual(timeout.providers, []);
    assert.equal(timeout.error, "Local quota service timed out");
  } finally {
    state.restore();
    clock.restore();
  }
});

test("refreshQuota makes no active request and no cooldown without a token", async () => {
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_TOKEN_FILE = join(tmpdir(), "opencodex-quota-missing-token");
  const clock = useClock();
  const state = capture();

  stubFetch(state, async (url) =>
    url === OPENCODEX_REFRESH_ENDPOINT
      ? new Response("ignored", { status: 200 })
      : new Response(JSON.stringify(PAYLOAD), { status: 200 }),
  );

  try {
    const missing = await refreshQuota();
    assert.equal(state.calls.length, 0, "no active request without a token");
    assert.match(missing.error ?? "", /OPENCODEX_ADMIN_AUTH_TOKEN/);
    assert.deepEqual(missing.providers, []);
    assert.equal(missing.diagnostics.tokenConfigured, false);

    // A token becoming available is not blocked by a cooldown that never began.
    withEnvToken();
    const refreshed = await refreshQuota();
    assert.equal(refreshed.error, undefined);
    assert.deepEqual(
      state.calls.map((call) => call.url),
      [OPENCODEX_REFRESH_ENDPOINT, OPENCODEX_QUOTA_ENDPOINT],
    );
  } finally {
    state.restore();
    clock.restore();
  }
});

test("token resolution prefers the environment, then the configured file, then the home file", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencodex-quota-"));
  const tokenFile = join(home, "custom-token");
  await writeFile(tokenFile, "file-token\n", "utf8");
  await writeFile(join(home, "admin-api-token"), "home-token\n", "utf8");

  try {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "env-token";
    process.env.OPENCODEX_ADMIN_TOKEN_FILE = tokenFile;
    assert.equal(await resolveAdminToken(), "env-token");

    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    assert.equal(await resolveAdminToken(), "file-token");

    delete process.env.OPENCODEX_ADMIN_TOKEN_FILE;
    process.env.OPENCODEX_HOME = home;
    assert.equal(await resolveAdminToken(), "home-token");

    process.env.OPENCODEX_HOME = join(home, "absent");
    assert.equal(await resolveAdminToken(), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("token resolution expands a leading ~ in configured paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencodex-quota-tilde-"));
  await mkdir(join(home, "custom-home"), { recursive: true });
  await writeFile(join(home, "explicit-token"), "tilde-file-token\n", "utf8");
  await writeFile(join(home, "custom-home", "admin-api-token"), "tilde-home-token\n", "utf8");
  await writeFile(join(home, "admin-api-token"), "bare-tilde-token\n", "utf8");

  try {
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    process.env.HOME = home;

    process.env.OPENCODEX_ADMIN_TOKEN_FILE = "~/explicit-token";
    delete process.env.OPENCODEX_HOME;
    assert.equal(await resolveAdminToken(), "tilde-file-token");

    delete process.env.OPENCODEX_ADMIN_TOKEN_FILE;
    process.env.OPENCODEX_HOME = "~/custom-home";
    assert.equal(await resolveAdminToken(), "tilde-home-token");

    process.env.OPENCODEX_HOME = "~";
    assert.equal(await resolveAdminToken(), "bare-tilde-token");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("normalization sanitizes display labels without changing ordinary text", () => {
  assert.equal(normalizeLabel("OpenCodex"), "OpenCodex");
  assert.equal(normalizeLabel("Acme (EU) 5h"), "Acme (EU) 5h");
  assert.equal(normalizeLabel("  padded  "), "padded");
  assert.equal(normalizeLabel("Team\n[Weekly]\r\tAccount"), "Team [Weekly] Account");
  assert.equal(normalizeLabel("\u0000\u001b[31mred"), "[31mred");
  assert.equal(normalizeLabel(undefined), undefined);
  assert.equal(normalizeLabel(7), undefined);
  assert.equal(normalizeLabel("   "), undefined);
});

test("labels from the wire are sanitized before display", () => {
  const parsed = parseQuotaPool({
    ...PAYLOAD,
    providers: [
      {
        provider: "  openai\ncodex ",
        pooled: {
          windows: [
            {
              id: "w",
              kind: "weekly",
              label: " Week\u0007ly\u2028 ",
              source: "measured",
              observedAt: OBSERVED,
            },
          ],
        },
        accounts: [
          {
            provider: "openai-codex",
            accountRef: "a",
            label: " Team\nAccount ",
            state: "available",
            windows: [],
          },
        ],
      },
    ],
  });

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.providers[0]?.provider, "openai codex");
  assert.equal(parsed.providers[0]?.pooled.windows[0]?.label, "Week ly");
  assert.equal(parsed.providers[0]?.accounts[0]?.label, "Team Account");
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
});

test("the snapshot type exposes only normalized presentation fields", () => {
  const snapshot: QuotaSnapshot = {
    providers: [
      {
        provider: "openai-codex",
        pooled: { windows: [] },
        accounts: [{ label: "Team", state: "available", windows: [] }],
      },
    ],
    diagnostics: { endpoint: OPENCODEX_QUOTA_ENDPOINT, tokenConfigured: true },
  };
  assert.equal(snapshot.providers[0]?.accounts[0]?.state, "available");
});
