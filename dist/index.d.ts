/**
 * OpenCode V2 server plugin: registers the quota RPC the TUI reads.
 *
 * The server is passive: it fetches only the fixed `GET /api/quota-pool`
 * endpoint, registers no slash commands, posts no quota messages, and installs
 * no session hooks. There is no refresh control.
 */
import { Plugin } from "@opencode/plugin";
export declare const OpenCodexQuotaPlugin: Plugin.Plugin;
export default OpenCodexQuotaPlugin;
//# sourceMappingURL=index.d.ts.map