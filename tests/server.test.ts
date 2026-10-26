/**
 * Server plugin tests: the plugin registers only the quota RPC.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { OpenCodexQuotaPlugin, default as defaultExport } from "../src/index.ts";
import { quotaRpc } from "../src/rpc.ts";

const ENDPOINT = "http://127.0.0.1:10100/api/quota-pool";
const REFRESH_ENDPOINT = "http://127.0.0.1:10100/api/provider-quotas?refresh=1";

const PAYLOAD = {
  schema: "ocx.quota-pool/1",
  producer: { version: "1.2.3", role: "standalone", homeId: "home-opaque" },
  generatedAt: "2026-10-24T10:00:05.000Z",
  providers: [
    {
      provider: "openai-codex",
      pooled: {
        windows: [
          {
            id: "5h",
            kind: "burst_5h",
            label: "5-hour",
            usedPercent: 25,
            source: "measured",
            observedAt: "2026-10-24T10:00:00.000Z",
          },
        ],
      },
      accounts: [
        {
          provider: "openai-codex",
          accountRef: "account-opaque",
          label: "Team",
          state: "available",
          windows: [],
        },
      ],
    },
  ],
};

type Registered = {
  definition: { id: string; methods: Record<string, unknown> };
  handlers: Record<string, (input?: unknown) => Promise<unknown>>;
};

function fakeContext() {
  const registered: Registered[] = [];
  const calls = {
    command: 0,
    hook: 0,
    prompt: 0,
  };

  const context = {
    rpc: {
      register: async (definition: Registered["definition"], handlers: Registered["handlers"]) => {
        registered.push({ definition, handlers });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async () => {
        calls.command += 1;
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async () => {
        calls.hook += 1;
        return { dispose: async () => {} };
      },
      prompt: async () => {
        calls.prompt += 1;
      },
      wait: async () => {},
    },
  };

  return { context, registered, calls };
}

let env: { restore: () => void };
let fetchRestore: () => void;
let fetchCalls: { url: string; init: RequestInit | undefined }[];

beforeEach(() => {
  const saved = [["OPENCODEX_ADMIN_AUTH_TOKEN", process.env.OPENCODEX_ADMIN_AUTH_TOKEN]] as const;
  env = {
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "test-token";

  fetchCalls = [];
  const original = globalThis.fetch;
  fetchRestore = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url === REFRESH_ENDPOINT) {
      // The active response body is never parsed, so its content is irrelevant.
      return new Response("not parsed", { status: 200 });
    }
    return new Response(JSON.stringify(PAYLOAD), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  fetchRestore();
  env.restore();
});

/** Runs a Standard Schema validator from the RPC definition. */
async function validateSchema(schema: unknown, value: unknown) {
  const standard = (schema as { "~standard": { validate: (input: unknown) => unknown } })["~standard"];
  return (await standard.validate(value)) as { issues?: unknown[] };
}

test("setup registers one quota RPC with snapshot and refresh methods and no other surfaces", async () => {
  const { context, registered, calls } = fakeContext();
  await OpenCodexQuotaPlugin.setup(context as never);

  assert.equal(OpenCodexQuotaPlugin.id, "opencodex-quota.server");
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.definition, quotaRpc);
  assert.equal(registered[0]?.definition.id, "opencodex.quota");
  assert.deepEqual(Object.keys(registered[0]?.definition.methods ?? {}), ["snapshot", "refresh"]);
  assert.deepEqual(Object.keys(registered[0]?.handlers ?? {}), ["snapshot", "refresh"]);
  assert.deepEqual(calls, { command: 0, hook: 0, prompt: 0 }, "the server installs no commands or hooks");
});

test("the snapshot handler reads the passive pool and returns the normalized snapshot", async () => {
  const { context, registered } = fakeContext();
  await OpenCodexQuotaPlugin.setup(context as never);

  const snapshot = await registered[0]?.handlers.snapshot();
  assert.deepEqual(snapshot, {
    providers: [
      {
        provider: "openai-codex",
        pooled: {
          windows: [
            {
              kind: "burst_5h",
              label: "5-hour",
              usedPercent: 25,
              source: "measured",
              observedAt: "2026-10-24T10:00:00.000Z",
            },
          ],
        },
        accounts: [{ label: "Team", state: "available", windows: [] }],
      },
    ],
    generatedAt: "2026-10-24T10:00:05.000Z",
    diagnostics: { endpoint: ENDPOINT, tokenConfigured: true },
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, ENDPOINT);
  assert.equal(fetchCalls[0]?.init?.redirect, "error");
  assert.deepEqual(fetchCalls[0]?.init?.headers, { Authorization: "Bearer test-token" });
});

test("the refresh handler actively rebuilds provider reports, then rereads the passive pool", async () => {
  const { context, registered } = fakeContext();
  await OpenCodexQuotaPlugin.setup(context as never);

  const snapshot = await registered[0]?.handlers.refresh?.();
  assert.equal((snapshot as { generatedAt?: string }).generatedAt, "2026-10-24T10:00:05.000Z");

  assert.equal(fetchCalls.length, 2, "one active request and one passive read");
  assert.equal(fetchCalls[0]?.url, REFRESH_ENDPOINT);
  assert.equal(fetchCalls[0]?.init?.method, undefined, "the active call is a GET");
  assert.equal(fetchCalls[0]?.init?.redirect, "error");
  assert.ok(fetchCalls[0]?.init?.signal, "the active call is bounded by a timeout signal");
  assert.deepEqual(fetchCalls[0]?.init?.headers, { Authorization: "Bearer test-token" });

  assert.equal(fetchCalls[1]?.url, ENDPOINT);
  assert.equal(fetchCalls[1]?.init?.redirect, "error");
});

test("the refresh handler honors only an explicit force flag", async () => {
  const { context, registered } = fakeContext();
  await OpenCodexQuotaPlugin.setup(context as never);

  const forced = await registered[0]?.handlers.refresh?.({ force: true });
  assert.equal((forced as { generatedAt?: string }).generatedAt, "2026-10-24T10:00:05.000Z");
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [REFRESH_ENDPOINT, ENDPOINT],
    "an explicit request rebuilds even without a warm cooldown",
  );

  await registered[0]?.handlers.refresh?.({});
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [REFRESH_ENDPOINT, ENDPOINT, ENDPOINT],
    "an automatic request stays throttled",
  );

  await registered[0]?.handlers.refresh?.({ force: false });
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [REFRESH_ENDPOINT, ENDPOINT, ENDPOINT, ENDPOINT],
    "force false stays throttled",
  );

  await registered[0]?.handlers.refresh?.({ force: true });
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [REFRESH_ENDPOINT, ENDPOINT, ENDPOINT, ENDPOINT, REFRESH_ENDPOINT, ENDPOINT],
    "a later explicit request bypasses the cooldown again",
  );
});

test("the snapshot handler stays passive and never calls the refresh endpoint", async () => {
  const { context, registered } = fakeContext();
  await OpenCodexQuotaPlugin.setup(context as never);

  await registered[0]?.handlers.snapshot();
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [ENDPOINT],
  );
});

test("the registered snapshot handler satisfies the RPC wire schema the TUI calls", async () => {
  const { context, registered } = fakeContext();
  await OpenCodexQuotaPlugin.setup(context as never);

  const definition = registered[0]?.definition as unknown as {
    methods: { snapshot: { input: unknown; output: unknown }; refresh: { input: unknown; output: unknown } };
  };

  const input = await validateSchema(definition.methods.snapshot.input, {});
  assert.equal(input.issues, undefined, "the empty-object input the TUI sends is accepted");

  const refreshInput = await validateSchema(definition.methods.refresh.input, {});
  assert.equal(refreshInput.issues, undefined, "the automatic refresh input is accepted");
  const forcedInput = await validateSchema(definition.methods.refresh.input, { force: true });
  assert.equal(forcedInput.issues, undefined, "the explicit refresh input is accepted");
  const badForce = await validateSchema(definition.methods.refresh.input, { force: "yes" });
  assert.notEqual(badForce.issues, undefined, "a non-boolean force is rejected");
  const extraInput = await validateSchema(definition.methods.refresh.input, {
    force: true,
    extra: true,
  });
  assert.notEqual(extraInput.issues, undefined, "unknown inputs are rejected");
  const snapshotForce = await validateSchema(definition.methods.snapshot.input, { force: true });
  assert.notEqual(snapshotForce.issues, undefined, "the passive input stays empty");

  const snapshot = await registered[0]?.handlers.snapshot();
  const output = await validateSchema(definition.methods.snapshot.output, snapshot);
  assert.equal(output.issues, undefined, "the handler output passes the output schema");
});

test("the plugin has a default export for the directory loader", () => {
  assert.equal(defaultExport, OpenCodexQuotaPlugin);
});
