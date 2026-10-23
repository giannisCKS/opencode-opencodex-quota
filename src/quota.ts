/**
 * Passive OpenCodex quota-pool reading.
 *
 * Reads the pinned `ocx.quota-pool/1` contract from the local OpenCodex
 * management API (`GET /api/quota-pool`). The admin token is used as a bearer
 * token and is never logged or returned. This module never triggers a refresh,
 * never falls back to another endpoint, and never invents a quota reading.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Fixed local OpenCodex quota-pool endpoint. Never configurable by callers. */
export const OPENCODEX_QUOTA_ENDPOINT = "http://127.0.0.1:10100/api/quota-pool";

/** Request timeout for the local management call. */
export const OPENCODEX_QUOTA_TIMEOUT_MS = 10_000;

/** Hard cap on the response body, to stay bounded on an untrusted local service. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** The pinned upstream wire schema. */
const QUOTA_POOL_SCHEMA = "ocx.quota-pool/1";

/** C0/C1 controls plus the Unicode line separators, stripped from display labels. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export type QuotaWindowKind =
  | "burst_5h"
  | "daily"
  | "weekly"
  | "monthly"
  | "credits"
  | "custom";

/** How the reading was obtained upstream: probe body, rate-limit headers, or estimate. */
export type QuotaSource = "measured" | "header" | "estimated";

export type QuotaUnit = "requests" | "tokens" | "credits" | "usd";

export type QuotaAccountState = "available" | "exhausted" | "paused" | "reauth" | "unknown";

/**
 * One quota window, normalized for display. Optional fields are present only when
 * OpenCodex reported them; a missing `usedPercent` means unknown, never 0%.
 */
export type QuotaWindow = {
  kind: QuotaWindowKind;
  label: string;
  usedPercent?: number;
  used?: number;
  limit?: number;
  unit?: QuotaUnit;
  resetsAt?: string;
  windowSeconds?: number;
  /** Exact model this window applies to, when the window is model-scoped. */
  scopeModel?: string;
  source: QuotaSource;
  /** When this window reading was observed upstream, as an ISO timestamp. */
  observedAt: string;
  exhausted?: boolean;
};

/** One account inside a provider pool. Opaque upstream identifiers are omitted. */
export type QuotaAccount = {
  label?: string;
  plan?: string;
  state: QuotaAccountState;
  windows: QuotaWindow[];
};

/** One provider and its pooled windows plus accounts. */
export type QuotaProvider = {
  provider: string;
  pooled: {
    windows: QuotaWindow[];
    headroom?: number;
    nextResetAt?: string;
  };
  accounts: QuotaAccount[];
};

/**
 * A normalized reading for the sidebar and dialog. `providers` is empty on
 * failure. `error` is a safe, redacted message; `diagnostics` never carries the
 * token.
 */
export type QuotaSnapshot = {
  providers: QuotaProvider[];
  /** When OpenCodex assembled the pool, as an ISO timestamp. */
  generatedAt?: string;
  error?: string;
  diagnostics: QuotaDiagnostics;
};

/** Where the reading came from and whether a token was found. Never the token. */
export type QuotaDiagnostics = {
  endpoint: string;
  tokenConfigured: boolean;
};

/** Expand a leading `~` or `~/` in a user-supplied path. */
function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolves the OpenCodex admin token: environment first, then the configured
 * token file, then the OpenCodex home default. The value is returned only to be
 * sent as a bearer token and is never logged or stored.
 */
export async function resolveAdminToken(): Promise<string | undefined> {
  const fromEnv = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const configuredTokenFile = process.env.OPENCODEX_ADMIN_TOKEN_FILE?.trim();
  const configuredHome = process.env.OPENCODEX_HOME?.trim();
  const tokenFile = configuredTokenFile
    ? expandHomePath(configuredTokenFile)
    : join(expandHomePath(configuredHome || "~/.opencodex"), "admin-api-token");
  try {
    const fromFile = (await readFile(tokenFile, "utf8")).trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}

type SnapshotBody = Omit<QuotaSnapshot, "diagnostics">;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Normalize an untrusted label before it reaches the TUI. Control characters
 * (newlines included) become spaces so a label cannot break a row, and runs of
 * whitespace collapse to one space.
 */
export function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response size limit exceeded");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const WINDOW_KINDS: readonly QuotaWindowKind[] = [
  "burst_5h",
  "daily",
  "weekly",
  "monthly",
  "credits",
  "custom",
];
const QUOTA_SOURCES: readonly QuotaSource[] = ["measured", "header", "estimated"];
const QUOTA_UNITS: readonly QuotaUnit[] = ["requests", "tokens", "credits", "usd"];
const ACCOUNT_STATES: readonly QuotaAccountState[] = [
  "available",
  "exhausted",
  "paused",
  "reauth",
  "unknown",
];
const QUOTA_ROLES = ["standalone", "hub", "client"] as const;

function parseWindow(value: unknown): QuotaWindow | null {
  const window = record(value);
  if (!window) return null;

  // Required by the pinned contract. `id` is validated but not exposed.
  if (typeof window.id !== "string" || window.id.length === 0) return null;
  const kind = oneOf(window.kind, WINDOW_KINDS);
  const label = normalizeLabel(window.label);
  const source = oneOf(window.source, QUOTA_SOURCES);
  const observedAt = isoString(window.observedAt);
  if (!kind || !label || !source || !observedAt) return null;

  const usedPercent = finiteNumber(window.usedPercent);
  if (
    window.usedPercent !== undefined &&
    (usedPercent === undefined || usedPercent < 0 || usedPercent > 100)
  ) {
    return null;
  }
  const used = finiteNumber(window.used);
  if (window.used !== undefined && (used === undefined || used < 0)) return null;
  const limit = finiteNumber(window.limit);
  if (window.limit !== undefined && (limit === undefined || limit < 0)) return null;
  const unit = oneOf(window.unit, QUOTA_UNITS);
  if (window.unit !== undefined && !unit) return null;
  const resetsAt = isoString(window.resetsAt);
  if (window.resetsAt !== undefined && !resetsAt) return null;
  const windowSeconds = finiteNumber(window.windowSeconds);
  if (
    window.windowSeconds !== undefined &&
    (windowSeconds === undefined || windowSeconds < 0)
  ) {
    return null;
  }
  const scopeModel = normalizeLabel(window.scopeModel);
  if (window.scopeModel !== undefined && !scopeModel) return null;
  if (window.exhausted !== undefined && typeof window.exhausted !== "boolean") return null;

  return {
    kind,
    label,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(unit ? { unit } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(scopeModel ? { scopeModel } : {}),
    source,
    observedAt,
    ...(window.exhausted !== undefined ? { exhausted: window.exhausted } : {}),
  };
}

function parseWindows(value: unknown): QuotaWindow[] | null {
  if (!Array.isArray(value)) return null;
  const windows: QuotaWindow[] = [];
  for (const item of value) {
    const window = parseWindow(item);
    if (!window) return null;
    windows.push(window);
  }
  return windows;
}

function parseAccount(value: unknown): QuotaAccount | null {
  const account = record(value);
  if (!account) return null;
  // Required by the pinned contract; the opaque reference is not exposed.
  if (typeof account.accountRef !== "string" || account.accountRef.length === 0) return null;
  if (typeof account.provider !== "string" || account.provider.length === 0) return null;
  const state = oneOf(account.state, ACCOUNT_STATES);
  const windows = parseWindows(account.windows);
  if (!state || !windows) return null;

  const label = normalizeLabel(account.label);
  if (account.label !== undefined && !label) return null;
  const plan = normalizeLabel(account.plan);
  if (account.plan !== undefined && !plan) return null;
  if (account.failure !== undefined && typeof account.failure !== "string") return null;

  return {
    ...(label ? { label } : {}),
    ...(plan ? { plan } : {}),
    state,
    windows,
  };
}

function parseProvider(value: unknown): QuotaProvider | null {
  const provider = record(value);
  if (!provider) return null;
  const name = normalizeLabel(provider.provider);
  const pooled = record(provider.pooled);
  if (!name || !pooled) return null;
  const windows = parseWindows(pooled.windows);
  if (!windows) return null;

  const headroom = finiteNumber(pooled.headroom);
  if (pooled.headroom !== undefined && (headroom === undefined || headroom < 0)) return null;
  const nextResetAt = isoString(pooled.nextResetAt);
  if (pooled.nextResetAt !== undefined && !nextResetAt) return null;

  const accounts: QuotaAccount[] = [];
  if (!Array.isArray(provider.accounts)) return null;
  for (const item of provider.accounts) {
    const account = parseAccount(item);
    if (!account) return null;
    accounts.push(account);
  }

  return {
    provider: name,
    pooled: {
      windows,
      ...(headroom !== undefined ? { headroom } : {}),
      ...(nextResetAt ? { nextResetAt } : {}),
    },
    accounts,
  };
}

/**
 * Validate the pinned `ocx.quota-pool/1` payload and project it to the display
 * shape. Rejects an incompatible or malformed payload instead of showing an
 * empty pool that would imply zero quota.
 */
export function parseQuotaPool(payload: unknown): SnapshotBody {
  const pool = record(payload);
  if (!pool) return { providers: [], error: "Invalid quota pool response" };
  if (pool.schema !== QUOTA_POOL_SCHEMA) {
    return { providers: [], error: "Unsupported quota pool schema" };
  }

  const producer = record(pool.producer);
  if (
    !producer ||
    typeof producer.version !== "string" ||
    producer.version.length === 0 ||
    typeof producer.homeId !== "string" ||
    producer.homeId.length === 0 ||
    !oneOf(producer.role, QUOTA_ROLES)
  ) {
    return { providers: [], error: "Invalid quota pool response" };
  }

  const generatedAt = isoString(pool.generatedAt);
  if (!generatedAt) return { providers: [], error: "Invalid quota pool response" };
  if (!Array.isArray(pool.providers)) {
    return { providers: [], error: "Invalid quota pool response" };
  }

  const providers: QuotaProvider[] = [];
  for (const item of pool.providers) {
    const provider = parseProvider(item);
    if (!provider) return { providers: [], error: "Invalid quota pool response" };
    providers.push(provider);
  }

  return { providers, generatedAt };
}

function fetchFailure(error: unknown): SnapshotBody {
  if (error instanceof Error && error.name === "TimeoutError") {
    return { providers: [], error: "Local quota service timed out" };
  }
  // Network failures are not surfaced: their text can carry local paths or tokens.
  return { providers: [], error: "Local quota service unavailable" };
}

/** Release an unread response body without letting cancellation failures escape. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The caller still returns the fixed safe error; cancellation is best effort.
  }
}

/**
 * Fetches the passive OpenCodex quota pool from the fixed local endpoint.
 *
 * Never throws. Redirects are rejected and all untrusted fields are validated,
 * so a malformed or hostile local response produces a safe `error` string. The
 * token is read once per call and attached only as a boolean in `diagnostics`.
 */
export async function fetchQuota(): Promise<QuotaSnapshot> {
  const token = await resolveAdminToken();
  const snapshot = await requestQuota(token);
  return {
    ...snapshot,
    diagnostics: { endpoint: OPENCODEX_QUOTA_ENDPOINT, tokenConfigured: Boolean(token) },
  };
}

/** The request itself, with the token already resolved. */
async function requestQuota(token: string | undefined): Promise<SnapshotBody> {
  if (!token) {
    return {
      providers: [],
      error:
        "No OpenCodex admin token: set OPENCODEX_ADMIN_AUTH_TOKEN or ~/.opencodex/admin-api-token",
    };
  }

  let response: Response;
  try {
    response = await fetch(OPENCODEX_QUOTA_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(OPENCODEX_QUOTA_TIMEOUT_MS),
    });
  } catch (error) {
    return fetchFailure(error);
  }

  if (!response.ok) {
    await cancelBody(response);
    return { providers: [], error: `Local quota service returned HTTP ${response.status}` };
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_RESPONSE_BYTES
  ) {
    await cancelBody(response);
    return { providers: [], error: "Local quota response exceeds size limit" };
  }

  let body: string;
  try {
    body = await readBoundedBody(response);
  } catch (error) {
    if (error instanceof Error && error.message === "response size limit exceeded") {
      return { providers: [], error: "Local quota response exceeds size limit" };
    }
    return { providers: [], error: "Local quota service unavailable" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return { providers: [], error: "Local quota service returned invalid JSON" };
  }
  return parseQuotaPool(payload);
}
