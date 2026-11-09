import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchQuota, refreshQuota } from "../src/quota.ts";

test("POSIX wildcard discovery attests loopback before sending a bearer", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "quota-wildcard-"));
  const savedHome = process.env.OPENCODEX_HOME;
  const savedToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const paths: string[] = [];
  let validProof = true;
  const server = http.createServer((req, res) => {
    paths.push(`${req.url} ${req.headers.authorization ?? ""}`);
    if (req.url === "/healthz") {
      const nonce = req.headers["x-opencodex-attestation-challenge"];
      const proof = createHmac("sha256", secret).update(`opencodex-local-management-v1\n${nonce}\n${process.pid}\n${port}`).digest("base64url");
      res.setHeader("x-opencodex-attestation-proof", validProof ? proof : "x".repeat(43));
      res.end(JSON.stringify({ service: "opencodex", pid: process.pid, port }));
    } else {
      res.end(JSON.stringify({ schema: "ocx.quota-pool/1", producer: { version: "1", role: "standalone", homeId: "test" }, generatedAt: "2026-01-01T00:00:00Z", providers: [] }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  try {
    process.env.OPENCODEX_HOME = home;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "test-token";
    for (const hostname of ["0.0.0.0", "::", "[::]", "*"]) {
      await writeFile(join(home, "runtime-port.json"), JSON.stringify({ pid: process.pid, port, hostname, attestationSecret: secret }), { mode: 0o600 });
      paths.length = 0;
      validProof = true;
      assert.equal((await fetchQuota()).error, undefined, hostname);
      assert.deepEqual(paths, ["/healthz ", "/api/quota-pool Bearer test-token"]);
      paths.length = 0;
      validProof = false;
      assert.ok((await fetchQuota()).error, hostname);
      assert.deepEqual(paths, ["/healthz "]);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
    if (savedToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = savedToken;
  }
});

test("POSIX discovery attests local endpoint and rejects unsafe metadata and proof failures", { skip: process.platform === "win32" }, async (t) => {
  const address = Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
  if (!address) { t.skip("no assigned non-loopback IPv4 address"); return; }
  const home = await mkdtemp(join(tmpdir(), "quota-discovery-"));
  const saved = { ...process.env };
  const secret = Buffer.alloc(32, 9).toString("base64url");
  const paths: string[] = [];
  let proofMode = "valid";
  const server = http.createServer((req, res) => {
    paths.push(`${req.url} ${req.headers.authorization ?? ""}`);
    if (req.url === "/healthz") {
      const nonce = req.headers["x-opencodex-attestation-challenge"];
      if (proofMode !== "missing") res.setHeader("x-opencodex-attestation-proof", proofMode === "valid" || proofMode === "redirect" ? createHmac("sha256", secret).update(`opencodex-local-management-v1\n${nonce}\n${process.pid}\n${port}`).digest("base64url") : "x".repeat(43));
      res.end(JSON.stringify({ service: "opencodex", pid: process.pid, port }));
    } else if (proofMode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/stolen" }).end();
    } else {
      res.end(JSON.stringify({ schema: "ocx.quota-pool/1", producer: { version: "1", role: "standalone", homeId: "test" }, generatedAt: "2026-01-01T00:00:00Z", providers: [] }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, address, resolve); });
  const port = (server.address() as { port: number }).port;
  const path = join(home, "runtime-port.json");
  const metadata = { pid: process.pid, port, hostname: address, attestationSecret: secret };
  const write = async (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  try {
    process.env.OPENCODEX_HOME = home;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "test-token";
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.ALL_PROXY = "http://127.0.0.1:1";
    process.env.NO_PROXY = "";
    await write(metadata);
    assert.equal((await refreshQuota({ force: true })).error, undefined);
    assert.deepEqual(paths, ["/healthz ", "/api/provider-quotas?refresh=1 Bearer test-token", "/healthz ", "/api/quota-pool Bearer test-token"]);
    for (const mode of ["wrong", "missing"]) {
      paths.length = 0; proofMode = mode;
      assert.ok((await fetchQuota()).error);
      assert.deepEqual(paths, ["/healthz "]);
    }
    proofMode = "valid";
    for (const invalid of [{ ...metadata, hostname: "example.com" }, { ...metadata, hostname: "192.0.2.1" }, { ...metadata, port: 0 }, { ...metadata, attestationSecret: "bad" }, null]) {
      paths.length = 0; await write(invalid);
      assert.ok((await fetchQuota()).error);
      assert.deepEqual(paths, []);
    }
    await write(metadata); await chmod(path, 0o644);
    assert.ok((await fetchQuota()).error);
    await rm(path); await symlink(join(home, "absent"), path);
    assert.ok((await fetchQuota()).error);
    await rm(path); await write(metadata);
    paths.length = 0; proofMode = "redirect";
    assert.ok((await fetchQuota()).error);
    assert.deepEqual(paths, ["/healthz ", "/api/quota-pool Bearer test-token"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
