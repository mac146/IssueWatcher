import type { DependencyUse } from "../poller/types.js";

export type ManifestDependency = Omit<DependencyUse, "usedBy">;

/** Files looked for at the root of each of the user's repos. */
export const MANIFEST_FILES = ["package.json", "requirements.txt"] as const;

/** Specs that don't point at a registry package. */
const NON_REGISTRY = /^(?:file:|link:|workspace:|git\+|git:|github:|https?:|npm:|\.{0,2}\/)/;

export function parsePackageJson(text: string): ManifestDependency[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];
  const manifest = json as Record<string, unknown>;

  const out: ManifestDependency[] = [];
  const add = (section: unknown, kind: "runtime" | "dev") => {
    if (typeof section !== "object" || section === null) return;
    for (const [pkg, range] of Object.entries(section)) {
      if (typeof range !== "string" || NON_REGISTRY.test(range)) continue;
      out.push({ ecosystem: "npm", pkg, range, kind });
    }
  };
  add(manifest.dependencies, "runtime");
  add(manifest.devDependencies, "dev");
  return out;
}

/** Handles `name==1.2`, `name>=1.2,<2`, extras (`name[extra]`) and markers (`; python_version...`). */
export function parseRequirementsTxt(text: string): ManifestDependency[] {
  const out: ManifestDependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.split(";")[0]!.trim();
    if (!line || line.startsWith("-") || /^(?:git\+|https?:|\.{0,2}\/)/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/);
    if (!m) continue;
    out.push({ ecosystem: "pypi", pkg: m[1]!.toLowerCase().replace(/[_.]+/g, "-"), range: m[2]!.trim() || "*", kind: "runtime" });
  }
  return out;
}

export function parseManifest(file: string, text: string): ManifestDependency[] {
  if (file === "package.json") return parsePackageJson(text);
  if (file === "requirements.txt") return parseRequirementsTxt(text);
  return [];
}

export type Version = { major: number; minor: number };

/** Lowest version a range allows, e.g. "^1.6.0" -> 1.6, ">=2.1,<3" -> 2.1, "==4.0.1" -> 4.0. */
export function minVersion(range: string): Version | null {
  const m = range.match(/(\d+)(?:\.(\d+|x|\*))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] && /^\d+$/.test(m[2]) ? Number(m[2]) : 0 };
}
