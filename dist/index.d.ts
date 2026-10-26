/**
 * OpenCode V2 server plugin: registers the quota RPC the TUI reads.
 *
 * `snapshot` stays passive and fetches only the fixed `GET /api/quota-pool`
 * endpoint. `refresh` performs the active provider-report rebuild and then
 * rereads that same passive endpoint. Automatic refreshes stay throttled; the
 * RPC's explicit `force` flag bypasses that cooldown. The server registers no
 * slash commands, posts no quota messages, and installs no session hooks.
 */
import { Plugin } from "@opencode/plugin";
export declare const OpenCodexQuotaPlugin: Plugin.Plugin;
export default OpenCodexQuotaPlugin;
//# sourceMappingURL=index.d.ts.map