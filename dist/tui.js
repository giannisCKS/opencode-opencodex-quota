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
import { createSignal, Show } from "solid-js";
import { quotaRpc } from "./rpc.js";
const REFRESH_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;
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
const BAR_FILLED = "█";
const BAR_EMPTY = "░";

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

/** Providers that expose pooled quota only; their account rows stay hidden. */
const POOLED_ONLY_PROVIDERS = new Set(["openai"]);
function showsProviderAccounts(provider) {
  return !POOLED_ONLY_PROVIDERS.has(provider.provider.trim().toLowerCase());
}
function sourceLabel(source) {
  if (source === "header") return "headers";
  return source;
}
function windowDetail(window, now) {
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
  const reset = resetText(window.resetsAt, now);
  if (reset) parts.push(`reset ${reset}`);
  const observed = ageLabel(window.observedAt, now);
  if (observed) parts.push(`observed ${observed}`);
  parts.push(`source: ${sourceLabel(window.source)}`);
  return parts.join(" | ");
}
function sidebarWindowLine(window, now) {
  const parts = [remainingLabel(window)];
  const reset = resetText(window.resetsAt, now);
  if (reset) parts.push(`reset ${reset}`);
  return `${windowHead(window)}: ${parts.join(", ")}`;
}
function pushSidebarWindow(rows, window, now, indent) {
  pushWrapped(rows, sidebarWindowLine(window, now), "text", indent);
  const bar = remainingBar(window);
  if (bar) pushWrapped(rows, bar, "text", indent);
}
function resolveReading(input) {
  const snapshot = input.snapshot;
  const error = input.failure ?? snapshot?.error;
  const providers = snapshot?.providers ?? [];
  const age = ageMs(snapshot?.generatedAt, input.now) ?? (input.lastLoadedAt === undefined ? undefined : Math.max(0, input.now - input.lastLoadedAt));
  return {
    snapshot,
    failure: input.failure,
    serverError: snapshot?.error,
    error,
    providers,
    age,
    stale: age !== undefined && age > QUOTA_STALE_AFTER_MS,
    loading: input.loading,
    now: input.now
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
  return ageText(reading.age);
}

/** Compact sidebar rows. OpenAI keeps pooled windows only; other providers keep accounts. */
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
  reading.providers.forEach((provider, index) => {
    if (index > 0) rows.push({
      text: "",
      tone: "text"
    });
    pushWrapped(rows, provider.provider, "title");
    pushWrapped(rows, "Pooled", "muted", 2);
    if (provider.pooled.windows.length === 0) {
      pushWrapped(rows, "No pooled windows.", "muted", 4);
    }
    for (const window of provider.pooled.windows) {
      pushSidebarWindow(rows, window, reading.now, 4);
    }
    if (showsProviderAccounts(provider) && provider.accounts.length > 0) {
      pushWrapped(rows, "Accounts", "muted", 2);
      for (const account of provider.accounts) {
        pushWrapped(rows, `${accountHead(account)}: ${ACCOUNT_STATE_LABELS[account.state]}`, accountTone(account.state), 4);
        if (account.windows.length === 0) {
          pushWrapped(rows, "Quota unknown.", "muted", 6);
        }
        for (const window of account.windows) {
          pushSidebarWindow(rows, window, reading.now, 6);
        }
      }
    }
  });
  return rows;
}
function pushWindowDetail(rows, window, now, indent) {
  const bar = remainingBar(window);
  const headline = `${windowHead(window)}: ${remainingLabel(window)}${bar ? `  ${bar}` : ""}`;
  rows.push({
    text: `${" ".repeat(indent)}${headline}`,
    tone: "text"
  });
  rows.push({
    text: `${" ".repeat(indent + 2)}${windowDetail(window, now)}`,
    tone: "muted"
  });
}
function pushProvider(rows, provider, now) {
  rows.push({
    text: sanitize(provider.provider),
    tone: "title"
  });
  rows.push({
    text: "Pooled",
    tone: "muted"
  });
  if (provider.pooled.windows.length === 0) {
    rows.push({
      text: "  No pooled windows.",
      tone: "muted"
    });
  }
  for (const window of provider.pooled.windows) {
    pushWindowDetail(rows, window, now, 2);
  }
  const poolMeta = [];
  const nextReset = resetText(provider.pooled.nextResetAt, now);
  if (nextReset) poolMeta.push(`next reset ${nextReset}`);
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
        pushWindowDetail(rows, window, now, 4);
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
    parts.push(age ? `updated ${age}` : "update time unknown");
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
 * One snapshot store for the whole plugin. It polls slowly, collapses refreshes
 * that arrive during a load, keeps the last reading after a failure, and stops
 * its timer and in-flight request on disposal.
 */
export function createQuotaStore(load, options = {}) {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? REFRESH_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? RPC_TIMEOUT_MS;
  const [snapshot, setSnapshot] = createSignal(undefined);
  const [failure, setFailure] = createSignal(undefined);
  const [loading, setLoading] = createSignal(true);
  const [lastLoadedAt, setLastLoadedAt] = createSignal(undefined);
  let disposed = false;
  let inFlight = false;
  let queued = false;
  let active;
  let activeTimeout;
  let timer;
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
    const timeout = setTimeout(() => controller.abort(new DOMException("Quota request timed out", "TimeoutError")), requestTimeoutMs);
    activeTimeout = timeout;
    let request;
    try {
      request = load(controller.signal);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.then(value => {
      if (disposed) return;
      const backendError = typeof value.error === "string" && value.error.length > 0 ? value.error : undefined;
      if (backendError) {
        // A backend-reported error is not a good reading. Keep the last good
        // snapshot, and expose the reason like a transport failure.
        setFailure(backendError);
        return;
      }
      setSnapshot(value);
      setFailure(undefined);
      setLastLoadedAt(now());
    }).catch(error => {
      if (disposed) return;
      setFailure(rpcErrorMessage(error));
    }).finally(() => {
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
function QuotaSidebar(props) {
  const reading = () => ({
    snapshot: props.store.snapshot(),
    failure: props.store.failure(),
    loading: props.store.loading(),
    lastLoadedAt: props.store.lastLoadedAt(),
    now: Date.now()
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
    now: Date.now()
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

/** Opens the quota dialog for the shared store and asks for one fresh reading. */
export function showQuotaDialog(context, store, size = QUOTA_DIALOG_SIZE) {
  const dialog = context.ui.dialog;
  if (!dialog) return;
  store.refresh();
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
    const store = createQuotaStore(signal => loadSnapshot(api, signal));
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
      render: () => _$createComponent(QuotaSidebar, {
        store: store,
        get theme() {
          return api.theme;
        }
      })
    });
    return () => {
      disposeSidebar();
      store.dispose();
    };
  }
});
export default plugin;
