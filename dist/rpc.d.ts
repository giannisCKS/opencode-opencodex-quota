/**
 * The quota RPC between this plugin's server half and the TUI. The server
 * registers it during setup; the TUI calls `snapshot` for a passive read and
 * `refresh` for an active provider-report rebuild. Only `refresh` accepts an
 * explicit `force` flag; snapshot input stays empty.
 *
 * Imports from `@opencode/*` stay type-only, so loading this module loads no
 * OpenCode package.
 */
import type { Rpc } from "@opencode/plugin/rpc";
import type { QuotaSnapshot } from "./quota.js";
export declare const QUOTA_RPC_ID = "opencodex.quota";
type StandardValueSchema = Extract<Rpc.PortableValueSchema, {
    "~standard": unknown;
}>;
type QuotaRpcSchema<T> = StandardValueSchema & {
    "~standard": {
        types?: {
            input: T;
            output: T;
        };
    };
};
/** The passive snapshot takes an empty input: no control is exposed. */
export type QuotaSnapshotInput = Record<string, never>;
/** The active refresh accepts only an optional explicit-refresh flag. */
export type QuotaRefreshInput = {
    force?: boolean;
};
/**
 * The quota RPC. `snapshot` reads the passive pool; `refresh` actively rebuilds
 * provider reports and then rereads the passive pool. Automatic refreshes stay
 * throttled server-side; only an explicit `force` bypasses the cooldown.
 */
export declare const quotaRpc: {
    id: string;
    events: {};
    methods: {
        snapshot: {
            input: QuotaRpcSchema<QuotaSnapshotInput>;
            output: QuotaRpcSchema<QuotaSnapshot>;
        };
        refresh: {
            input: QuotaRpcSchema<QuotaRefreshInput>;
            output: QuotaRpcSchema<QuotaSnapshot>;
        };
    };
};
export {};
//# sourceMappingURL=rpc.d.ts.map