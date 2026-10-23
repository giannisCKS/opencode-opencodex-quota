import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.join(rootDir, "src", "tui.tsx");
const distJsPath = path.join(rootDir, "dist", "tui.js");

// The TUI source is owned by the designer. Until it lands, keep the core build
// green instead of failing on a missing file.
try {
  await fs.access(sourcePath);
} catch {
  console.warn(`[prepare-tui-dist] ${path.relative(rootDir, sourcePath)} not found; skipping TUI build`);
  process.exit(0);
}

const source = await fs.readFile(sourcePath, "utf8");
const transformed = await babel.transformAsync(source, {
  filename: sourcePath,
  configFile: false,
  babelrc: false,
  presets: [
    [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
    [typescriptPreset],
  ],
});

if (!transformed?.code) {
  throw new Error(`Babel transform returned empty output for ${sourcePath}`);
}

await fs.writeFile(distJsPath, `${transformed.code}\n`);

// `tsc` emits `dist/tui.jsx` (and its map) for the JSX source. The shipped TUI
// entry is the precompiled `dist/tui.js`, so drop the JSX artifacts.
for (const artifact of ["tui.jsx", "tui.jsx.map"]) {
  await fs.rm(path.join(rootDir, "dist", artifact), { force: true });
}
