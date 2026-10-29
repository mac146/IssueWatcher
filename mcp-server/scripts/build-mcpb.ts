/**
 * Builds the one-click Claude Desktop bundle (issuewatcher-<version>.mcpb).
 *
 * Needs `npm run build && npm run package:mcp` first (it reuses the lean package in ./dist-mcp) and
 * network access, because the bundle ships its own production node_modules so that it works for users
 * who do not have npm at all.
 *
 *   npm run build:mcpb        (writes ./dist-mcpb/issuewatcher-<version>.mcpb)
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const lean = path.join(root, "dist-mcp");
const out = path.join(root, "dist-mcpb");
const stage = path.join(out, "stage");

if (!fs.existsSync(path.join(lean, "package.json"))) throw new Error('Run "npm run build && npm run package:mcp" first.');

const pkg = JSON.parse(fs.readFileSync(path.join(lean, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
const run = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// Code, package metadata, licence and readme from the lean package.
fs.cpSync(path.join(lean, "build"), path.join(stage, "build"), { recursive: true });
for (const f of ["package.json", "LICENSE", "README.md"]) {
  if (fs.existsSync(path.join(lean, f))) fs.copyFileSync(path.join(lean, f), path.join(stage, f));
}

// The manifest carries the real version.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "packaging", "mcpb", "manifest.json"), "utf8")) as { version: string };
manifest.version = pkg.version;
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const icon = path.join(root, "packaging", "mcpb", "icon.png");
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(stage, "icon.png"));
else console.warn("No packaging/mcpb/icon.png: the bundle works, but directory listings want a 512x512 icon.");

run("npx mcpb validate manifest.json", stage);
run("npm install --omit=dev --ignore-scripts --no-audit --no-fund", stage);

const file = path.join(out, `issuewatcher-${pkg.version}.mcpb`);
run(`npx mcpb pack "${stage}" "${file}"`);
run(`npx mcpb info "${file}"`);
console.log(`\nBuilt ${file} (${(fs.statSync(file).size / 1_048_576).toFixed(1)} MB)`);
