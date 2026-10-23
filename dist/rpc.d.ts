/**
 * The quota RPC between this plugin's server half and the TUI. The server
 * registers it during setup; the TUI calls its single `snapshot` method.
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
/** The `snapshot` input is empty: there is no refresh or reset-notice control. */
export type QuotaSnapshotInput = Record<string, never>;
/**
 * The single-method quota RPC. `snapshot` takes an empty input and returns the
 * current normalized OpenCodex pool reading.
 */
export declare const quotaRpc: {
    id: string;
    events: {};
    methods: {
        snapshot: {
            input: QuotaRpcSchema<QuotaSnapshotInput>;
            output: QuotaRpcSchema<QuotaSnapshot>;
        };
    };
};
export {};
//# sourceMappingURL=rpc.d.ts.map