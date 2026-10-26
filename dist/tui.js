import { use as _$use } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
// OpenCode rewrites the bare "solid-js" specifier to the client runtime its
// renderer uses. A dist/solid.js subpath is not rewritten, which loads a second
// runtime whose components create elements without a renderer owner.
import { createSignal, onMount, Show } from "solid-js";
import { quotaRpc } from "./rpc.js";
const REFRESH_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;
/** The backend's active rebuild (10s) plus its passive reread (10s). */
const ACTIVE_REFRESH_TIMEOUT_MS = 20_000;
const QUOTA_DIALOG_SIZE = "large";
/** A reading older than this is marked stale in the sidebar and the dialog. */
export const QUOTA_STALE_AFTER_MS = 5 * 60_000;
/** The sidebar's width, and the width its quota text is laid out to. */
export const TUI_SIDEBAR_MAX_WIDTH = 36;
function sanitize(value) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "");
}

/** Fits one line to a width: breaks at spaces, and hard-breaks a longer word. */
function wrapLine(text, width) {
  const limit = Math.max(1, Math.floor(width));
  if (text.length <= limit) return [text];
  const lines = [];
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
function pushWrapped(rows, text, tone, indent = 0) {
  const clean = sanitize(text).trimEnd();
  if (!clean) {
    rows.push({
      text: "",
      tone
    });
    return;
  }
  const prefix = " ".repeat(indent);
  for (const line of wrapLine(clean, TUI_SIDEBAR_MAX_WIDTH - indent)) {
    rows.push({
      text: `${prefix}${line}`,
      tone
    });
  }
}
function parseInstant(value) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}
function ageMs(value, now) {
  const time = parseInstant(value);
  return time === undefined ? undefined : Math.max(0, now - time);
}

/** Compact duration: 42s, 7m, 3h, 2d. */
export function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A human age for an ISO timestamp: just now, 7m ago, 3h ago. */
export function ageLabel(value, now) {
  return ageText(ageMs(value, now));
}
function ageText(value) {
  if (value === undefined) return undefined;
  if (value < 5_000) return "just now";
  return `${formatDuration(value)} ago`;
}
function resetText(value, now) {
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
export function formatCountdown(value, includeMinutes = false) {
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
export function formatResetCountdown(value, now, includeMinutes = false) {
  const time = parseInstant(value);
  return time === undefined ? "?d" : formatCountdown(time - now, includeMinutes);
}
function formatPercent(value) {
  const clamped = Math.min(100, Math.max(0, value));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
function formatQuantity(value, unit) {
  if (unit === "usd") return `$${value.toFixed(2)}`;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}
function quantityWithUnit(value, unit) {
  const amount = formatQuantity(value, unit);
  return unit && unit !== "usd" ? `${amount} ${unit}` : amount;
}

/** Remaining quota, or an explicit unknown. A missing percent is never shown as zero. */
export function remainingLabel(window) {
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
export function remainingBar(window, width = QUOTA_BAR_WIDTH) {
  if (window.usedPercent === undefined) return undefined;
  const cells = Math.max(1, Math.floor(width));
  const remaining = Math.min(100, Math.max(0, 100 - window.usedPercent));
  let filled = Math.round(remaining / 100 * cells);
  if (remaining > 0 && filled === 0) filled = 1;
  if (remaining < 100 && filled === cells && cells > 1) filled = cells - 1;
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(cells - filled)}`;
}
function windowHead(window) {
  const label = sanitize(window.label);
  const scope = window.scopeModel ? sanitize(window.scopeModel) : undefined;
  return scope ? `${label} (${scope})` : label;
}
function accountHead(account) {
  const label = account.label ? sanitize(account.label) : "Unnamed account";
  const plan = account.plan ? sanitize(account.plan) : undefined;
  return plan ? `${label} (${plan})` : label;
}
const ACCOUNT_STATE_LABELS = {
  available: "available",
  exhausted: "exhausted",
  paused: "paused",
  reauth: "sign-in required",
  unknown: "unknown"
};
function accountTone(state) {
  return state === "exhausted" || state === "reauth" ? "warning" : "text";
}
function providerTitle(provider) {
  return sanitize(provider.trim().toLowerCase() === "openai" ? "open-ai" : provider);
}

/** Providers that expose pooled quota only; their account rows stay hidden. */
const POOLED_ONLY_PROVIDERS = new Set(["openai"]);
function isPooledOnlyProvider(provider) {
  return POOLED_ONLY_PROVIDERS.has(provider.provider.trim().toLowerCase());
}
function showsProviderAccounts(provider) {
  return !isPooledOnlyProvider(provider);
}

/**
 * The earliest future reset on an available or exhausted account window for the
 * same kind, scope, and custom label. Paused, reauth, and unknown accounts are
 * skipped, because their cached dates do not make them next contributors. This
 * is a next contributing account reset, not the pool reset.
 */
function accountResetFallback(provider, window, now) {
  if (!isPooledOnlyProvider(provider)) return undefined;
  const scope = window.scopeModel;
  const custom = window.kind === "custom";
  let earliest;
  let at;
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

/**
 * A window reset: its own date, or for a pooled row the next matching account
 * date. Account rows never borrow another account's reset, so an account
 * without its own date stays unknown.
 */
function sidebarReset(provider, window, now, borrowAccountReset) {
  const includeMinutes = window.kind === "burst_5h";
  if (parseInstant(window.resetsAt) !== undefined) {
    return formatResetCountdown(window.resetsAt, now, includeMinutes);
  }
  const fallback = borrowAccountReset ? accountResetFallback(provider, window, now) : undefined;
  if (fallback) return formatResetCountdown(fallback, now, includeMinutes);
  return "?d";
}
function sourceLabel(source) {
  if (source === "header") return "headers";
  return source;
}
function windowDetail(window, now, resetNote) {
  const parts = [];
  if (window.used !== undefined) {
    if (window.limit !== undefined && window.unit) {
      parts.push(`used ${formatQuantity(window.used, window.unit)} / ${quantityWithUnit(window.limit, window.unit)}`);
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
function pushSidebarLine(entries, text, tone) {
  const lines = [];
  pushWrapped(lines, text, tone);
  for (const row of lines) entries.push({
    kind: "line",
    row
  });
}
function pushCompactWindow(entries, provider, window, now, pooledRow) {
  const percent = window.usedPercent === undefined ? undefined : `${formatPercent(100 - window.usedPercent)}%`;
  entries.push({
    kind: "window",
    label: windowHead(window),
    bar: remainingBar(window),
    percent,
    state: percent === undefined ? window.exhausted === true ? "exhausted" : "unknown" : undefined,
    exhausted: window.exhausted === true,
    reset: sidebarReset(provider, window, now, pooledRow)
  });
}

/**
 * One label, bar, percentage, and reset column for every window row in the
 * sidebar, across providers and accounts. A label too long for its column wraps
 * onto its own lines, and an exhausted marker moves below rather than widening
 * the row.
 */
function renderSidebarEntries(entries) {
  const windows = entries.filter(entry => entry.kind === "window");
  const percentWidth = windows.reduce((max, entry) => Math.max(max, entry.percent?.length ?? 0), 0);
  const resetWidth = windows.reduce((max, entry) => Math.max(max, entry.reset.length), 0);
  const widestLabel = windows.reduce((max, entry) => Math.max(max, entry.label.length), 0);
  const fixed = QUOTA_BAR_WIDTH + 1 + percentWidth + 1 + resetWidth;
  const labelWidth = Math.max(1, Math.min(widestLabel, TUI_SIDEBAR_MAX_WIDTH - fixed - 1));
  const rows = [];
  for (const entry of entries) {
    if (entry.kind === "line") {
      rows.push(entry.row);
      continue;
    }
    const labels = wrapLine(entry.label, labelWidth);
    for (const line of labels.slice(0, -1)) rows.push({
      text: line,
      tone: "text"
    });
    const label = (labels[labels.length - 1] ?? "").padEnd(labelWidth);
    const tail = entry.percent === undefined ? (entry.state ?? "").padStart(QUOTA_BAR_WIDTH + 1 + percentWidth) : `${entry.bar ?? " ".repeat(QUOTA_BAR_WIDTH)} ${entry.percent.padStart(percentWidth)}`;
    const base = `${label} ${tail} ${entry.reset}`;
    const marker = entry.exhausted && entry.percent !== undefined ? " exhausted" : "";
    if (base.length + marker.length <= TUI_SIDEBAR_MAX_WIDTH) {
      rows.push({
        text: `${base}${marker}`,
        tone: "text"
      });
      continue;
    }
    rows.push({
      text: base,
      tone: "text"
    });
    if (marker) rows.push({
      text: "exhausted",
      tone: "muted"
    });
  }
  return rows;
}

/**
 * When the displayed pool was observed: the oldest pooled-window observation,
 * never fresher than the report generation that assembled it. A successful
 * fetch time is not an observation time.
 */
function observedAgeMs(snapshot, now) {
  let oldest;
  const consider = value => {
    const age = ageMs(value, now);
    if (age !== undefined && (oldest === undefined || age > oldest)) oldest = age;
  };
  consider(snapshot.generatedAt);
  for (const provider of snapshot.providers) {
    for (const window of provider.pooled.windows) consider(window.observedAt);
  }
  return oldest;
}
function resolveReading(input) {
  const snapshot = input.snapshot;
  const error = input.failure ?? snapshot?.error;
  const providers = snapshot?.providers ?? [];
  const age = snapshot === undefined ? undefined : observedAgeMs(snapshot, input.now);
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
    retained: input.retained === true
  };
}
function pushErrors(rows, reading) {
  const seen = new Set();
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
export function quotaSidebarStatus(input) {
  const reading = resolveReading(input);
  if (reading.loading && !reading.snapshot) return "loading";
  if (reading.error && (!reading.snapshot || reading.providers.length === 0)) return "unavailable";
  if (reading.error) return "update failed";
  if (!reading.snapshot || reading.providers.length === 0) return undefined;
  if (reading.stale && reading.age !== undefined) return `stale ${formatDuration(reading.age)}`;
  if (reading.age === undefined) return "observation unknown";
  return ageText(reading.age);
}

/**
 * Compact sidebar rows. OpenAI keeps pooled windows only; other providers keep
 * accounts. Missing pooled quota is never filled from account quota.
 */
export function quotaSidebarRows(input) {
  const reading = resolveReading(input);
  const rows = [];
  if (reading.loading && !reading.snapshot) return rows;
  pushErrors(rows, reading);
  if (!reading.snapshot) {
    if (!reading.failure) rows.push({
      text: "No quota reading.",
      tone: "muted"
    });
    return rows;
  }
  if (reading.providers.length === 0) {
    if (!reading.error) rows.push({
      text: "No pooled quota reported.",
      tone: "muted"
    });
    return rows;
  }
  const entries = rows.map(row => ({
    kind: "line",
    row
  }));
  if (reading.retained) {
    pushSidebarLine(entries, "Last pooled report retained.", "muted");
  }
  reading.providers.forEach(provider => {
    pushSidebarLine(entries, providerTitle(provider.provider), "title");
    if (provider.pooled.windows.length === 0) {
      pushSidebarLine(entries, "No pooled quota reported.", "muted");
    }
    for (const window of provider.pooled.windows) {
      pushCompactWindow(entries, provider, window, reading.now, true);
    }
    if (showsProviderAccounts(provider) && provider.accounts.length > 0) {
      pushSidebarLine(entries, "Accounts", "muted");
      for (const account of provider.accounts) {
        pushSidebarLine(entries, `${accountHead(account)}: ${ACCOUNT_STATE_LABELS[account.state]}`, accountTone(account.state));
        if (account.windows.length === 0) {
          pushSidebarLine(entries, "Quota unknown.", "muted");
        }
        for (const window of account.windows) {
          pushCompactWindow(entries, provider, window, reading.now, false);
        }
      }
    }
  });
  return renderSidebarEntries(entries);
}
function pushWindowDetail(rows, provider, window, now, indent, pooledRow) {
  const bar = remainingBar(window);
  const headline = `${windowHead(window)}: ${remainingLabel(window)}${bar ? `  ${bar}` : ""}`;
  const fallback = pooledRow && window.resetsAt === undefined ? accountResetFallback(provider, window, now) : undefined;
  const resetNote = fallback ? `next account reset ${formatResetCountdown(fallback, now)}` : undefined;
  rows.push({
    text: `${" ".repeat(indent)}${headline}`,
    tone: "text"
  });
  rows.push({
    text: `${" ".repeat(indent + 2)}${windowDetail(window, now, resetNote)}`,
    tone: "muted"
  });
}
function pushProvider(rows, provider, now) {
  rows.push({
    text: providerTitle(provider.provider),
    tone: "title"
  });
  if (provider.pooled.windows.length === 0) {
    rows.push({
      text: "  No pooled quota reported.",
      tone: "muted"
    });
  }
  for (const window of provider.pooled.windows) {
    pushWindowDetail(rows, provider, window, now, 2, true);
  }
  const poolMeta = [];
  const nextReset = resetText(provider.pooled.nextResetAt, now);
  if (nextReset) {
    // An empty pool's next reset is pool metadata; never read it as an account reset.
    const prefix = provider.pooled.windows.length === 0 ? "pool next reset" : "next reset";
    poolMeta.push(`${prefix} ${nextReset}`);
  }
  if (poolMeta.length > 0) {
    rows.push({
      text: `  ${poolMeta.join(" | ")}`,
      tone: "muted"
    });
  }
  if (showsProviderAccounts(provider) && provider.accounts.length > 0) {
    rows.push({
      text: "Accounts",
      tone: "muted"
    });
    for (const account of provider.accounts) {
      rows.push({
        text: `  ${accountHead(account)}: ${ACCOUNT_STATE_LABELS[account.state]}`,
        tone: accountTone(account.state)
      });
      if (account.windows.length === 0) {
        rows.push({
          text: "    Quota unknown.",
          tone: "muted"
        });
      }
      for (const window of account.windows) {
        pushWindowDetail(rows, provider, window, now, 4, false);
      }
    }
  }
}

/** The full, scrollable dialog rows. No model request is made to build them. */
export function quotaDialogRows(input) {
  const reading = resolveReading(input);
  const rows = [];
  if (reading.loading && !reading.snapshot) {
    rows.push({
      text: "Loading quota…",
      tone: "muted"
    });
    return rows;
  }
  if (!reading.snapshot) {
    if (reading.failure) {
      rows.push({
        text: `Unavailable: ${reading.failure}`,
        tone: "warning"
      });
    } else {
      rows.push({
        text: "No quota reading yet.",
        tone: "muted"
      });
    }
    return rows;
  }
  pushErrors(rows, reading);
  if (reading.providers.length === 0) {
    if (!reading.error) rows.push({
      text: "No pooled quota reported.",
      tone: "muted"
    });
    return rows;
  }
  if (reading.retained) {
    rows.push({
      text: "Last pooled report retained.",
      tone: "muted"
    });
  }
  if (reading.failure) {
    rows.push({
      text: "Showing the last reading.",
      tone: "muted"
    });
  }
  reading.providers.forEach((provider, index) => {
    if (index > 0) rows.push({
      text: "",
      tone: "text"
    });
    pushProvider(rows, provider, reading.now);
  });
  return rows;
}

/** The dialog subtitle: the pool's age, error state, and provider count. */
export function quotaDialogSubtitle(input) {
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
    parts.push(age ? `updated ${age}` : "observation unknown");
  }
  const count = reading.providers.length;
  if (count > 0) parts.push(`${count} provider${count === 1 ? "" : "s"}`);
  return parts.join(" | ");
}
function rpcErrorMessage(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Quota request timed out";
    }
    return error.message || "Quota request failed";
  }
  if (typeof error === "object" && error !== null) {
    const value = error;
    const message = typeof value.message === "string" ? value.message : undefined;
    const type = typeof value.type === "string" ? value.type : undefined;
    if (message) {
      // The server answers rpc.unavailable when no server plugin registered this RPC here.
      const hint = type === "rpc.unavailable" ? " (the OpenCodex quota server plugin is not loaded for this folder)" : "";
      return `${message}${hint}`;
    }
  }
  return "Quota request failed";
}

/**
 * Keeps the last reported pooled windows for a provider when a newer successful
 * report omits them or drops the provider. The reading is marked retained, and
 * its age comes from the older report, so a stale pool never looks fresh.
 */
export function retainPooledWindows(previous, next) {
  if (!previous || next.error) return {
    snapshot: next,
    retained: false
  };
  const prior = new Map(previous.providers.map(provider => [provider.provider, provider]));
  let retained = false;
  const providers = next.providers.map(provider => {
    const older = prior.get(provider.provider);
    if (!older || provider.pooled.windows.length > 0 || older.pooled.windows.length === 0) {
      return provider;
    }
    retained = true;
    return {
      ...provider,
      pooled: {
        ...older.pooled
      }
    };
  });
  const reported = new Set(next.providers.map(provider => provider.provider));
  for (const older of previous.providers) {
    if (reported.has(older.provider) || older.pooled.windows.length === 0) continue;
    retained = true;
    // Only pool data survives; stale account states never come back.
    providers.push({
      provider: older.provider,
      pooled: older.pooled,
      accounts: []
    });
  }
  if (!retained) return {
    snapshot: next,
    retained: false
  };
  return {
    snapshot: {
      ...next,
      providers,
      generatedAt: previous.generatedAt ?? next.generatedAt
    },
    retained: true
  };
}

/**
 * Ordering is data-only. An active request outranks every passive request that
 * started before or during its flight; the generation breaks any other tie.
 */

function orderAfter(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/**
 * One snapshot store for the whole plugin. It polls slowly, collapses refreshes
 * that arrive during a load, keeps the last reading after a failure, and stops
 * its timer and in-flight requests on disposal. Active refreshes are separate:
 * they never run on the poll, never overlap, and are dropped after their bound.
 */
export function createQuotaStore(load, options = {}) {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? REFRESH_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? RPC_TIMEOUT_MS;
  const [snapshot, setSnapshot] = createSignal(undefined);
  const [failure, setFailure] = createSignal(undefined);
  const [loading, setLoading] = createSignal(true);
  const [lastLoadedAt, setLastLoadedAt] = createSignal(undefined);
  const [retained, setRetained] = createSignal(false);
  let disposed = false;
  let inFlight = false;
  let queued = false;
  let active;
  let activeTimeout;
  let timer;

  // Each request keeps a start generation. Data and failure are ordered
  // separately: a newer failure blocks failures but never an older valid
  // success, and a newer success clears an older failure.
  let requestGeneration = 0;
  let activeGeneration;
  let dataOrder = [0, 0, 0];
  let dataGeneration = 0;
  let failureGeneration = 0;
  const acceptSuccess = (order, generation, value) => {
    const applied = orderAfter(order, dataOrder);
    if (applied) {
      dataOrder = order;
      dataGeneration = generation;
      applyReading(value);
    }
    if (generation > failureGeneration) setFailure(undefined);
    return applied;
  };
  const acceptFailure = (generation, message) => {
    if (generation <= failureGeneration || generation <= dataGeneration) return;
    failureGeneration = generation;
    setFailure(message);
  };
  const applyReading = value => {
    const merged = retainPooledWindows(snapshot(), value);
    setSnapshot(merged.snapshot);
    setRetained(merged.retained);
  };
  const refresh = () => {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    setLoading(true);
    const generation = ++requestGeneration;
    const order = [activeGeneration ?? generation, 0, generation];
    const controller = new AbortController();
    active = controller;
    // One completion per request: the deadline below settles the store even when
    // the loader ignores its abort signal, and a late result must not apply.
    let settled = false;
    const complete = apply => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeTimeout === timeout) activeTimeout = undefined;
      if (disposed) return;
      active = undefined;
      inFlight = false;
      apply();
      setLoading(false);
      if (queued) {
        queued = false;
        refresh();
      }
    };
    const timeoutError = new DOMException("Quota request timed out", "TimeoutError");
    const timeout = setTimeout(() => {
      controller.abort(timeoutError);
      // No immediate retry: a queued poll waits for the next interval, so a
      // permanently hanging loader cannot spin.
      queued = false;
      complete(() => acceptFailure(generation, rpcErrorMessage(timeoutError)));
    }, requestTimeoutMs);
    activeTimeout = timeout;
    let request;
    try {
      request = load(controller.signal);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.then(value => {
      complete(() => {
        const backendError = typeof value.error === "string" && value.error.length > 0 ? value.error : undefined;
        if (backendError) {
          // A backend-reported error is not a good reading. Keep the last good
          // snapshot, and expose the reason like a transport failure.
          acceptFailure(generation, backendError);
          return;
        }
        if (acceptSuccess(order, generation, value)) setLastLoadedAt(now());
      });
    }).catch(error => {
      complete(() => acceptFailure(generation, rpcErrorMessage(error)));
    });
  };
  const activeRefresh = options.activeRefresh;
  let activeInFlight = false;
  let activeRequest;
  let activeDeadline;
  const refreshActive = (force = false) => {
    if (disposed || activeInFlight || activeRefresh === undefined) return;
    activeInFlight = true;
    const generation = ++requestGeneration;
    activeGeneration = generation;
    const order = [generation, 1, generation];
    const controller = new AbortController();
    activeRequest = controller;
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (activeDeadline === deadline) activeDeadline = undefined;
      if (activeGeneration === generation) activeGeneration = undefined;
      if (disposed) return;
      activeRequest = undefined;
      activeInFlight = false;
    };
    const deadline = setTimeout(() => {
      const timeoutError = new DOMException("Quota refresh timed out", "TimeoutError");
      controller.abort(timeoutError);
      complete();
      if (!disposed) acceptFailure(generation, rpcErrorMessage(timeoutError));
    }, ACTIVE_REFRESH_TIMEOUT_MS);
    activeDeadline = deadline;
    let request;
    try {
      request = activeRefresh(controller.signal, force);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.then(value => {
      if (settled || disposed) return;
      complete();
      const backendError = typeof value.error === "string" && value.error.length > 0 ? value.error : undefined;
      if (backendError) {
        // An active failure keeps the displayed data and reports the reason.
        acceptFailure(generation, backendError);
        return;
      }
      acceptSuccess(order, generation, value);
    }).catch(error => {
      if (settled || disposed) return;
      complete();
      acceptFailure(generation, rpcErrorMessage(error));
    });
  };
  refresh();
  timer = setInterval(refresh, Math.max(1, pollIntervalMs));
  return {
    snapshot,
    failure,
    loading,
    lastLoadedAt,
    retained,
    refresh,
    refreshActive,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (activeTimeout !== undefined) clearTimeout(activeTimeout);
      activeTimeout = undefined;
      active?.abort();
      if (activeDeadline !== undefined) clearTimeout(activeDeadline);
      activeDeadline = undefined;
      activeRequest?.abort();
    }
  };
}
function quotaRpcOptions(context, signal) {
  const location = context.location ?? context.data.location?.default();
  return {
    location: location ?? {
      directory: process.cwd()
    },
    signal
  };
}
function loadSnapshot(context, signal) {
  const input = {};
  return context.client.rpc(quotaRpc).snapshot(input, quotaRpcOptions(context, signal));
}
function refreshSnapshot(context, signal, force = false) {
  const input = force ? {
    force: true
  } : {};
  return context.client.rpc(quotaRpc).refresh(input, quotaRpcOptions(context, signal));
}

/** A sidebar mount is a resume: ask for one active refresh, not a poll. */
export function activateOnSidebarMount(store) {
  onMount(() => store.refreshActive());
}
function QuotaSidebar(props) {
  const reading = () => ({
    snapshot: props.store.snapshot(),
    failure: props.store.failure(),
    loading: props.store.loading(),
    lastLoadedAt: props.store.lastLoadedAt(),
    now: Date.now(),
    retained: props.store.retained()
  });
  const status = () => quotaSidebarStatus(reading());
  const rows = () => quotaSidebarRows(reading());
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box"),
      _el$3 = _$createElement("text"),
      _el$4 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "gap", 1);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$4, _$createTextNode(`Quota`));
    _$insert(_el$2, _$createComponent(Show, {
      get when() {
        return status();
      },
      get children() {
        var _el$6 = _$createElement("text");
        _$insert(_el$6, status);
        _$effect(_$p => _$setProp(_el$6, "fg", props.theme.text.muted, _$p));
        return _el$6;
      }
    }), null);
    _$insert(_el$, () => rows().map(row => row.tone === "title" || row.tone === "warning" ? (() => {
      var _el$7 = _$createElement("text");
      _$setProp(_el$7, "wrapMode", "none");
      _$insert(_el$7, () => row.text || " ");
      _$effect(_p$ => {
        var _v$ = TextAttributes.BOLD,
          _v$2 = props.theme.text.base;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$7, "attributes", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$7, "fg", _v$2, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$7;
    })() : (() => {
      var _el$8 = _$createElement("text");
      _$setProp(_el$8, "wrapMode", "none");
      _$insert(_el$8, () => row.text || " ");
      _$effect(_$p => _$setProp(_el$8, "fg", row.tone === "muted" ? props.theme.text.muted : props.theme.text.base, _$p));
      return _el$8;
    })()), null);
    _$effect(_$p => _$setProp(_el$3, "fg", props.theme.text.base, _$p));
    return _el$;
  })();
}
function QuotaDialog(props) {
  const theme = () => props.context.theme.surface("dialog");
  const dimensions = useTerminalDimensions();
  const maxHeight = () => Math.max(1, Math.floor(dimensions().height * 0.75) - 8);
  const reading = () => ({
    snapshot: props.store.snapshot(),
    failure: props.store.failure(),
    loading: props.store.loading(),
    lastLoadedAt: props.store.lastLoadedAt(),
    now: Date.now(),
    retained: props.store.retained()
  });
  const close = () => props.context.ui.dialog?.clear();
  let scroll;
  props.context.keymap?.layer(() => ({
    mode: "modal",
    commands: [{
      bind: "return",
      title: "Close",
      group: "Dialog",
      run: close
    }, {
      bind: "up",
      title: "Scroll up",
      group: "Dialog",
      run: () => void scroll?.scrollBy(-1)
    }, {
      bind: "down",
      title: "Scroll down",
      group: "Dialog",
      run: () => void scroll?.scrollBy(1)
    }, {
      bind: "pageup",
      title: "Scroll up one page",
      group: "Dialog",
      run: () => void scroll?.scrollBy(-maxHeight())
    }, {
      bind: "pagedown",
      title: "Scroll down one page",
      group: "Dialog",
      run: () => void scroll?.scrollBy(maxHeight())
    }, {
      bind: "home",
      title: "Scroll to top",
      group: "Dialog",
      run: () => void scroll?.scrollTo(0)
    }, {
      bind: "end",
      title: "Scroll to bottom",
      group: "Dialog",
      run: () => void scroll?.scrollTo(scroll.scrollHeight)
    }]
  }));
  return (() => {
    var _el$9 = _$createElement("box"),
      _el$0 = _$createElement("box"),
      _el$1 = _$createElement("box"),
      _el$10 = _$createElement("text"),
      _el$12 = _$createElement("text"),
      _el$14 = _$createElement("text"),
      _el$15 = _$createElement("box"),
      _el$16 = _$createElement("scrollbox"),
      _el$17 = _$createElement("box"),
      _el$18 = _$createElement("box"),
      _el$19 = _$createElement("box"),
      _el$20 = _$createElement("text");
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$15);
    _$insertNode(_el$9, _el$18);
    _$setProp(_el$9, "paddingLeft", 2);
    _$setProp(_el$9, "paddingRight", 2);
    _$setProp(_el$9, "gap", 1);
    _$insertNode(_el$0, _el$1);
    _$insertNode(_el$0, _el$14);
    _$insertNode(_el$1, _el$10);
    _$insertNode(_el$1, _el$12);
    _$setProp(_el$1, "flexDirection", "row");
    _$setProp(_el$1, "justifyContent", "space-between");
    _$insertNode(_el$10, _$createTextNode(`OpenCodex quota`));
    _$insertNode(_el$12, _$createTextNode(`esc`));
    _$setProp(_el$12, "onMouseUp", close);
    _$insert(_el$14, () => quotaDialogSubtitle(reading()));
    _$insertNode(_el$15, _el$16);
    _$setProp(_el$15, "paddingBottom", 1);
    _$insertNode(_el$16, _el$17);
    _$use(element => {
      scroll = element;
    }, _el$16);
    _$setProp(_el$17, "flexDirection", "column");
    _$insert(_el$17, () => quotaDialogRows(reading()).map(row => row.tone === "title" || row.tone === "warning" ? (() => {
      var _el$22 = _$createElement("text");
      _$setProp(_el$22, "wrapMode", "word");
      _$insert(_el$22, () => row.text || " ");
      _$effect(_p$ => {
        var _v$0 = TextAttributes.BOLD,
          _v$1 = theme().text.base;
        _v$0 !== _p$.e && (_p$.e = _$setProp(_el$22, "attributes", _v$0, _p$.e));
        _v$1 !== _p$.t && (_p$.t = _$setProp(_el$22, "fg", _v$1, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$22;
    })() : (() => {
      var _el$23 = _$createElement("text");
      _$setProp(_el$23, "wrapMode", "word");
      _$insert(_el$23, () => row.text || " ");
      _$effect(_$p => _$setProp(_el$23, "fg", row.tone === "muted" ? theme().text.muted : theme().text.base, _$p));
      return _el$23;
    })()));
    _$insertNode(_el$18, _el$19);
    _$setProp(_el$18, "flexDirection", "row");
    _$setProp(_el$18, "justifyContent", "flex-end");
    _$setProp(_el$18, "paddingBottom", 1);
    _$insertNode(_el$19, _el$20);
    _$setProp(_el$19, "paddingLeft", 3);
    _$setProp(_el$19, "paddingRight", 3);
    _$setProp(_el$19, "onMouseUp", close);
    _$insertNode(_el$20, _$createTextNode(`ok`));
    _$effect(_p$ => {
      var _v$3 = TextAttributes.BOLD,
        _v$4 = theme().text.base,
        _v$5 = theme().text.muted,
        _v$6 = theme().text.muted,
        _v$7 = maxHeight(),
        _v$8 = theme().background.action.primary.focused,
        _v$9 = theme().text.action.primary.focused;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$10, "attributes", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$10, "fg", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$12, "fg", _v$5, _p$.a));
      _v$6 !== _p$.o && (_p$.o = _$setProp(_el$14, "fg", _v$6, _p$.o));
      _v$7 !== _p$.i && (_p$.i = _$setProp(_el$16, "maxHeight", _v$7, _p$.i));
      _v$8 !== _p$.n && (_p$.n = _$setProp(_el$19, "backgroundColor", _v$8, _p$.n));
      _v$9 !== _p$.s && (_p$.s = _$setProp(_el$20, "fg", _v$9, _p$.s));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined
    });
    return _el$9;
  })();
}

/** Opens the quota dialog for the shared store and asks for one explicit refresh. */
export function showQuotaDialog(context, store, size = QUOTA_DIALOG_SIZE) {
  const dialog = context.ui.dialog;
  if (!dialog) return;
  store.refreshActive(true);
  dialog.show(() => _$createComponent(QuotaDialog, {
    context: context,
    store: store
  }));
  dialog.set({
    size
  });
}
const plugin = Plugin.define({
  id: "opencode-opencodex-quota",
  setup(context) {
    const api = context;
    const store = createQuotaStore(signal => loadSnapshot(api, signal), {
      activeRefresh: (signal, force) => refreshSnapshot(api, signal, force)
    });
    // Startup and resume ask once for an active collection; the backend cooldown
    // and the store's single flight absorb repeats.
    store.refreshActive();
    const disposeStepEnded = api.data.on?.("session.step.ended", () => store.refreshActive());
    api.keymap?.layer(() => ({
      mode: "global",
      commands: [{
        id: "quota.open",
        title: "OpenCodex quota",
        group: "OpenCodex",
        palette: true,
        slash: {
          name: "quota"
        },
        run: () => showQuotaDialog(api, store)
      }]
    }));
    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: () => {
        activateOnSidebarMount(store);
        return _$createComponent(QuotaSidebar, {
          store: store,
          get theme() {
            return api.theme;
          }
        });
      }
    });
    return () => {
      disposeStepEnded?.();
      disposeSidebar();
      store.dispose();
    };
  }
});
export default plugin;
