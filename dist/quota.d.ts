/** Legacy local OpenCodex quota-pool endpoint, also used in diagnostics. */
export declare const OPENCODEX_QUOTA_ENDPOINT = "http://127.0.0.1:10100/api/quota-pool";
/** Legacy local OpenCodex provider-report rebuild endpoint. */
export declare const OPENCODEX_REFRESH_ENDPOINT = "http://127.0.0.1:10100/api/provider-quotas?refresh=1";
/** Minimum gap between active refresh attempts, successful or failed. */
export declare const OPENCODEX_REFRESH_COOLDOWN_MS: number;
/** Request timeout for the local management calls. */
export declare const OPENCODEX_QUOTA_TIMEOUT_MS = 10000;
export type QuotaWindowKind = "burst_5h" | "daily" | "weekly" | "monthly" | "credits" | "custom";
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
/**
 * Resolves the OpenCodex admin token: environment first, then the configured
 * token file, then the OpenCodex home default. The value is returned only to be
 * sent as a bearer token and is never logged or stored.
 */
export declare function resolveAdminToken(): Promise<string | undefined>;
type SnapshotBody = Omit<QuotaSnapshot, "diagnostics">;
/**
 * Normalize an untrusted label before it reaches the TUI. Control characters
 * (newlines included) become spaces so a label cannot break a row, and runs of
 * whitespace collapse to one space.
 */
export declare function normalizeLabel(value: unknown): string | undefined;
/**
 * Validate the pinned `ocx.quota-pool/1` payload and project it to the display
 * shape. Rejects an incompatible or malformed payload instead of showing an
 * empty pool that would imply zero quota.
 */
export declare function parseQuotaPool(payload: unknown): SnapshotBody;
/**
 * Fetches the passive OpenCodex quota pool from the attested local endpoint or legacy loopback.
 *
 * Never throws. Redirects are rejected and all untrusted fields are validated,
 * so a malformed or hostile local response produces a safe `error` string. The
 * token is read once per call and attached only as a boolean in `diagnostics`.
 */
export declare function fetchQuota(): Promise<QuotaSnapshot>;
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
export declare function refreshQuota(options?: {
    force?: boolean;
}): Promise<QuotaSnapshot>;
export {};
//# sourceMappingURL=quota.d.ts.map