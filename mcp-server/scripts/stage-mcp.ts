/**
 * Builds the publishable `issuewatcher-mcp` package into a staging folder.
 *
 * The repository also contains the email digest (nodemailer, Redis, Gemini...). Publishing the repo's
 * package.json as-is would make `npx issuewatcher-mcp` download all of that. Instead this script starts
 * from build/mcp/main.js, follows every relative import to find exactly the files the server uses, finds
 * the third-party packages those files import, and writes a package containing only those. If the server
 * ever imports something that is not declared, it fails here rather than on a user's machine.
 *
 *   npm run build && npm run package:mcp        (writes ./dist-mcp)
 */
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const root = process.cwd();
const outDir = path.resolve(process.argv[2] ?? "dist-mcp");
const entry = path.join(root, "build", "mcp", "main.js");

type PackageJson = { version: string; dependencies?: Record<string, string>; repository?: unknown };
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;

if (!fs.existsSync(entry)) throw new Error(`${entry} not found. Run "npm run build" first.`);

// Matches: import x from "y"; import {a} from "y"; import "y"; export * from "y"; await import("y")
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+)["']([^"']+)["']/g;

const files = new Set<string>();
const packages = new Set<string>();

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function visit(file: string): void {
  if (files.has(file)) return;
  files.add(file);
  const source = fs.readFileSync(file, "utf8");
  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1]!;
    if (spec.startsWith(".")) {
      visit(path.resolve(path.dirname(file), spec));
    } else if (!spec.startsWith("node:") && !builtinModules.includes(spec)) {
      packages.add(packageName(spec));
    }
  }
}
visit(entry);

const dependencies: Record<string, string> = {};
for (const name of [...packages].sort()) {
  const version = rootPkg.dependencies?.[name];
  if (!version) {
    throw new Error(`The server imports "${name}" but it is not in package.json dependencies (it may be a devDependency).`);
  }
  dependencies[name] = version;
}

fs.rmSync(outDir, { recursive: true, force: true });
for (const file of files) {
  const dest = path.join(outDir, path.relative(root, file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Source maps are not shipped, so drop the comment that points at them.
  fs.writeFileSync(dest, fs.readFileSync(file, "utf8").replace(/\n\/\/# sourceMappingURL=.*$/m, ""));
}

const repoRoot = path.resolve(root, "..");
const readme = ["docs/MCP.md", "README.md"].map((p) => path.join(repoRoot, p)).find((p) => fs.existsSync(p));
if (readme) {
  // On npm the README is shown away from the repository, so relative links (../DECISIONS.md) would break.
  const readmeDir = path.posix.dirname(path.relative(repoRoot, readme).split(path.sep).join("/"));
  const blob = "https://github.com/mac146/IssueWatcher/blob/main/";
  const text = fs.readFileSync(readme, "utf8").replace(/\]\((?!https?:|#|mailto:)([^)\s]+?)(#[^)]*)?\)/g, (_m, target: string, hash = "") => {
    const resolved = path.posix.normalize(path.posix.join(readmeDir, target));
    return `](${blob}${resolved}${hash})`;
  });
  fs.writeFileSync(path.join(outDir, "README.md"), text);
}
const license = path.join(repoRoot, "LICENSE");
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(outDir, "LICENSE"));

const manifest = {
  name: "issuewatcher-mcp",
  version: rootPkg.version,
  description: "MCP server that ranks new GitHub issues for your AI assistant: what to pick up, and what may break your projects.",
  mcpName: "io.github.mac146/issuewatcher",
  license: "MIT",
  type: "module",
  bin: { "issuewatcher-mcp": "build/mcp/main.js" },
  engines: { node: ">=20" },
  dependencies,
  repository: { type: "git", url: "git+https://github.com/mac146/IssueWatcher.git", directory: "mcp-server" },
  homepage: "https://github.com/mac146/IssueWatcher#readme",
  bugs: { url: "https://github.com/mac146/IssueWatcher/issues" },
  keywords: ["mcp", "model-context-protocol", "github", "issues", "open-source", "good-first-issue", "claude", "cursor"],
  publishConfig: { access: "public" },
};
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`Staged ${manifest.name}@${manifest.version} in ${outDir}`);
console.log(`  ${files.size} files, ${Object.keys(dependencies).length} dependencies: ${Object.keys(dependencies).join(", ")}`);
console.log(`  README: ${readme ? path.relative(repoRoot, readme) : "(none)"}`);
