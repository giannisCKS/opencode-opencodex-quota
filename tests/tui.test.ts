import assert from "node:assert/strict";
import test from "node:test";

import plugin, {
  ageLabel,
  createQuotaStore,
  formatDuration,
  QUOTA_STALE_AFTER_MS,
  quotaDialogRows,
  quotaDialogSubtitle,
  quotaSidebarRows,
  quotaSidebarStatus,
  remainingLabel,
  TUI_SIDEBAR_MAX_WIDTH,
  type QuotaReading,
} from "../src/tui.tsx";
import type { QuotaSnapshot, QuotaWindow } from "../src/quota.ts";
import { quotaRpc } from "../src/rpc.ts";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    kind: "weekly",
    label: "Weekly",
    source: "measured",
    observedAt: at(-2 * MINUTE),
    ...overrides,
  };
}

const SNAPSHOT: QuotaSnapshot = {
  providers: [
    {
      provider: "openai-codex",
      pooled: {
        windows: [
          window({ usedPercent: 38, resetsAt: at(2 * HOUR) }),
          window({
            kind: "daily",
            label: "Daily",
            scopeModel: "gpt-5.2",
            source: "header",
            observedAt: at(-3 * MINUTE),
          }),
          window({
            kind: "credits",
            label: "Credits",
            usedPercent: 100,
            exhausted: true,
            source: "estimated",
            observedAt: at(-1 * MINUTE),
          }),
        ],
        headroom: 38,
        nextResetAt: at(2 * HOUR),
      },
      accounts: [
        { label: "Team", plan: "Pro", state: "exhausted", windows: [] },
        {
          label: "Personal",
          state: "available",
          windows: [
            window({
              usedPercent: 20,
              scopeModel: "gpt-5.2",
              resetsAt: at(4 * HOUR),
            }),
          ],
        },
      ],
    },
    {
      provider: "second-provider",
      pooled: { windows: [] },
      accounts: [
        { label: "Spare", state: "paused", windows: [] },
        { label: "Old", state: "reauth", windows: [] },
        { label: "Mystery", state: "unknown", windows: [] },
      ],
    },
  ],
  generatedAt: at(-2 * MINUTE),
  diagnostics: { endpoint: "http://127.0.0.1:10100/api/quota-pool", tokenConfigured: true },
};

/** The upstream producer may report no pooled windows but real per-account windows. */
const ACCOUNT_ONLY: QuotaSnapshot = {
  ...SNAPSHOT,
  providers: [
    {
      provider: "account-only",
      pooled: { windows: [] },
      accounts: [
        {
          label: "Shared",
          state: "available",
          windows: [
            window({
              usedPercent: 30,
              scopeModel: "gpt-5.2",
              resetsAt: at(3 * HOUR),
            }),
          ],
        },
        { label: "Empty", state: "unknown", windows: [] },
      ],
    },
  ],
};

function reading(overrides: Partial<QuotaReading> = {}): QuotaReading {
  return { snapshot: SNAPSHOT, loading: false, now: NOW, ...overrides };
}

const textOf = (rows: { text: string }[]) => rows.map((row) => row.text);
const joined = (rows: { text: string }[]) =>
  textOf(rows)
    .join(" ")
    .replace(/\s+/gu, " ");

test("remaining quota is explicit, and unknown stays unknown", () => {
  assert.equal(remainingLabel(window({ usedPercent: 38 })), "62% left");
  assert.equal(remainingLabel(window({ usedPercent: 0 })), "100% left");
  assert.equal(remainingLabel(window({ usedPercent: 100 })), "0% left");
  assert.equal(remainingLabel(window({ usedPercent: 38.4 })), "61.6% left");
  assert.equal(remainingLabel(window({ usedPercent: 0, exhausted: true })), "100% left, exhausted");
  assert.equal(remainingLabel(window({})), "remaining unknown");
  assert.equal(remainingLabel(window({ exhausted: true })), "exhausted");
});

test("exhausted windows keep the percent and one explicit marker", () => {
  const snapshot = (value: QuotaWindow): QuotaSnapshot => ({
    ...SNAPSHOT,
    providers: [
      {
        provider: "limit-provider",
        pooled: { windows: [value] },
        accounts: [],
      },
    ],
  });

  const exhausted = snapshot(window({ usedPercent: 0, exhausted: true }));
  const sidebar = joined(quotaSidebarRows(reading({ snapshot: exhausted })));
  assert.ok(sidebar.includes("Weekly: 100% left, exhausted"));
  assert.equal((sidebar.match(/exhausted/gu) ?? []).length, 1);

  const dialog = joined(quotaDialogRows(reading({ snapshot: exhausted })));
  assert.ok(dialog.includes("Weekly: 100% left, exhausted"));
  assert.ok(dialog.includes("used 0%"));
  assert.equal((dialog.match(/exhausted/gu) ?? []).length, 1);

  const unknown = snapshot(window({ exhausted: true }));
  const unknownSidebar = joined(quotaSidebarRows(reading({ snapshot: unknown })));
  assert.ok(unknownSidebar.includes("Weekly: exhausted"));
  assert.equal((unknownSidebar.match(/exhausted/gu) ?? []).length, 1);
});

test("age labels are compact and bounded", () => {
  assert.equal(ageLabel(at(-2 * MINUTE), NOW), "2m ago");
  assert.equal(ageLabel(at(-3 * HOUR), NOW), "3h ago");
  assert.equal(ageLabel(at(2_000), NOW), "just now");
  assert.equal(ageLabel(undefined, NOW), undefined);
  assert.equal(formatDuration((2 * 24 + 3) * HOUR), "2d");
});

test("sidebar keeps every provider, pooled window, account, and model scope", () => {
  const rows = quotaSidebarRows(reading());
  const text = textOf(rows);
  const all = joined(rows);

  assert.ok(text.includes("openai-codex"));
  assert.ok(text.includes("second-provider"));
  assert.ok(all.includes("Pooled"));
  assert.ok(all.includes("Accounts"));
  assert.ok(all.includes("Weekly: 62% left, reset in 2h"));
  assert.ok(all.includes("Daily (gpt-5.2): remaining unknown"));
  assert.ok(all.includes("Credits: 0% left, exhausted"));
  assert.ok(all.includes("Team (Pro): exhausted"));
  assert.ok(all.includes("Personal: available"));
  assert.ok(all.includes("No pooled windows."));
  assert.ok(all.includes("Spare: paused"));
  assert.ok(all.includes("Old: sign-in required"));
  assert.ok(all.includes("Mystery: unknown"));

  for (const row of rows) {
    assert.ok(
      row.text.length <= TUI_SIDEBAR_MAX_WIDTH,
      `too wide (${row.text.length}): ${row.text}`,
    );
  }
});

test("account windows stay visible when pooled windows are empty", () => {
  const value = reading({ snapshot: ACCOUNT_ONLY });
  const sidebar = joined(quotaSidebarRows(value));
  assert.ok(sidebar.includes("No pooled windows."));
  assert.ok(sidebar.includes("Shared: available"));
  assert.ok(sidebar.includes("Weekly (gpt-5.2): 70% left, reset in 3h"));
  assert.ok(sidebar.includes("70% left"), "the real account percentage must be shown");
  assert.ok(sidebar.includes("Empty: unknown"));
  assert.ok(sidebar.includes("Quota unknown."), "an empty account is unknown, not zero");
  assert.ok(!/(?:^|\s)0% left/.test(sidebar));

  const dialog = joined(quotaDialogRows(value));
  assert.ok(dialog.includes("Shared: available"));
  assert.ok(dialog.includes("Weekly (gpt-5.2): 70% left"));
  assert.ok(dialog.includes("Empty: unknown"));
  assert.ok(dialog.includes("Quota unknown."));
  assert.ok(!/(?:^|\s)0% left/.test(dialog));
});

test("sidebar status distinguishes fresh, stale, loading, unavailable, and empty", () => {
  assert.equal(quotaSidebarStatus(reading()), "2m ago");

  const staleSnapshot = { ...SNAPSHOT, generatedAt: at(-(QUOTA_STALE_AFTER_MS + MINUTE)) };
  assert.equal(quotaSidebarStatus(reading({ snapshot: staleSnapshot })), "stale 6m");

  assert.equal(quotaSidebarStatus(reading({ snapshot: undefined, loading: true })), "loading");
  assert.equal(
    quotaSidebarStatus(
      reading({ snapshot: undefined, loading: false, failure: "Local quota service unavailable" }),
    ),
    "unavailable",
  );
  assert.equal(
    quotaSidebarStatus(reading({ snapshot: { ...SNAPSHOT, providers: [] } })),
    undefined,
  );
  assert.equal(quotaSidebarStatus(reading({ failure: "RPC unavailable" })), "update failed");
});

test("sidebar rows show errors and an empty pool without inventing quota", () => {
  const unavailable = quotaSidebarRows(
    reading({ snapshot: undefined, failure: "Local quota service unavailable" }),
  );
  assert.equal(unavailable[0]?.tone, "warning");
  assert.ok(joined(unavailable).includes("Unavailable: Local quota service unavailable"));

  const empty = quotaSidebarRows(reading({ snapshot: { ...SNAPSHOT, providers: [] } }));
  assert.ok(joined(empty).includes("No pooled quota reported."));
  assert.ok(!joined(empty).includes("% left"));
});

test("dialog shows pooled and account quota, reset, observation, and source", () => {
  const rows = quotaDialogRows(reading());
  const text = textOf(rows);
  const all = joined(rows);

  assert.ok(text.includes("openai-codex"));
  assert.ok(text.includes("second-provider"));
  assert.ok(text.includes("Pooled"));
  assert.ok(text.includes("Accounts"));
  assert.ok(text.includes("  Weekly: 62% left"));
  assert.ok(
    text.includes("    used 38% | reset in 2h | observed 2m ago | source: measured"),
    all,
  );
  assert.ok(text.includes("  Daily (gpt-5.2): remaining unknown"));
  assert.ok(text.includes("  Credits: 0% left, exhausted"));
  assert.ok(all.includes("used 100% | observed 1m ago | source: estimated"));
  assert.ok(text.includes("  next reset in 2h"));
  assert.ok(text.includes("  Team (Pro): exhausted"));
  assert.ok(text.includes("  Personal: available"));
  assert.ok(all.includes("Weekly (gpt-5.2): 80% left"));
  assert.ok(all.includes("No pooled windows."));
  assert.ok(text.includes("  Spare: paused"));
  assert.ok(text.includes("  Old: sign-in required"));
  assert.ok(text.includes("  Mystery: unknown"));
});

test("dialog subtitle reports age, staleness, errors, and provider count", () => {
  assert.equal(quotaDialogSubtitle(reading()), "Cached quota | updated 2m ago | 2 providers");

  const staleSnapshot = { ...SNAPSHOT, generatedAt: at(-(QUOTA_STALE_AFTER_MS + MINUTE)) };
  assert.equal(
    quotaDialogSubtitle(reading({ snapshot: staleSnapshot })),
    "Cached quota | stale 6m | 2 providers",
  );
  assert.equal(
    quotaDialogSubtitle(reading({ snapshot: undefined, failure: "RPC unavailable" })),
    "No quota reading | unavailable",
  );
  assert.equal(
    quotaDialogSubtitle(reading({ snapshot: undefined, loading: true })),
    "Loading cached quota",
  );
});

test("dialog handles loading, errors, last known data, and an empty pool", () => {
  assert.ok(joined(quotaDialogRows(reading({ snapshot: undefined, loading: true }))).includes(
    "Loading quota…",
  ));
  assert.ok(joined(quotaDialogRows(reading({ snapshot: undefined, failure: "RPC unavailable" }))).includes(
    "Unavailable: RPC unavailable",
  ));

  const lastReading = quotaDialogRows(reading({ failure: "RPC unavailable" }));
  assert.ok(joined(lastReading).includes("Update failed: RPC unavailable"));
  assert.ok(joined(lastReading).includes("Showing the last reading."));
  assert.ok(joined(lastReading).includes("Weekly: 62% left"));

  const empty = quotaDialogRows(reading({ snapshot: { ...SNAPSHOT, providers: [] } }));
  assert.ok(joined(empty).includes("No pooled quota reported."));
});

type Deferred = {
  resolve: (value: QuotaSnapshot) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
};

function deferredLoader() {
  const pending: Deferred[] = [];
  const load = (signal: AbortSignal) =>
    new Promise<QuotaSnapshot>((resolve, reject) => {
      pending.push({ resolve, reject, signal });
    });
  return { pending, load };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("store loads once, coalesces refreshes, and keeps the last good reading", async (t) => {
  const { pending, load } = deferredLoader();
  const store = createQuotaStore(load, { pollIntervalMs: 60_000, now: () => NOW });
  t.after(() => store.dispose());

  assert.equal(store.loading(), true);
  assert.equal(pending.length, 1);

  store.refresh();
  assert.equal(pending.length, 1, "a refresh during a load must not start another request");

  pending[0].resolve(SNAPSHOT);
  await settle();
  assert.equal(store.snapshot(), SNAPSHOT);
  assert.equal(store.loading(), true, "the queued refresh is already in flight");
  assert.equal(store.lastLoadedAt(), NOW);
  assert.equal(pending.length, 2, "the queued refresh runs after the first load");

  pending[1].resolve(SNAPSHOT);
  await settle();
  assert.equal(store.loading(), false);
  assert.equal(pending.length, 2);

  store.refresh();
  pending[2].reject({ type: "rpc.unavailable", message: "RPC unavailable" });
  await settle();

  assert.equal(store.snapshot(), SNAPSHOT, "a failed refresh must keep the last reading");
  assert.match(store.failure() ?? "", /RPC unavailable/);
  assert.match(store.failure() ?? "", /server plugin is not loaded/);
  assert.equal(store.loading(), false);
});

test("store retains the last good snapshot when the backend reports an error", async (t) => {
  const { pending, load } = deferredLoader();
  let clock = NOW;
  const store = createQuotaStore(load, { pollIntervalMs: 60_000, now: () => clock });
  t.after(() => store.dispose());

  pending[0].resolve(SNAPSHOT);
  await settle();
  assert.equal(store.snapshot(), SNAPSHOT);
  assert.equal(store.lastLoadedAt(), NOW);

  clock += MINUTE;
  store.refresh();
  pending[1].resolve({
    providers: [],
    error: "Local quota service unavailable",
    diagnostics: { endpoint: "http://127.0.0.1:10100/api/quota-pool", tokenConfigured: true },
  });
  await settle();

  assert.equal(store.snapshot(), SNAPSHOT, "a backend error must not replace the last good reading");
  assert.equal(store.failure(), "Local quota service unavailable");
  assert.equal(store.lastLoadedAt(), NOW, "a backend error must not refresh the reading age");
  assert.equal(store.loading(), false);
});

test("store surfaces a backend error when there is no last good snapshot", async (t) => {
  const { pending, load } = deferredLoader();
  const store = createQuotaStore(load, { pollIntervalMs: 60_000, now: () => NOW });
  t.after(() => store.dispose());

  pending[0].resolve({
    providers: [],
    error: "No OpenCodex admin token: set OPENCODEX_ADMIN_AUTH_TOKEN or ~/.opencodex/admin-api-token",
    diagnostics: { endpoint: "http://127.0.0.1:10100/api/quota-pool", tokenConfigured: false },
  });
  await settle();

  assert.equal(store.snapshot(), undefined);
  assert.match(store.failure() ?? "", /No OpenCodex admin token/);
  assert.equal(store.loading(), false);
});

test("store aborts its request and drops a result after disposal", async (t) => {
  const { pending, load } = deferredLoader();
  const store = createQuotaStore(load, { pollIntervalMs: 60_000, now: () => NOW });
  t.after(() => store.dispose());

  assert.equal(pending.length, 1);
  store.dispose();
  assert.equal(pending[0].signal.aborted, true);

  pending[0].resolve(SNAPSHOT);
  await settle();
  assert.equal(store.snapshot(), undefined);
});

test("store polls on its interval and stops after disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());

  let calls = 0;
  let clock = NOW;
  const store = createQuotaStore(
    async () => {
      calls += 1;
      return SNAPSHOT;
    },
    { pollIntervalMs: 60_000, now: () => clock },
  );
  t.after(() => store.dispose());

  await settle();
  assert.equal(calls, 1);

  clock += 60_000;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, 2);

  store.dispose();
  clock += 60_000;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, 2);
});

type Claim = { append: string; render: (...args: never[]) => unknown };
type Layer = {
  mode?: string;
  priority?: number;
  commands: {
    id?: string;
    title?: string;
    group?: string;
    palette?: boolean;
    bind?: string;
    slash?: { name: string };
    run?: () => boolean | void;
  }[];
};
type SnapshotInput = {
  input: unknown;
  options: { location: { directory: string }; signal: AbortSignal };
};

function start(options: { snapshotValue?: QuotaSnapshot } = {}) {
  const claims: Claim[] = [];
  const layers: Layer[] = [];
  const dialogs: (() => unknown)[] = [];
  const sizes: string[] = [];
  const inputs: SnapshotInput[] = [];
  const unsubscribed: string[] = [];
  let definitions: unknown[] = [];
  let cleared = 0;
  const value = options.snapshotValue ?? SNAPSHOT;
  const context = {
    location: { directory: "/repo" },
    theme: {
      text: { base: "#ffffff", muted: "#888888" },
      surface: () => ({
        text: {
          base: "#ffffff",
          muted: "#888888",
          action: { primary: { focused: "#000000" } },
        },
        background: { action: { primary: { focused: "#00ffff" } } },
      }),
    },
    client: {
      rpc: (definition: unknown) => {
        definitions.push(definition);
        return {
          snapshot: async (input: unknown, rpcOptions: SnapshotInput["options"]) => {
            inputs.push({ input, options: rpcOptions });
            return value;
          },
        };
      },
    },
    keymap: {
      layer: (build: () => Layer) => {
        layers.push(build());
      },
    },
    data: {
      location: { default: () => ({ directory: "/repo" }) },
    },
    ui: {
      slot: (claim: Claim) => {
        claims.push(claim);
        return () => {
          unsubscribed.push(`slot:${claim.append}`);
        };
      },
      dialog: {
        show: (render: () => unknown) => {
          dialogs.push(render);
        },
        set: (params: { size: string }) => {
          sizes.push(params.size);
        },
        clear: () => {
          cleared += 1;
        },
      },
    },
  };
  const dispose = plugin.setup(context as never) as (() => void) | undefined;
  return {
    claims,
    layers,
    dialogs,
    sizes,
    inputs,
    unsubscribed,
    definitions,
    dispose,
    cleared: () => cleared,
  };
}

test("registers one sidebar and one native /quota command", async (t) => {
  const mounted = start();
  t.after(() => mounted.dispose?.());

  assert.equal(plugin.id, "opencode-opencodex-quota");
  assert.deepEqual(
    mounted.claims.map((claim) => claim.append),
    ["sidebar.content"],
  );

  assert.equal(mounted.layers.length, 1);
  const layer = mounted.layers[0];
  assert.equal(layer.mode, "global");
  assert.equal(layer.priority, undefined);
  assert.equal(layer.commands.length, 1);

  const command = layer.commands[0];
  assert.equal(command.id, "quota.open");
  assert.equal(command.title, "OpenCodex quota");
  assert.equal(command.group, "OpenCodex");
  assert.equal(command.palette, true);
  assert.equal(command.slash?.name, "quota");
  assert.equal(command.bind, undefined, "the command must not take a global key binding");

  await settle();
  assert.equal(mounted.inputs.length, 1, "the sidebar store starts with one passive read");
  assert.deepEqual(mounted.inputs[0].input, {});
  assert.equal(mounted.inputs[0].options.location.directory, "/repo");
  assert.ok(mounted.inputs[0].options.signal instanceof AbortSignal);
  assert.equal(mounted.definitions[0], quotaRpc);

  command.run?.();
  await settle();
  assert.equal(mounted.dialogs.length, 1);
  assert.deepEqual(mounted.sizes, ["large"]);
  assert.equal(mounted.inputs.length, 2, "opening the command asks for a fresh reading");
  assert.equal(mounted.cleared(), 0);

  mounted.dispose?.();
  assert.deepEqual(mounted.unsubscribed, ["slot:sidebar.content"]);
});

test("the command surface has no prompt, message, toast, or extra command paths", () => {
  const mounted = start();
  try {
    assert.equal(
      mounted.claims.find((claim) => claim.append === "app"),
      undefined,
      "no app surface is needed",
    );
    assert.equal(
      mounted.layers.some((layer) => layer.priority === 1),
      false,
      "no prompt interception layer",
    );
    assert.equal(
      mounted.layers.flatMap((layer) => layer.commands).length,
      1,
      "only the /quota command",
    );
  } finally {
    mounted.dispose?.();
  }
});
