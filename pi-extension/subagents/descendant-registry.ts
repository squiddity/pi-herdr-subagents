import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const REGISTRY_VERSION = 1;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_ENTRIES = 256;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 160;

export type DescendantState =
  | "starting"
  | "active"
  | "waiting-for-terminal-delivery"
  | "interrupted"
  | "blocked"
  | "stalled";

export interface DescendantRegistryEntry {
  id: string;
  name: string;
  state: DescendantState;
}

interface DescendantRegistryFile {
  version: 1;
  entries: DescendantRegistryEntry[];
}

function safeText(value: string, maximum: number): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, maximum) || "subagent";
}

function validateEntry(value: unknown): DescendantRegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("descendant registry entry is invalid");
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    !entry.id ||
    entry.id.length > MAX_ID_LENGTH
  ) {
    throw new Error("descendant registry id is invalid");
  }
  if (
    typeof entry.name !== "string" ||
    !entry.name ||
    entry.name.length > MAX_NAME_LENGTH
  ) {
    throw new Error("descendant registry name is invalid");
  }
  const states: DescendantState[] = [
    "starting",
    "active",
    "waiting-for-terminal-delivery",
    "interrupted",
    "blocked",
    "stalled",
  ];
  if (!states.includes(entry.state as DescendantState)) {
    throw new Error("descendant registry state is invalid");
  }
  return {
    id: safeText(entry.id, MAX_ID_LENGTH),
    name: safeText(entry.name, MAX_NAME_LENGTH),
    state: entry.state as DescendantState,
  };
}

function readRegistry(path: string): DescendantRegistryFile {
  if (!existsSync(path)) return { version: REGISTRY_VERSION, entries: [] };
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error("descendant registry must be a regular file");
  if (stat.size > MAX_REGISTRY_BYTES) {
    throw new Error("descendant registry exceeds its byte limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("descendant registry is unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("descendant registry is invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== REGISTRY_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES
  ) {
    throw new Error("descendant registry is invalid");
  }
  const entries = value.entries.map(validateEntry);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("descendant registry contains duplicate ids");
  }
  return { version: REGISTRY_VERSION, entries };
}

function writeRegistry(path: string, registry: DescendantRegistryFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${Date.now()}.descendants.tmp`,
  );
  writeFileSync(temporary, `${JSON.stringify(registry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function registerDescendant(
  path: string,
  entry: DescendantRegistryEntry,
): void {
  const registry = readRegistry(path);
  const next = registry.entries.filter((item) => item.id !== entry.id);
  if (next.length >= MAX_ENTRIES) throw new Error("descendant registry is full");
  next.push({
    ...entry,
    id: safeText(entry.id, MAX_ID_LENGTH),
    name: safeText(entry.name, MAX_NAME_LENGTH),
  });
  writeRegistry(path, { version: REGISTRY_VERSION, entries: next });
}

export function unregisterDescendant(path: string, id: string): void {
  const registry = readRegistry(path);
  const entries = registry.entries.filter((entry) => entry.id !== id);
  if (entries.length !== registry.entries.length) {
    writeRegistry(path, { version: REGISTRY_VERSION, entries });
  }
}

export function readTrackedDescendants(path: string): DescendantRegistryEntry[] {
  return readRegistry(path).entries;
}

/**
 * Return the registry owned by one child session. The path is stable across
 * resume and distinct for sibling sessions launched from the same artifact
 * root. A child receives this path; it is never registered in this registry.
 */
export function childDescendantRegistryPath(
  artifactDir: string,
  childSessionFile: string,
): string {
  const sessionKey = createHash("sha256")
    .update(resolve(childSessionFile))
    .digest("hex")
    .slice(0, 32);
  return join(artifactDir, "descendant-registries", `${sessionKey}.json`);
}

/** The current process's host-owned registry, when this process is itself a child. */
export function parentDescendantRegistryPath(
  envValue = process.env.PI_SUBAGENT_DESCENDANTS_FILE,
): string | undefined {
  const path = envValue?.trim();
  return path || undefined;
}
