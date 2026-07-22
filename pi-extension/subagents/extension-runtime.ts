import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type ExtensionMode = "normal" | "explicit";

export interface ExtensionRuntime {
  extensionMode: ExtensionMode;
  /** Caller-specified extension entry paths, resolved to absolute paths. */
  extensions: string[];
}

export interface ExtensionRuntimeRequest {
  extensionMode?: ExtensionMode;
  extensions?: string;
}

export interface ExtensionRuntimeEntries {
  subagentsEntry: string;
  subagentDoneEntry: string;
}

export interface PersistedExtensionRuntime {
  runtime: ExtensionRuntime;
  entries: ExtensionRuntimeEntries;
}

export const EXTENSION_MODE_ENV = "PI_SUBAGENT_EXTENSION_MODE";
export const EXTENSIONS_ENV = "PI_SUBAGENT_EXTENSIONS";
const EXTENSION_RUNTIME_SIDECAR_SUFFIX = ".subagent-runtime.json";

function parseMode(value: string | undefined): ExtensionMode {
  if (value == null || value === "") return "normal";
  if (value === "normal" || value === "explicit") return value;
  throw new Error(
    `Invalid inherited subagent extension mode ${JSON.stringify(value)}; expected "normal" or "explicit".`,
  );
}

function parseExtensionPaths(value: string | undefined, effectiveCwd: string): string[] {
  const resolvedPaths = (value ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => resolve(effectiveCwd, path));

  return [...new Set(resolvedPaths)];
}

/**
 * Resolve requested extension settings against the child cwd. Each field
 * independently inherits the runtime exported by the current Pi-backed child.
 */
export function resolveExtensionRuntime(
  request: ExtensionRuntimeRequest,
  effectiveCwd: string,
  inherited: { extensionMode?: string; extensions?: string } = {
    extensionMode: process.env[EXTENSION_MODE_ENV],
    extensions: process.env[EXTENSIONS_ENV],
  },
): ExtensionRuntime {
  const extensionMode = request.extensionMode ?? parseMode(inherited.extensionMode);
  const rawExtensions = request.extensions !== undefined
    ? request.extensions
    : inherited.extensions;

  return {
    extensionMode,
    extensions: parseExtensionPaths(rawExtensions, effectiveCwd),
  };
}

export function assertExtensionRuntimeSupported(
  backend: "pi" | "claude",
  request: ExtensionRuntimeRequest,
): void {
  if (backend === "pi") return;
  if (request.extensionMode !== undefined || request.extensions !== undefined) {
    throw new Error(
      "extensionMode and extensions are supported only for Pi-backed subagents; use a Pi-backed agent or omit these parameters.",
    );
  }
}

/** Build Pi CLI flags for the selected extension runtime. */
export function buildPiExtensionArgs(
  runtime: ExtensionRuntime,
  paths: ExtensionRuntimeEntries,
): string[] {
  const entries = runtime.extensionMode === "explicit"
    ? [paths.subagentsEntry, paths.subagentDoneEntry, ...runtime.extensions]
    : [paths.subagentDoneEntry, ...runtime.extensions];
  const uniqueEntries = [...new Set(entries.map((path) => resolve(path)))];

  return [
    ...(runtime.extensionMode === "explicit" ? ["--no-extensions"] : []),
    ...uniqueEntries.flatMap((path) => ["-e", path]),
  ];
}

/** Environment inherited by descendant Pi-backed subagent launches. */
export function getExtensionRuntimeEnv(runtime: ExtensionRuntime): Record<string, string> {
  return {
    [EXTENSION_MODE_ENV]: runtime.extensionMode,
    [EXTENSIONS_ENV]: runtime.extensions.join(","),
  };
}

export function getExtensionRuntimeSidecarPath(sessionPath: string): string {
  return `${sessionPath}${EXTENSION_RUNTIME_SIDECAR_SUFFIX}`;
}

/**
 * Persist the complete launch identity for an explicitly opted-in resume.
 * The sidecar is metadata, not a trust boundary: callers must never consume it
 * without an explicit user/model opt-in because it contains executable paths.
 */
export function writeExtensionRuntimeSidecar(
  sessionPath: string,
  runtime: ExtensionRuntime,
  entries: ExtensionRuntimeEntries,
): void {
  writeFileSync(
    getExtensionRuntimeSidecarPath(sessionPath),
    `${JSON.stringify({ version: 2, runtime, entries }, null, 2)}\n`,
    "utf8",
  );
}

export function readExtensionRuntimeSidecar(sessionPath: string): PersistedExtensionRuntime | null {
  try {
    const value = JSON.parse(readFileSync(getExtensionRuntimeSidecarPath(sessionPath), "utf8"));
    if (
      value?.version !== 2 ||
      (value.runtime?.extensionMode !== "normal" && value.runtime?.extensionMode !== "explicit") ||
      !Array.isArray(value.runtime?.extensions) ||
      !value.runtime.extensions.every((path: unknown) => typeof path === "string" && isAbsolute(path)) ||
      typeof value.entries?.subagentsEntry !== "string" ||
      !isAbsolute(value.entries.subagentsEntry) ||
      typeof value.entries?.subagentDoneEntry !== "string" ||
      !isAbsolute(value.entries.subagentDoneEntry)
    ) {
      return null;
    }
    return {
      runtime: {
        extensionMode: value.runtime.extensionMode,
        extensions: [...new Set(value.runtime.extensions)],
      },
      entries: {
        subagentsEntry: value.entries.subagentsEntry,
        subagentDoneEntry: value.entries.subagentDoneEntry,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Select resume settings without implicitly trusting executable paths adjacent
 * to an arbitrary caller-supplied session file.
 */
export function resolveResumeExtensionRuntime(options: {
  sessionPath: string;
  preserveExtensionRuntime: boolean;
  fallback: PersistedExtensionRuntime;
}): PersistedExtensionRuntime {
  if (!options.preserveExtensionRuntime) return options.fallback;
  const persisted = readExtensionRuntimeSidecar(options.sessionPath);
  if (!persisted) {
    throw new Error(
      `Cannot preserve extension runtime: no valid version-2 runtime sidecar exists for ${options.sessionPath}.`,
    );
  }
  return persisted;
}
