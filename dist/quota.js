/**
 * OpenCodex quota-pool reading.
 *
 * Passive reads use the pinned `ocx.quota-pool/1` contract from the local
 * OpenCodex management API (`GET /api/quota-pool`). The admin token is used as
 * a bearer token and is never logged or returned.
 *
 * `refreshQuota` is the only active path: it asks OpenCodex to rebuild provider
 * reports (`GET /api/provider-quotas?refresh=1`) and then rereads the passive
 * pool. Active attempts are throttled and shared process-wide; an explicit
 * request may bypass the throttle but still shares an in-flight attempt. No
 * other endpoint is used, and no quota reading is invented locally.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
/** Fixed local OpenCodex quota-pool endpoint. Never configurable by callers. */
export const OPENCODEX_QUOTA_ENDPOINT = "http://127.0.0.1:10100/api/quota-pool";
/** Fixed local OpenCodex provider-report rebuild endpoint. Never configurable. */
export const OPENCODEX_REFRESH_ENDPOINT = "http://127.0.0.1:10100/api/provider-quotas?refresh=1";
/** Minimum gap between active refresh attempts, successful or failed. */
export const OPENCODEX_REFRESH_COOLDOWN_MS = 5 * 60_000;
/** Request timeout for the local management calls. */
export const OPENCODEX_QUOTA_TIMEOUT_MS = 10_000;
/** Hard cap on the response body, to stay bounded on an untrusted local service. */
const MAX_RESPONSE_BYTES = 1_000_000;
/** The pinned upstream wire schema. */
const QUOTA_POOL_SCHEMA = "ocx.quota-pool/1";
/** C0/C1 controls plus the Unicode line separators, stripped from display labels. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Expand a leading `~` or `~/` in a user-supplied path. */
function expandHomePath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return join(homedir(), value.slice(2));
    return value;
}
/**
 * Resolves the OpenCodex admin token: environment first, then the configured
 * token file, then the OpenCodex home default. The value is returned only to be
 * sent as a bearer token and is never logged or stored.
 */
export async function resolveAdminToken() {
    const fromEnv = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim();
    if (fromEnv)
        return fromEnv;
    const configuredTokenFile = process.env.OPENCODEX_ADMIN_TOKEN_FILE?.trim();
    const configuredHome = process.env.OPENCODEX_HOME?.trim();
    const tokenFile = configuredTokenFile
        ? expandHomePath(configuredTokenFile)
        : join(expandHomePath(configuredHome || "~/.opencodex"), "admin-api-token");
    try {
        const fromFile = (await readFile(tokenFile, "utf8")).trim();
        return fromFile || undefined;
    }
    catch {
        return undefined;
    }
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isoString(value) {
    if (typeof value !== "string")
        return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function oneOf(value, allowed) {
    return typeof value === "string" && allowed.includes(value)
        ? value
        : undefined;
}
/**
 * Normalize an untrusted label before it reaches the TUI. Control characters
 * (newlines included) become spaces so a label cannot break a row, and runs of
 * whitespace collapse to one space.
 */
export function normalizeLabel(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : undefined;
}
async function readBoundedBody(response) {
    if (!response.body)
        throw new Error("missing response body");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
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
const WINDOW_KINDS = [
    "burst_5h",
    "daily",
    "weekly",
    "monthly",
    "credits",
    "custom",
];
const QUOTA_SOURCES = ["measured", "header", "estimated"];
const QUOTA_UNITS = ["requests", "tokens", "credits", "usd"];
const ACCOUNT_STATES = [
    "available",
    "exhausted",
    "paused",
    "reauth",
    "unknown",
];
const QUOTA_ROLES = ["standalone", "hub", "client"];
function parseWindow(value) {
    const window = record(value);
    if (!window)
        return null;
    // Required by the pinned contract. `id` is validated but not exposed.
    if (typeof window.id !== "string" || window.id.length === 0)
        return null;
    const kind = oneOf(window.kind, WINDOW_KINDS);
    const label = normalizeLabel(window.label);
    const source = oneOf(window.source, QUOTA_SOURCES);
    const observedAt = isoString(window.observedAt);
    if (!kind || !label || !source || !observedAt)
        return null;
    const usedPercent = finiteNumber(window.usedPercent);
    if (window.usedPercent !== undefined &&
        (usedPercent === undefined || usedPercent < 0 || usedPercent > 100)) {
        return null;
    }
    const used = finiteNumber(window.used);
    if (window.used !== undefined && (used === undefined || used < 0))
        return null;
    const limit = finiteNumber(window.limit);
    if (window.limit !== undefined && (limit === undefined || limit < 0))
        return null;
    const unit = oneOf(window.unit, QUOTA_UNITS);
    if (window.unit !== undefined && !unit)
        return null;
    const resetsAt = isoString(window.resetsAt);
    if (window.resetsAt !== undefined && !resetsAt)
        return null;
    const windowSeconds = finiteNumber(window.windowSeconds);
    if (window.windowSeconds !== undefined &&
        (windowSeconds === undefined || windowSeconds < 0)) {
        return null;
    }
    const scopeModel = normalizeLabel(window.scopeModel);
    if (window.scopeModel !== undefined && !scopeModel)
        return null;
    if (window.exhausted !== undefined && typeof window.exhausted !== "boolean")
        return null;
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
function parseWindows(value) {
    if (!Array.isArray(value))
        return null;
    const windows = [];
    for (const item of value) {
        const window = parseWindow(item);
        if (!window)
            return null;
        windows.push(window);
    }
    return windows;
}
function parseAccount(value) {
    const account = record(value);
    if (!account)
        return null;
    // Required by the pinned contract; the opaque reference is not exposed.
    if (typeof account.accountRef !== "string" || account.accountRef.length === 0)
        return null;
    if (typeof account.provider !== "string" || account.provider.length === 0)
        return null;
    const state = oneOf(account.state, ACCOUNT_STATES);
    const windows = parseWindows(account.windows);
    if (!state || !windows)
        return null;
    const label = normalizeLabel(account.label);
    if (account.label !== undefined && !label)
        return null;
    const plan = normalizeLabel(account.plan);
    if (account.plan !== undefined && !plan)
        return null;
    if (account.failure !== undefined && typeof account.failure !== "string")
        return null;
    return {
        ...(label ? { label } : {}),
        ...(plan ? { plan } : {}),
        state,
        windows,
    };
}
function parseProvider(value) {
    const provider = record(value);
    if (!provider)
        return null;
    const name = normalizeLabel(provider.provider);
    const pooled = record(provider.pooled);
    if (!name || !pooled)
        return null;
    const windows = parseWindows(pooled.windows);
    if (!windows)
        return null;
    const headroom = finiteNumber(pooled.headroom);
    if (pooled.headroom !== undefined && (headroom === undefined || headroom < 0))
        return null;
    const nextResetAt = isoString(pooled.nextResetAt);
    if (pooled.nextResetAt !== undefined && !nextResetAt)
        return null;
    const accounts = [];
    if (!Array.isArray(provider.accounts))
        return null;
    for (const item of provider.accounts) {
        const account = parseAccount(item);
        if (!account)
            return null;
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
export function parseQuotaPool(payload) {
    const pool = record(payload);
    if (!pool)
        return { providers: [], error: "Invalid quota pool response" };
    if (pool.schema !== QUOTA_POOL_SCHEMA) {
        return { providers: [], error: "Unsupported quota pool schema" };
    }
    const producer = record(pool.producer);
    if (!producer ||
        typeof producer.version !== "string" ||
        producer.version.length === 0 ||
        typeof producer.homeId !== "string" ||
        producer.homeId.length === 0 ||
        !oneOf(producer.role, QUOTA_ROLES)) {
        return { providers: [], error: "Invalid quota pool response" };
    }
    const generatedAt = isoString(pool.generatedAt);
    if (!generatedAt)
        return { providers: [], error: "Invalid quota pool response" };
    if (!Array.isArray(pool.providers)) {
        return { providers: [], error: "Invalid quota pool response" };
    }
    const providers = [];
    for (const item of pool.providers) {
        const provider = parseProvider(item);
        if (!provider)
            return { providers: [], error: "Invalid quota pool response" };
        providers.push(provider);
    }
    return { providers, generatedAt };
}
function fetchFailure(error) {
    if (error instanceof Error && error.name === "TimeoutError") {
        return { providers: [], error: "Local quota service timed out" };
    }
    // Network failures are not surfaced: their text can carry local paths or tokens.
    return { providers: [], error: "Local quota service unavailable" };
}
/** Release an unread response body without letting cancellation failures escape. */
async function cancelBody(response) {
    try {
        await response.body?.cancel();
    }
    catch {
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
export async function fetchQuota() {
    const token = await resolveAdminToken();
    const snapshot = await requestQuota(token);
    return {
        ...snapshot,
        diagnostics: { endpoint: OPENCODEX_QUOTA_ENDPOINT, tokenConfigured: Boolean(token) },
    };
}
/** The request itself, with the token already resolved. */
async function requestQuota(token) {
    if (!token) {
        return {
            providers: [],
            error: "No OpenCodex admin token: set OPENCODEX_ADMIN_AUTH_TOKEN or ~/.opencodex/admin-api-token",
        };
    }
    let response;
    try {
        response = await fetch(OPENCODEX_QUOTA_ENDPOINT, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(OPENCODEX_QUOTA_TIMEOUT_MS),
        });
    }
    catch (error) {
        return fetchFailure(error);
    }
    if (!response.ok) {
        await cancelBody(response);
        return { providers: [], error: `Local quota service returned HTTP ${response.status}` };
    }
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
    if (contentLength !== undefined &&
        Number.isFinite(contentLength) &&
        contentLength > MAX_RESPONSE_BYTES) {
        await cancelBody(response);
        return { providers: [], error: "Local quota response exceeds size limit" };
    }
    let body;
    try {
        body = await readBoundedBody(response);
    }
    catch (error) {
        if (error instanceof Error && error.message === "response size limit exceeded") {
            return { providers: [], error: "Local quota response exceeds size limit" };
        }
        return { providers: [], error: "Local quota service unavailable" };
    }
    let payload;
    try {
        payload = JSON.parse(body);
    }
    catch {
        return { providers: [], error: "Local quota service returned invalid JSON" };
    }
    return parseQuotaPool(payload);
}
/**
 * The last active attempt, success or failure, and the attempt currently in
 * flight. Both live at module scope so every plugin instance in this process
 * shares one cooldown and one request.
 */
let lastRefreshAttemptAt = 0;
let refreshInFlight;
/**
 * Ask OpenCodex to rebuild provider reports. The response is never parsed or
 * logged: only its status matters. The body is always cancelled unread.
 * Returns a safe failure body, or null on a successful request.
 */
async function requestRefresh(token) {
    let response;
    try {
        response = await fetch(OPENCODEX_REFRESH_ENDPOINT, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(OPENCODEX_QUOTA_TIMEOUT_MS),
        });
    }
    catch (error) {
        return fetchFailure(error);
    }
    await cancelBody(response);
    if (!response.ok) {
        return { providers: [], error: `Local quota service returned HTTP ${response.status}` };
    }
    return null;
}
/** One active attempt followed by a passive read on success. */
async function performRefresh() {
    const token = await resolveAdminToken();
    // Without a token there is nothing to authorize: no request, no cooldown.
    if (!token)
        return fetchQuota();
    // Set before the request so a failure also holds the cooldown.
    lastRefreshAttemptAt = Date.now();
    const failure = await requestRefresh(token);
    if (failure) {
        return {
            ...failure,
            diagnostics: { endpoint: OPENCODEX_QUOTA_ENDPOINT, tokenConfigured: true },
        };
    }
    return fetchQuota();
}
/**
 * Actively rebuild OpenCodex provider reports, then reread the passive pool.
 *
 * At most one active attempt runs at a time, and attempts are spaced by
 * `OPENCODEX_REFRESH_COOLDOWN_MS` process-wide. A call while the cooldown holds
 * returns the passive snapshot instead, so failures cannot cause a retry storm.
 * `force` is reserved for an explicit user request: it bypasses the cooldown,
 * still joins any attempt already in flight, and restarts the cooldown.
 * Never throws; active failures stay safe and redacted.
 */
export async function refreshQuota(options = {}) {
    if (refreshInFlight)
        return refreshInFlight;
    const force = options.force === true;
    if (!force && Date.now() - lastRefreshAttemptAt < OPENCODEX_REFRESH_COOLDOWN_MS) {
        return fetchQuota();
    }
    refreshInFlight = performRefresh();
    try {
        return await refreshInFlight;
    }
    finally {
        refreshInFlight = undefined;
    }
}
//# sourceMappingURL=quota.js.map