/**
 * Packaging smoke tests.
 *
 * OpenCode's directory loader resolves `<dir>/index.js` (server) and `<dir>/tui`
 * (TUI) by path, so the root shims and the built `dist/` output must both exist and
 * load. These tests run the real modules, including the TUI runtime, instead of
 * asserting only their text. `npm run validate` builds before it tests, so `dist/`
 * is present; a bare `npm test` on an unbuilt tree fails with that instruction.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type PluginShape = { id?: unknown; setup?: unknown };

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The plugin object a module default-exports, or a clear failure. */
async function loadDefault(relativePath: string): Promise<PluginShape> {
  const absolute = join(ROOT, relativePath);
  const module = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
  assert.ok(
    typeof module.default === "object" && module.default !== null,
    `${relativePath} must default-export an object`,
  );
  return module.default as PluginShape;
}

test("the build output exists (run `npm run build` first; validate does)", () => {
  for (const artifact of ["dist/index.js", "dist/tui.js", "dist/index.d.ts", "dist/tui.d.ts"]) {
    assert.ok(existsSync(join(ROOT, artifact)), `missing build artifact ${artifact}`);
  }
});

test("the root server shim loads the built plugin", async () => {
  assert.match(
    readFileSync(join(ROOT, "index.js"), "utf8"),
    /from\s+"\.\/dist\/index\.js"/,
    "the root server shim must point at the build output",
  );
  const plugin = await loadDefault("index.js");
  assert.equal(plugin.id, "opencodex-quota.server");
  assert.equal(typeof plugin.setup, "function");
});

test("the root tui shim points at the built TUI and loads it", async () => {
  const shim = readFileSync(join(ROOT, "tui.ts"), "utf8");
  assert.match(
    shim,
    /from\s+"\.\/dist\/tui\.js"/,
    "the root tui shim must point at dist/tui.js, not the TypeScript source it cannot resolve",
  );
  const plugin = await loadDefault("tui.ts");
  assert.equal(typeof plugin.id, "string");
  assert.equal(typeof plugin.setup, "function");
});

test("the tui subpath export loads the built TUI plugin", async () => {
  const plugin = await loadDefault("dist/tui.js");
  assert.equal(typeof plugin.id, "string");
  assert.equal(typeof plugin.setup, "function");
});

test("every declared entry point resolves to a file on disk", () => {
  const manifest = readJson(join(ROOT, "package.json"));
  assert.equal(manifest.main, "./dist/index.js");
  assert.equal(manifest.types, "./dist/index.d.ts");

  const exports = manifest.exports as Record<string, Record<string, string>>;
  const targets = new Set<string>();
  for (const entry of Object.values(exports)) {
    for (const target of Object.values(entry)) targets.add(target);
  }
  assert.deepEqual(
    [...targets].sort(),
    [
      "./dist/index.d.ts",
      "./dist/index.js",
      "./dist/tui.d.ts",
      "./dist/tui.js",
    ],
  );
  for (const target of targets) {
    assert.ok(existsSync(join(ROOT, target)), `declared export ${target} does not exist`);
  }

  // The loader also resolves the root shims by path, so they must ship.
  const files = manifest.files as string[];
  for (const entry of ["index.js", "tui.ts", "dist", "README.md", "LICENSE"]) {
    assert.ok(files.includes(entry), `package files must include ${entry}`);
  }
});

function sortRecord(value: unknown): Record<string, string> {
  const record = value as Record<string, string>;
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

test("the scriptless install payload ships built runtime artifacts", () => {
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const [packed] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  const packedPaths = new Set(packed.files.map((file) => file.path));

  // OpenCode installs Git packages with lifecycle scripts disabled, so these files
  // must exist in the commit and survive packing without a build step.
  for (const entry of [
    "dist/index.js",
    "dist/tui.js",
    "dist/index.d.ts",
    "dist/tui.d.ts",
    "index.js",
    "tui.ts",
    "README.md",
    "LICENSE",
  ]) {
    assert.ok(packedPaths.has(entry), `scriptless package payload is missing ${entry}`);
  }

  // The generated dist must be tracked by Git, not ignored.
  const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.ok(!ignored.some((line) => /^\/?dist\/?$/.test(line)), ".gitignore must not ignore the committed dist output");
});

test("git installs retain the TUI runtime dependencies", () => {
  const manifest = readJson(join(ROOT, "package.json"));
  const lock = readJson(join(ROOT, "package-lock.json"));
  const dependencies = manifest.dependencies as Record<string, string>;
  const devDependencies = manifest.devDependencies as Record<string, string>;

  const runtime = ["@opentui/core", "@opentui/solid", "solid-js"];
  for (const name of runtime) {
    assert.ok(name in dependencies, `${name} must be a runtime dependency`);
    assert.ok(!(name in devDependencies), `${name} must not be development-only`);
  }

  for (const name of ["@babel/core", "@babel/preset-typescript", "babel-preset-solid", "tsx", "typescript"]) {
    assert.ok(name in devDependencies, `${name} must stay a development dependency`);
    assert.ok(!(name in dependencies), `${name} must not become a runtime dependency`);
  }

  // The lockfile root dependency sets must track the manifest exactly.
  const lockedPackages = lock.packages as Record<string, Record<string, unknown>>;
  assert.deepEqual(sortRecord(lockedPackages[""].dependencies), sortRecord(dependencies));
  assert.deepEqual(sortRecord(lockedPackages[""].devDependencies), sortRecord(devDependencies));

  // Pruned development dependencies must not leave these absent from the runtime tree.
  for (const name of runtime) {
    const entry = lockedPackages[`node_modules/${name}`];
    assert.ok(entry, `${name} is missing from package-lock.json`);
    assert.ok(!entry.dev && !entry.devOptional, `${name} must not be marked development-only in the lockfile`);
  }
});
