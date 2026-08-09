import { resolve } from "node:path";

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

export const EXTENSION_MODE_ENV = "PI_SUBAGENT_EXTENSION_MODE";
export const EXTENSIONS_ENV = "PI_SUBAGENT_EXTENSIONS";

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

/** Exact absolute extension entries passed with -e for a Pi child. */
export function getPiExtensionEntries(
  runtime: ExtensionRuntime,
  paths: ExtensionRuntimeEntries,
): string[] {
  const entries = runtime.extensionMode === "explicit"
    ? [paths.subagentsEntry, paths.subagentDoneEntry, ...runtime.extensions]
    : [paths.subagentDoneEntry, ...runtime.extensions];
  return [...new Set(entries.map((path) => resolve(path)))];
}

/** Build Pi CLI flags for the selected extension runtime. */
export function buildPiExtensionArgs(
  runtime: ExtensionRuntime,
  paths: ExtensionRuntimeEntries,
): string[] {
  return [
    ...(runtime.extensionMode === "explicit" ? ["--no-extensions"] : []),
    ...getPiExtensionEntries(runtime, paths).flatMap((path) => ["-e", path]),
  ];
}

/** Environment inherited by descendant Pi-backed subagent launches. */
export function getExtensionRuntimeEnv(runtime: ExtensionRuntime): Record<string, string> {
  return {
    [EXTENSION_MODE_ENV]: runtime.extensionMode,
    [EXTENSIONS_ENV]: runtime.extensions.join(","),
  };
}
