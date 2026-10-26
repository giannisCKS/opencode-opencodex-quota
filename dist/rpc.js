export const QUOTA_RPC_ID = "opencodex.quota";
/**
 * A Standard Schema that runs `check` and passes the value through unchanged.
 * OpenCode validates every input and output with it. `types` only carries T for
 * TypeScript.
 */
function schema(check) {
    return {
        "~standard": {
            version: 1,
            vendor: "opencode-opencodex-quota",
            validate: (value) => {
                const issue = check(value);
                return issue ? { issues: [{ message: issue }] } : { value: value };
            },
        },
    };
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isIsoString(value) {
    return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}
const WINDOW_KINDS = ["burst_5h", "daily", "weekly", "monthly", "credits", "custom"];
const QUOTA_SOURCES = ["measured", "header", "estimated"];
const QUOTA_UNITS = ["requests", "tokens", "credits", "usd"];
const ACCOUNT_STATES = ["available", "exhausted", "paused", "reauth", "unknown"];
function isWindow(value) {
    if (!isObject(value))
        return false;
    if (!WINDOW_KINDS.includes(value.kind))
        return false;
    if (typeof value.label !== "string")
        return false;
    if (!QUOTA_SOURCES.includes(value.source))
        return false;
    if (!isIsoString(value.observedAt))
        return false;
    if (value.usedPercent !== undefined && !(isFiniteNumber(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100))
        return false;
    if (value.used !== undefined && !(isFiniteNumber(value.used) && value.used >= 0))
        return false;
    if (value.limit !== undefined && !(isFiniteNumber(value.limit) && value.limit >= 0))
        return false;
    if (value.unit !== undefined && !QUOTA_UNITS.includes(value.unit))
        return false;
    if (value.resetsAt !== undefined && !isIsoString(value.resetsAt))
        return false;
    if (value.windowSeconds !== undefined && !(isFiniteNumber(value.windowSeconds) && value.windowSeconds >= 0))
        return false;
    if (value.scopeModel !== undefined && typeof value.scopeModel !== "string")
        return false;
    if (value.exhausted !== undefined && typeof value.exhausted !== "boolean")
        return false;
    return true;
}
function isWindowList(value) {
    return Array.isArray(value) && value.every(isWindow);
}
function isAccount(value) {
    if (!isObject(value))
        return false;
    if (!ACCOUNT_STATES.includes(value.state))
        return false;
    if (!isWindowList(value.windows))
        return false;
    if (value.label !== undefined && typeof value.label !== "string")
        return false;
    if (value.plan !== undefined && typeof value.plan !== "string")
        return false;
    return true;
}
function isProvider(value) {
    if (!isObject(value))
        return false;
    if (typeof value.provider !== "string" || value.provider.length === 0)
        return false;
    const pooled = value.pooled;
    if (!isObject(pooled) || !isWindowList(pooled.windows))
        return false;
    if (pooled.headroom !== undefined && !(isFiniteNumber(pooled.headroom) && pooled.headroom >= 0))
        return false;
    if (pooled.nextResetAt !== undefined && !isIsoString(pooled.nextResetAt))
        return false;
    return Array.isArray(value.accounts) && value.accounts.every(isAccount);
}
function isSnapshot(value) {
    if (!isObject(value))
        return false;
    if (!Array.isArray(value.providers) || !value.providers.every(isProvider))
        return false;
    if (value.generatedAt !== undefined && !isIsoString(value.generatedAt))
        return false;
    if (value.error !== undefined && typeof value.error !== "string")
        return false;
    const diagnostics = value.diagnostics;
    return (isObject(diagnostics) &&
        typeof diagnostics.endpoint === "string" &&
        typeof diagnostics.tokenConfigured === "boolean");
}
/** An empty object (or an omitted input) is the only accepted passive request body. */
const emptyInput = schema((value) => {
    if (value === undefined)
        return null;
    if (!isObject(value))
        return "input must be an object";
    return Object.keys(value).length === 0 ? null : "input must be empty";
});
/** Only an optional boolean `force` is accepted for an active request. */
const refreshInput = schema((value) => {
    if (value === undefined)
        return null;
    if (!isObject(value))
        return "input must be an object";
    if (Object.keys(value).some((key) => key !== "force")) {
        return "input accepts only an optional force flag";
    }
    if (value.force !== undefined && typeof value.force !== "boolean") {
        return "force must be a boolean";
    }
    return null;
});
const snapshotOutput = schema((value) => isSnapshot(value) ? null : "output must be a valid quota snapshot");
/**
 * The quota RPC. `snapshot` reads the passive pool; `refresh` actively rebuilds
 * provider reports and then rereads the passive pool. Automatic refreshes stay
 * throttled server-side; only an explicit `force` bypasses the cooldown.
 */
export const quotaRpc = {
    id: QUOTA_RPC_ID,
    events: {},
    methods: {
        snapshot: {
            input: emptyInput,
            output: snapshotOutput,
        },
        refresh: {
            input: refreshInput,
            output: snapshotOutput,
        },
    },
};
//# sourceMappingURL=rpc.js.map