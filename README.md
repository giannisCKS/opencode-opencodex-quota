# opencode-opencodex-quota

A local OpenCode V2 plugin for the OpenCodex passive quota pool. It provides a quota sidebar and an on-demand `/quota` dialog. It does not send quota reports to a model.

## Scope

- One fixed endpoint: `GET http://127.0.0.1:10100/api/quota-pool`.
- One supported wire schema: `ocx.quota-pool/1`, introduced by [OpenCodex #7476](https://github.com/lidge-jun/opencodex/pull/7476).
- Cached quota only. Reading this endpoint does not probe providers or refresh upstream quota.
- The sidebar reads every 60 seconds. `/quota` opens a scrollable dialog and requests another passive reading.
- Provider pools and accounts come from OpenCodex. This plugin does not authenticate with individual providers.
- Missing quota remains unknown, never zero. Unknown values have no bar.
- Known percentages show a compact thin bar and a numeric remaining label. Reset countdowns and model scope stay visible, and exhausted windows stay marked.
- Sidebar resets count down in minutes under one hour, hours under one day, and whole days otherwise. Five-hour windows show hours and minutes (`4h 12m`), and drop zero minutes (`4h`). OpenAI pooled rows prefer the pooled reset; if absent, they show the duration from the earliest future matching available or exhausted account window, or `?d` when unknown. Paused, sign-in-required, and unknown accounts are skipped. This is a next contributing account reset, not a guaranteed pool reset.
- The OpenAI provider shows pooled windows only; other providers keep account states and account windows.
- No accounting, pricing, reset notifications, reference-plugin formatting, configuration module, or extra dependencies.

This replaces the previous adaptation of `@slkiser/opencode-quota`. Its report format and `/quota_status` command are no longer included.

## Requirements

- OpenCode 2.0.32, matching the pinned `@opencode/plugin` dependency.
- OpenCodex with the passive quota-pool endpoint on local port 10100.
- Node.js matching `package.json`'s `engines` field.

## Authentication and safety

The server resolves the management admin token in this order:

1. `OPENCODEX_ADMIN_AUTH_TOKEN`.
2. The file named by `OPENCODEX_ADMIN_TOKEN_FILE`.
3. `$OPENCODEX_HOME/admin-api-token`, defaulting to `~/.opencodex/admin-api-token`.

The admin token is not a provider key or data-plane API key. It is sent only as a Bearer header to the fixed loopback endpoint. It is never included in the quota snapshot or UI. Redirects are rejected, requests time out after 10 seconds, and responses are capped at 1 MB. The plugin does not call the legacy `/api/provider-quotas` endpoint or request active refresh.

Missing credentials, HTTP errors, unsupported schemas, and malformed data produce an unavailable state. Raw response bodies and network error details are not displayed.

## Installation from private GitHub

The repository is private. OpenCode clones it with your existing Git credentials, so no token belongs in a plugin URL:

```sh
gh auth status
git ls-remote https://github.com/giannisCKS/opencode-opencodex-quota.git
```

Both commands must succeed for the account that runs OpenCode. If Git is not already configured for GitHub, authenticate with `gh auth login` or your normal SSH credential setup. Never embed a personal access token in the plugin target or repository URL.

Pin the installation to a full commit hash. A branch or tag can move; a full hash cannot:

```sh
opencode plugin add 'github:giannisCKS/opencode-opencodex-quota#<full-40-character-sha>'
opencode plugin list
```

The equivalent `opencode.jsonc` entry is:

```jsonc
{
  "plugins": [
    "github:giannisCKS/opencode-opencodex-quota#<full-40-character-sha>"
  ]
}
```

Preserve unrelated plugin entries. Do not load both quota plugins: they can register overlapping commands and sidebars.

The package has no install-time build step. OpenCode installs Git packages with lifecycle scripts disabled, so the built `dist/` output must be committed. Install from a commit that contains the compiled server and TUI artifacts; do not install a source-only commit. `package-lock.json` stays committed for reproducible development, but OpenCode does not run `npm` build or install scripts during plugin installation.

`@opentui/core`, `@opentui/solid`, and `solid-js` are runtime dependencies. They must remain in `dependencies`, because development dependencies are not installed for a packaged plugin. Babel, TypeScript, and `tsx` stay in `devDependencies` for local builds.

OpenCode reloads changes under watched configuration directories automatically. To reload a changed plugin target without restarting, run `/reload` in the TUI. Use `opencode service restart` only if a cached package or an unwatched local path does not refresh. Restarting is not required for a normal Git plugin installation.

This project does not edit your OpenCode configuration. To uninstall, run `opencode plugin remove` for the pinned target, or remove its entry, then reload. Remove only the quota entry and preserve unrelated plugins.

### Fallback when the native Git installer fails

If `opencode plugin add` reports `git dep preparation failed` while authenticated Git access works, install the same pinned GitHub revision into a dedicated runtime directory:

```sh
revision=30cdd639988fb2cf4d3bae3beb4590c86dbddb36
prefix="$HOME/.local/share/opencode/installed-plugins/opencode-opencodex-quota/$revision"
npm install --ignore-scripts --omit=dev --save-exact --prefix "$prefix" \
  "git+https://github.com/giannisCKS/opencode-opencodex-quota.git#$revision"
```

Configure `$prefix/node_modules/opencode-opencodex-quota` as an absolute directory in the global `plugins` array, replacing only the old quota entry. Keep the generated installation manifest and lockfile. This package comes from GitHub, not the development checkout. Updates are manual: install another reviewed revision into a new directory and change only that plugin path. Native `plugin update` does not manage directory installations.

## Development

```sh
npm run typecheck
npm run build
npm test
npm run validate
```

`npm run validate` runs typechecking, build, and tests in order. Package tests inspect built artifacts, so build before running `npm test` independently.

- `src/quota.ts`: bounded passive fetch, credential resolution, wire validation, and normalized display types.
- `src/rpc.ts`: the single snapshot RPC shared by server and TUI.
- `src/index.ts`: server-side RPC registration only.
- `src/tui.tsx`: sidebar, command dialog, and polling lifecycle.
- `index.js`, `tui.ts`: directory-loader entries pointing to built output.

Tests use fixtures and mocked transport. They do not require a running OpenCodex instance or real credentials.
