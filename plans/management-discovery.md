# Management endpoint discovery

## Context

The management listener may bind a local tailnet address instead of loopback. Discover its endpoint from private runtime metadata and verify its health attestation before sending the management bearer.

## Phases

1. Inspect runtime metadata, attestation, and existing quota transport contracts.
2. Implement local endpoint discovery and attestation while preserving quota refresh semantics and legacy fallback constraints.
3. Add focused transport coverage, document the trust boundary, and generate distribution files.
4. Run focused tests, typecheck, and build. The parent owns full validation, independent review, commit, and push.

## Attempts and blocker

1. Previous writer could not resume after the parent location move; no source changes were made.
2. Replacement writer inspected the contracts and raised Windows ACL verification. Decision: Windows discovery is unsupported; retain fixed loopback behavior and ignore metadata there. POSIX discovery requires private user-owned metadata.

## Acceptance

- Only locally assigned numeric addresses receive the bearer after successful attestation when a secret exists.
- Wildcard bind hostnames `0.0.0.0`, `::`, `[::]`, and `*` are probed on IPv4 loopback, with the same attestation requirement.
- Invalid proof never downgrades to loopback. Only missing or unsupported metadata permits legacy fallback.
- Direct HTTP rejects redirects, bypasses proxies, and bounds response bodies and deadlines.
- Existing refresh and passive quota routes, schema, redaction, cooldown, and singleflight remain unchanged.
- Focused tests cover trusted discovery, unsafe metadata, proof failures, redirects, proxy bypass, and refresh routes.

## Files to modify

- `src/quota.ts`
- `tests/quota.test.ts`, `tests/server.test.ts`, and focused transport tests if needed
- `README.md`
- Generated `dist` files from the build
