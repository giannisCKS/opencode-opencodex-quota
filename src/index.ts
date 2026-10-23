/**
 * OpenCode V2 server plugin: registers the quota RPC the TUI reads.
 *
 * The server is passive: it fetches only the fixed `GET /api/quota-pool`
 * endpoint, registers no slash commands, posts no quota messages, and installs
 * no session hooks. There is no refresh control.
 */
import { Plugin } from "@opencode/plugin";
import { fetchQuota } from "./quota.js";
import { quotaRpc } from "./rpc.js";

/** An error as one line that is safe to log: bearer tokens redacted, bounded. */
function logReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);
}

export const OpenCodexQuotaPlugin = Plugin.define({
  id: "opencodex-quota.server",
  async setup(ctx) {
    // Awaited so the plugin is active only once the RPC is registered: OpenCode
    // waits for activation before routing an RPC call.
    await ctx.rpc.register(quotaRpc, {
      snapshot: async () => {
        try {
          return await fetchQuota();
        } catch (error) {
          console.warn(`[opencodex-quota] snapshot RPC failed: ${logReason(error)}`);
          throw error;
        }
      },
    });
  },
});

export default OpenCodexQuotaPlugin;
