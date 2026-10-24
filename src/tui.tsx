/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { ScrollBoxRenderable, TextAttributes, type RGBA } from "@opentui/core";
import { type JSX, useTerminalDimensions } from "@opentui/solid";
// The renderer loads the client Solid runtime; bare "solid-js" resolves to the
// server runtime under Node, whose signals never notify renderer effects.
import { createSignal, Show } from "solid-js/dist/solid.js";

import type {
  QuotaAccount,
  QuotaAccountState,
  QuotaProvider,
  QuotaSnapshot,
  QuotaUnit,
  QuotaWindow,
} from "./quota.js";
import { quotaRpc, type QuotaSnapshotInput } from "./rpc.js";

const REFRESH_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;
const QUOTA_DIALOG_SIZE: DialogSize = "large";
/** A reading older than this is marked stale in the sidebar and the dialog. */
export const QUOTA_STALE_AFTER_MS = 5 * 60_000;
/** The sidebar's width, and the width its quota text is laid out to. */
export const TUI_SIDEBAR_MAX_WIDTH = 36;

type DialogSize = "medium" | "large" | "xlarge";
type ThemeColor = string | RGBA;
type DialogTheme = {
  text: {
    base: ThemeColor;
    muted: ThemeColor;
    action: { primary: { focused: ThemeColor } };
  };
  background: { action: { primary: { focused: ThemeColor } } };
};
type TuiTheme = {
  text: { base: ThemeColor; muted: ThemeColor };
  surface: (name: "dialog") => DialogTheme;
};
type KeymapCommand = {
  id?: string;
  title?: string;
  group?: string;
  palette?: boolean;
  bind?: string;
  slash?: { name: string; aliases?: string[]; arguments?: true };
  run?: () => boolean | void;
};
type KeymapLayer = {
  mode?: "global" | "modal";
  priority?: number;
  commands: KeymapCommand[];
};
type TuiContext = {
  location?: { directory: string };
  client: {
    rpc: (definition: unknown) => {
      snapshot: (
        input: QuotaSnapshotInput,
        options: { location: { directory: string }; signal: AbortSignal },
      ) => Promise<QuotaSnapshot>;
    };
  };
  theme: TuiTheme;
  keymap?: { layer: (build: () => KeymapLayer) => void };
  data: {
    location?: { default: () => { directory: string } };
  };
  ui: {
    slot: (claim: {
      append: "sidebar.content";
      render: (props: { sessionID: string }) => JSX.Element;
    }) => () => void;
    dialog?: {
      show: (render: () => JSX.Element, onClose?: () => void) => void;
      clear: () => void;
      set: (options: { size: DialogSize }) => void;
    };
  };
};

export type QuotaLoader = (signal: AbortSignal) => Promise<QuotaSnapshot>;

export type QuotaStoreOptions = {
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
};

export type QuotaStore = {
  snapshot: () => QuotaSnapshot | undefined;
  failure: () => string | undefined;
  loading: () => boolean;
  lastLoadedAt: () => number | undefined;
  refresh: () => void;
  dispose: () => void;
};

export type QuotaTone = "title" | "text" | "muted" | "warning";
export type QuotaRow = { text: string; tone: QuotaTone };
export type QuotaReading = {
  snapshot?: QuotaSnapshot;
  failure?: string;
  loading: boolean;
  lastLoadedAt?: number;
  now: number;
};

function sanitize(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "");
}

/** Fits one line to a width: breaks at spaces, and hard-breaks a longer word. */
function wrapLine(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  if (text.length <= limit) return [text];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf(" ", limit);
    const end = cut > 0 ? cut : limit;
    lines.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  lines.push(rest);
  return lines;
}

function pushWrapped(rows: QuotaRow[], text: string, tone: QuotaTone, indent = 0): void {
  const clean = sanitize(text).trimEnd();
  if (!clean) {
    rows.push({ text: "", tone });
    return;
  }
  const prefix = " ".repeat(indent);
  for (const line of wrapLine(clean, TUI_SIDEBAR_MAX_WIDTH - indent)) {
    rows.push({ text: `${prefix}${line}`, tone });
  }
}

function parseInstant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function ageMs(value: string | undefined, now: number): number | undefined {
  const time = parseInstant(value);
  return time === undefined ? undefined : Math.max(0, now - time);
}

/** Compact duration: 42s, 7m, 3h, 2d. */
export function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A human age for an ISO timestamp: just now, 7m ago, 3h ago. */
export function ageLabel(value: string | undefined, now: number): string | undefined {
  return ageText(ageMs(value, now));
}

function ageText(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value < 5_000) return "just now";
  return `${formatDuration(value)} ago`;
}

function resetText(value: string | undefined, now: number): string | undefined {
  const time = parseInstant(value);
  if (time === undefined) return undefined;
  const remaining = time - now;
  if (remaining <= 5_000) return "due";
  return `in ${formatDuration(remaining)}`;
}

const DAY_MS = 86_400_000;

/**
 * Compact reset countdown. Minutes under one hour (rounded up, at least 1m),
 * hours under one day, then whole days. With `includeMinutes`, hours also show
 * their remaining minutes (4h 12m), unless they are zero (4h). A due or past
 * reset reads due.
 */
export function formatCountdown(value: number, includeMinutes = false): string {
  if (!Number.isFinite(value) || value <= 0) return "due";
  if (value < 3_600_000) {
    return `${Math.max(1, Math.ceil(value / 60_000))}m`;
  }
  if (value < DAY_MS) {
    if (includeMinutes) {
      const minutes = Math.ceil(value / 60_000);
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
    }
    return `${Math.max(1, Math.round(value / 3_600_000))}h`;
  }
  return `${Math.round(value / DAY_MS)}d`;
}

/** Countdown for a timestamp, or ?d when no timestamp exists. */
export function formatResetCountdown(
  value: string | undefined,
  now: number,
  includeMinutes = false,
): string {
  const time = parseInstant(value);
  return time === undefined ? "?d" : formatCountdown(time - now, includeMinutes);
}

function formatPercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatQuantity(value: number, unit: QuotaUnit | undefined): string {
  if (unit === "usd") return `$${value.toFixed(2)}`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function quantityWithUnit(value: number, unit: QuotaUnit | undefined): string {
  const amount = formatQuantity(value, unit);
  return unit && unit !== "usd" ? `${amount} ${unit}` : amount;
}

/** Remaining quota, or an explicit unknown. A missing percent is never shown as zero. */
export function remainingLabel(window: QuotaWindow): string {
  if (window.usedPercent !== undefined) {
    const remaining = `${formatPercent(100 - window.usedPercent)}% left`;
    return window.exhausted === true ? `${remaining}, exhausted` : remaining;
  }
  return window.exhausted === true ? "exhausted" : "remaining unknown";
}

const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";

/** The bar width used in the sidebar and the dialog. */
export const QUOTA_BAR_WIDTH = 10;

/**
 * A compact remaining-quota bar. A missing percent returns undefined, so an
 * unknown value is never drawn as an empty or zero bar.
 */
export function remainingBar(
  window: QuotaWindow,
  width = QUOTA_BAR_WIDTH,
): string | undefined {
  if (window.usedPercent === undefined) return undefined;
  const cells = Math.max(1, Math.floor(width));
  const remaining = Math.min(100, Math.max(0, 100 - window.usedPercent));
  let filled = Math.round((remaining / 100) * cells);
  if (remaining > 0 && filled === 0) filled = 1;
  if (remaining < 100 && filled === cells && cells > 1) filled = cells - 1;
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(cells - filled)}`;
}

function windowHead(window: QuotaWindow): string {
  const label = sanitize(window.label);
  const scope = window.scopeModel ? sanitize(window.scopeModel) : undefined;
  return scope ? `${label} (${scope})` : label;
}

function accountHead(account: QuotaAccount): string {
  const label = account.label ? sanitize(account.label) : "Unnamed account";
  const plan = account.plan ? sanitize(account.plan) : undefined;
  return plan ? `${label} (${plan})` : label;
}

const ACCOUNT_STATE_LABELS: Record<QuotaAccountState, string> = {
  available: "available",
  exhausted: "exhausted",
  paused: "paused",
  reauth: "sign-in required",
  unknown: "unknown",
};

function accountTone(state: QuotaAccountState): QuotaTone {
  return state === "exhausted" || state === "reauth" ? "warning" : "text";
}

function providerTitle(provider: string): string {
  return sanitize(provider.trim().toLowerCase() === "openai" ? "open-ai" : provider);
}

/** Providers that expose pooled quota only; their account rows stay hidden. */
const POOLED_ONLY_PROVIDERS = new Set(["openai"]);

function isPooledOnlyProvider(provider: QuotaProvider): boolean {
  return POOLED_ONLY_PROVIDERS.has(provider.provider.trim().toLowerCase());
}

function showsProviderAccounts(provider: QuotaProvider): boolean {
  return !isPooledOnlyProvider(provider);
}

/**
 * The earliest future reset on an available or exhausted account window for the
 * same kind, scope, and custom label. Paused, reauth, and unknown accounts are
 * skipped, because their cached dates do not make them next contributors. This
 * is a next contributing account reset, not the pool reset.
 */
function accountResetFallback(
  provider: QuotaProvider,
  window: QuotaWindow,
  now: number,
): string | undefined {
  if (!isPooledOnlyProvider(provider)) return undefined;
  const scope = window.scopeModel;
  const custom = window.kind === "custom";
  let earliest: number | undefined;
  let at: string | undefined;
  for (const account of provider.accounts) {
    if (account.state !== "available" && account.state !== "exhausted") continue;
    for (const candidate of account.windows) {
      if (candidate.kind !== window.kind) continue;
      if ((candidate.scopeModel ?? undefined) !== (scope ?? undefined)) continue;
      if (custom && sanitize(candidate.label) !== sanitize(window.label)) continue;
      const time = parseInstant(candidate.resetsAt);
      if (time === undefined || time <= now) continue;
      if (earliest === undefined || time < earliest) {
        earliest = time;
        at = candidate.resetsAt;
      }
    }
  }
  return at;
}

function sidebarReset(
  provider: QuotaProvider,
  window: QuotaWindow,
  now: number,
): string {
  const includeMinutes = window.kind === "burst_5h";
  if (parseInstant(window.resetsAt) !== undefined) {
    return formatResetCountdown(window.resetsAt, now, includeMinutes);
  }
  const fallback = accountResetFallback(provider, window, now);
  if (fallback) return formatResetCountdown(fallback, now, includeMinutes);
  return "?d";
}

function sourceLabel(source: QuotaWindow["source"]): string {
  if (source === "header") return "headers";
  return source;
}

function windowDetail(window: QuotaWindow, now: number, resetNote?: string): string {
  const parts: string[] = [];
  if (window.used !== undefined) {
    if (window.limit !== undefined && window.unit) {
      parts.push(
        `used ${formatQuantity(window.used, window.unit)} / ${quantityWithUnit(window.limit, window.unit)}`,
      );
    } else {
      parts.push(`used ${quantityWithUnit(window.used, window.unit)}`);
    }
  } else if (window.limit !== undefined && window.unit) {
    parts.push(`limit ${quantityWithUnit(window.limit, window.unit)}`);
  } else if (window.usedPercent !== undefined) {
    parts.push(`used ${formatPercent(window.usedPercent)}%`);
  }
  if (resetNote) {
    parts.push(resetNote);
  } else {
    const reset = resetText(window.resetsAt, now);
    if (reset) parts.push(`reset ${reset}`);
  }
  const observed = ageLabel(window.observedAt, now);
  if (observed) parts.push(`observed ${observed}`);
  parts.push(`source: ${sourceLabel(window.source)}`);
  return parts.join(" | ");
}

function compactRemainingLabel(window: QuotaWindow): string {
  if (window.usedPercent !== undefined) {
    const percent = `${formatPercent(100 - window.usedPercent)}%`;
    return window.exhausted === true ? `${percent} exhausted` : percent;
  }
  return window.exhausted === true ? "exhausted" : "unknown";
}

function compactWindowLine(window: QuotaWindow): string {
  const bar = remainingBar(window);
  const remaining = compactRemainingLabel(window);
  return bar
    ? `${windowHead(window)} ${bar} ${remaining}`
    : `${windowHead(window)} ${remaining}`;
}

function pushCompactWindow(
  rows: QuotaRow[],
  provider: QuotaProvider,
  window: QuotaWindow,
  now: number,
  indent: number,
): void {
  const base = compactWindowLine(window);
  const reset = sidebarReset(provider, window, now);
  const suffix = ` ${reset}`;
  if (base.length + suffix.length + indent <= TUI_SIDEBAR_MAX_WIDTH) {
    pushWrapped(rows, `${base}${suffix}`, "text", indent);
    return;
  }
  pushWrapped(rows, base, "text", indent);
  pushWrapped(rows, reset, "muted", indent);
}

function resolveReading(input: QuotaReading) {
  const snapshot = input.snapshot;
  const error = input.failure ?? snapshot?.error;
  const providers = snapshot?.providers ?? [];
  const age =
    ageMs(snapshot?.generatedAt, input.now) ??
    (input.lastLoadedAt === undefined ? undefined : Math.max(0, input.now - input.lastLoadedAt));
  return {
    snapshot,
    failure: input.failure,
    serverError: snapshot?.error,
    error,
    providers,
    age,
    stale: age !== undefined && age > QUOTA_STALE_AFTER_MS,
    loading: input.loading,
    now: input.now,
  };
}

function pushErrors(rows: QuotaRow[], reading: ReturnType<typeof resolveReading>): void {
  const seen = new Set<string>();
  if (reading.failure && !seen.has(reading.failure)) {
    seen.add(reading.failure);
    const prefix = reading.snapshot ? "Update failed" : "Unavailable";
    pushWrapped(rows, `${prefix}: ${reading.failure}`, "warning");
  }
  if (reading.serverError && !seen.has(reading.serverError)) {
    seen.add(reading.serverError);
    pushWrapped(rows, `Unavailable: ${reading.serverError}`, "warning");
  }
}

/** The sidebar's one-line status. A null status means the rows carry the state. */
export function quotaSidebarStatus(input: QuotaReading): string | undefined {
  const reading = resolveReading(input);
  if (reading.loading && !reading.snapshot) return "loading";
  if (reading.error && (!reading.snapshot || reading.providers.length === 0)) return "unavailable";
  if (reading.error) return "update failed";
  if (!reading.snapshot || reading.providers.length === 0) return undefined;
  if (reading.stale && reading.age !== undefined) return `stale ${formatDuration(reading.age)}`;
  return ageText(reading.age);
}

/** Compact sidebar rows. OpenAI keeps pooled windows only; other providers keep accounts. */
export function quotaSidebarRows(input: QuotaReading): QuotaRow[] {
  const reading = resolveReading(input);
  const rows: QuotaRow[] = [];
  if (reading.loading && !reading.snapshot) return rows;
  pushErrors(rows, reading);
  if (!reading.snapshot) {
    if (!reading.failure) rows.push({ text: "No quota reading.", tone: "muted" });
    return rows;
  }
  if (reading.providers.length === 0) {
    if (!reading.error) rows.push({ text: "No pooled quota reported.", tone: "muted" });
    return rows;
  }

  reading.providers.forEach((provider) => {
    pushWrapped(rows, providerTitle(provider.provider), "title");
    if (provider.pooled.windows.length === 0) {
      pushWrapped(rows, "No pooled windows.", "muted");
    }
    for (const window of provider.pooled.windows) {
      pushCompactWindow(rows, provider, window, reading.now, 0);
    }
    if (showsProviderAccounts(provider) && provider.accounts.length > 0) {
      pushWrapped(rows, "Accounts", "muted");
      for (const account of provider.accounts) {
        pushWrapped(
          rows,
          `${accountHead(account)}: ${ACCOUNT_STATE_LABELS[account.state]}`,
          accountTone(account.state),
          0,
        );
        if (account.windows.length === 0) {
          pushWrapped(rows, "Quota unknown.", "muted", 0);
        }
        for (const window of account.windows) {
          pushCompactWindow(rows, provider, window, reading.now, 0);
        }
      }
    }
  });
  return rows;
}

function pushWindowDetail(
  rows: QuotaRow[],
  provider: QuotaProvider,
  window: QuotaWindow,
  now: number,
  indent: number,
): void {
  const bar = remainingBar(window);
  const headline = `${windowHead(window)}: ${remainingLabel(window)}${bar ? `  ${bar}` : ""}`;
  const fallback =
    window.resetsAt === undefined ? accountResetFallback(provider, window, now) : undefined;
  const resetNote = fallback
    ? `next account reset ${formatResetCountdown(fallback, now)}`
    : undefined;
  rows.push({ text: `${" ".repeat(indent)}${headline}`, tone: "text" });
  rows.push({
    text: `${" ".repeat(indent + 2)}${windowDetail(window, now, resetNote)}`,
    tone: "muted",
  });
}

function pushProvider(rows: QuotaRow[], provider: QuotaProvider, now: number): void {
  rows.push({ text: providerTitle(provider.provider), tone: "title" });
  if (provider.pooled.windows.length === 0) {
    rows.push({ text: "  No pooled windows.", tone: "muted" });
  }
  for (const window of provider.pooled.windows) {
    pushWindowDetail(rows, provider, window, now, 2);
  }

  const poolMeta: string[] = [];
  const nextReset = resetText(provider.pooled.nextResetAt, now);
  if (nextReset) poolMeta.push(`next reset ${nextReset}`);
  if (poolMeta.length > 0) {
    rows.push({ text: `  ${poolMeta.join(" | ")}`, tone: "muted" });
  }

  if (showsProviderAccounts(provider) && provider.accounts.length > 0) {
    rows.push({ text: "Accounts", tone: "muted" });
    for (const account of provider.accounts) {
      rows.push({
        text: `  ${accountHead(account)}: ${ACCOUNT_STATE_LABELS[account.state]}`,
        tone: accountTone(account.state),
      });
      if (account.windows.length === 0) {
        rows.push({ text: "    Quota unknown.", tone: "muted" });
      }
      for (const window of account.windows) {
        pushWindowDetail(rows, provider, window, now, 4);
      }
    }
  }
}

/** The full, scrollable dialog rows. No model request is made to build them. */
export function quotaDialogRows(input: QuotaReading): QuotaRow[] {
  const reading = resolveReading(input);
  const rows: QuotaRow[] = [];
  if (reading.loading && !reading.snapshot) {
    rows.push({ text: "Loading quota…", tone: "muted" });
    return rows;
  }
  if (!reading.snapshot) {
    if (reading.failure) {
      rows.push({ text: `Unavailable: ${reading.failure}`, tone: "warning" });
    } else {
      rows.push({ text: "No quota reading yet.", tone: "muted" });
    }
    return rows;
  }
  pushErrors(rows, reading);
  if (reading.providers.length === 0) {
    if (!reading.error) rows.push({ text: "No pooled quota reported.", tone: "muted" });
    return rows;
  }
  if (reading.failure) {
    rows.push({ text: "Showing the last reading.", tone: "muted" });
  }
  reading.providers.forEach((provider, index) => {
    if (index > 0) rows.push({ text: "", tone: "text" });
    pushProvider(rows, provider, reading.now);
  });
  return rows;
}

/** The dialog subtitle: the pool's age, error state, and provider count. */
export function quotaDialogSubtitle(input: QuotaReading): string {
  const reading = resolveReading(input);
  if (reading.loading && !reading.snapshot) return "Loading cached quota";
  if (!reading.snapshot) {
    return reading.failure ? "No quota reading | unavailable" : "No quota reading";
  }
  const parts = ["Cached quota"];
  if (reading.error) parts.push("unavailable");
  if (reading.stale && reading.age !== undefined) {
    parts.push(`stale ${formatDuration(reading.age)}`);
  } else {
    const age = ageText(reading.age);
    parts.push(age ? `updated ${age}` : "update time unknown");
  }
  const count = reading.providers.length;
  if (count > 0) parts.push(`${count} provider${count === 1 ? "" : "s"}`);
  return parts.join(" | ");
}

function rpcErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Quota request timed out";
    }
    return error.message || "Quota request failed";
  }
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    const message = typeof value.message === "string" ? value.message : undefined;
    const type = typeof value.type === "string" ? value.type : undefined;
    if (message) {
      // The server answers rpc.unavailable when no server plugin registered this RPC here.
      const hint =
        type === "rpc.unavailable"
          ? " (the OpenCodex quota server plugin is not loaded for this folder)"
          : "";
      return `${message}${hint}`;
    }
  }
  return "Quota request failed";
}

/**
 * One snapshot store for the whole plugin. It polls slowly, collapses refreshes
 * that arrive during a load, keeps the last reading after a failure, and stops
 * its timer and in-flight request on disposal.
 */
export function createQuotaStore(load: QuotaLoader, options: QuotaStoreOptions = {}): QuotaStore {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? REFRESH_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? RPC_TIMEOUT_MS;
  const [snapshot, setSnapshot] = createSignal<QuotaSnapshot | undefined>(undefined);
  const [failure, setFailure] = createSignal<string | undefined>(undefined);
  const [loading, setLoading] = createSignal(true);
  const [lastLoadedAt, setLastLoadedAt] = createSignal<number | undefined>(undefined);

  let disposed = false;
  let inFlight = false;
  let queued = false;
  let active: AbortController | undefined;
  let activeTimeout: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = () => {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    setLoading(true);
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Quota request timed out", "TimeoutError")),
      requestTimeoutMs,
    );
    activeTimeout = timeout;

    let request: Promise<QuotaSnapshot>;
    try {
      request = load(controller.signal);
    } catch (error) {
      request = Promise.reject(error);
    }

    void request
      .then((value) => {
        if (disposed) return;
        const backendError =
          typeof value.error === "string" && value.error.length > 0 ? value.error : undefined;
        if (backendError) {
          // A backend-reported error is not a good reading. Keep the last good
          // snapshot, and expose the reason like a transport failure.
          setFailure(backendError);
          return;
        }
        setSnapshot(value);
        setFailure(undefined);
        setLastLoadedAt(now());
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setFailure(rpcErrorMessage(error));
      })
      .finally(() => {
        clearTimeout(timeout);
        if (activeTimeout === timeout) activeTimeout = undefined;
        if (disposed) return;
        active = undefined;
        inFlight = false;
        setLoading(false);
        if (queued) {
          queued = false;
          refresh();
        }
      });
  };

  refresh();
  timer = setInterval(refresh, Math.max(1, pollIntervalMs));

  return {
    snapshot,
    failure,
    loading,
    lastLoadedAt,
    refresh,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (activeTimeout !== undefined) clearTimeout(activeTimeout);
      activeTimeout = undefined;
      active?.abort();
    },
  };
}

function quotaRpcOptions(context: TuiContext, signal: AbortSignal) {
  const location = context.location ?? context.data.location?.default();
  return {
    location: location ?? { directory: process.cwd() },
    signal,
  };
}

function loadSnapshot(context: TuiContext, signal: AbortSignal): Promise<QuotaSnapshot> {
  const input: QuotaSnapshotInput = {};
  return context.client.rpc(quotaRpc).snapshot(input, quotaRpcOptions(context, signal));
}

function QuotaSidebar(props: { store: QuotaStore; theme: TuiTheme }): JSX.Element {
  const reading = (): QuotaReading => ({
    snapshot: props.store.snapshot(),
    failure: props.store.failure(),
    loading: props.store.loading(),
    lastLoadedAt: props.store.lastLoadedAt(),
    now: Date.now(),
  });
  const status = () => quotaSidebarStatus(reading());
  const rows = () => quotaSidebarRows(reading());

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={props.theme.text.base}>
          <b>Quota</b>
        </text>
        <Show when={status()}>
          <text fg={props.theme.text.muted}>{status()}</text>
        </Show>
      </box>
      {rows().map((row) =>
        row.tone === "title" || row.tone === "warning" ? (
          <text attributes={TextAttributes.BOLD} fg={props.theme.text.base} wrapMode="none">
            {row.text || " "}
          </text>
        ) : (
          <text
            fg={row.tone === "muted" ? props.theme.text.muted : props.theme.text.base}
            wrapMode="none"
          >
            {row.text || " "}
          </text>
        ),
      )}
    </box>
  );
}

function QuotaDialog(props: { context: TuiContext; store: QuotaStore }): JSX.Element {
  const theme = () => props.context.theme.surface("dialog");
  const dimensions = useTerminalDimensions();
  const maxHeight = () => Math.max(1, Math.floor(dimensions().height * 0.75) - 8);
  const reading = (): QuotaReading => ({
    snapshot: props.store.snapshot(),
    failure: props.store.failure(),
    loading: props.store.loading(),
    lastLoadedAt: props.store.lastLoadedAt(),
    now: Date.now(),
  });
  const close = () => props.context.ui.dialog?.clear();
  let scroll: ScrollBoxRenderable | undefined;

  props.context.keymap?.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Close", group: "Dialog", run: close },
      { bind: "up", title: "Scroll up", group: "Dialog", run: () => void scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: "Dialog", run: () => void scroll?.scrollBy(1) },
      {
        bind: "pageup",
        title: "Scroll up one page",
        group: "Dialog",
        run: () => void scroll?.scrollBy(-maxHeight()),
      },
      {
        bind: "pagedown",
        title: "Scroll down one page",
        group: "Dialog",
        run: () => void scroll?.scrollBy(maxHeight()),
      },
      { bind: "home", title: "Scroll to top", group: "Dialog", run: () => void scroll?.scrollTo(0) },
      {
        bind: "end",
        title: "Scroll to bottom",
        group: "Dialog",
        run: () => void scroll?.scrollTo(scroll.scrollHeight),
      },
    ],
  }));

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme().text.base}>
            OpenCodex quota
          </text>
          <text fg={theme().text.muted} onMouseUp={close}>
            esc
          </text>
        </box>
        <text fg={theme().text.muted}>{quotaDialogSubtitle(reading())}</text>
      </box>
      <box paddingBottom={1}>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => {
            scroll = element;
          }}
          maxHeight={maxHeight()}
        >
          <box flexDirection="column">
            {quotaDialogRows(reading()).map((row) =>
              row.tone === "title" || row.tone === "warning" ? (
                <text attributes={TextAttributes.BOLD} fg={theme().text.base} wrapMode="word">
                  {row.text || " "}
                </text>
              ) : (
                <text
                  fg={row.tone === "muted" ? theme().text.muted : theme().text.base}
                  wrapMode="word"
                >
                  {row.text || " "}
                </text>
              ),
            )}
          </box>
        </scrollbox>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme().background.action.primary.focused}
          onMouseUp={close}
        >
          <text fg={theme().text.action.primary.focused}>ok</text>
        </box>
      </box>
    </box>
  );
}

/** Opens the quota dialog for the shared store and asks for one fresh reading. */
export function showQuotaDialog(
  context: TuiContext,
  store: QuotaStore,
  size: DialogSize = QUOTA_DIALOG_SIZE,
): void {
  const dialog = context.ui.dialog;
  if (!dialog) return;
  store.refresh();
  dialog.show(() => <QuotaDialog context={context} store={store} />);
  dialog.set({ size });
}

const plugin = Plugin.define({
  id: "opencode-opencodex-quota",
  setup(context) {
    const api = context as unknown as TuiContext;
    const store = createQuotaStore((signal) => loadSnapshot(api, signal));

    api.keymap?.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "quota.open",
          title: "OpenCodex quota",
          group: "OpenCodex",
          palette: true,
          slash: { name: "quota" },
          run: () => showQuotaDialog(api, store),
        },
      ],
    }));

    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: () => <QuotaSidebar store={store} theme={api.theme} />,
    });

    return () => {
      disposeSidebar();
      store.dispose();
    };
  },
});

export default plugin;
