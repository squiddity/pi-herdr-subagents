import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ThinkingLevel } from "./runtime-routing.ts";
import type { ExtensionMode } from "./extension-runtime.ts";
import { readBoundedRegularFile, UnsafeFileError } from "./safe-file.ts";

export const LAUNCH_PROFILE_VERSION = 1 as const;
export const MAX_PROFILE_TOOLS = 256;
export const MAX_PROFILE_EXTENSIONS = 64;
export const MAX_PROFILE_BYTES = 128 * 1024;
const MAX_VALUE_LENGTH = 4096;
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Credential- and prompt-free settings needed to reproduce a Pi child launch. */
export interface SubagentLaunchProfile {
  version: typeof LAUNCH_PROFILE_VERSION;
  model: string;
  thinking: ThinkingLevel;
  cwd: string;
  /** Named agent key used by recursive policy checks, or null. */
  agent: string | null;
  /** Exact value represented by --tools, or null when no allowlist was used. */
  toolAllowlist: string[] | null;
  deniedTools: string[];
  extensionMode: ExtensionMode;
  /** Exact absolute entries passed with -e on the original launch. */
  extensionEntries: string[];
  /** Absolute caller entries exported for recursive descendants. */
  inheritedExtensionEntries: string[];
  configRoot: string;
  /** Exact named child profiles allowed by the resolved parent profile. */
  allowedChildAgents?: string[] | null;
  /** Effective one-shot waiting timeout: immediate, bounded seconds, or null to disable. */
  waitTimeout?: number | "immediate" | null;
  /** Policy for including the latest final assistant message in timeout steers. */
  waitTimeoutMessage?: "none" | "preview" | "full";
}

export type LaunchProfileReadResult =
  | { status: "loaded"; profile: SubagentLaunchProfile; path: string }
  | { status: "absent"; path: string }
  | { status: "malformed"; path: string; error: string };

export interface ResumeProfileLaunch {
  cwd: string;
  args: string[];
  env: Record<string, string>;
}

export interface ToolProfileEvidence {
  status: "exact" | "mismatch" | "unrestricted" | "unverified";
  expected: string[] | null;
  actual?: string[];
  expectedDenied?: string[];
  actualDenied?: string[];
  missing?: string[];
  unexpected?: string[];
  deniedMissing?: string[];
  deniedUnexpected?: string[];
  activeDenied?: string[];
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateString(value: unknown, field: string, options: { absolute?: boolean } = {}): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_VALUE_LENGTH) throw new Error(`${field} is too long`);
  if (/\r|\n/.test(value) || value.includes(String.fromCharCode(0))) {
    throw new Error(`${field} contains a forbidden character`);
  }
  if (options.absolute && !isAbsolute(value)) throw new Error(`${field} must be absolute`);
  return value;
}

function validateStringList(
  value: unknown,
  field: string,
  maximum: number,
  options: { absolute?: boolean; toolName?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maximum) throw new Error(`${field} exceeds the ${maximum}-entry limit`);
  const result = value.map((entry, index) => {
    const item = validateString(entry, `${field}[${index}]`, options);
    if (options.toolName && (/\s|,/.test(item) || item.length > 200)) {
      throw new Error(`${field}[${index}] is not a valid bounded tool name`);
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`${field} contains duplicate entries`);
  }
  return result;
}

const MAX_WAIT_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

function validateWaitTimeout(value: unknown, field: string): number | "immediate" {
  if (value === "immediate") return value;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new Error(`${field} must be an integer from 1 to ${MAX_WAIT_TIMEOUT_SECONDS} or "immediate"`);
  }
  return value as number;
}

function validateWaitTimeoutMessage(value: unknown): "none" | "preview" | "full" {
  if (value !== "none" && value !== "preview" && value !== "full") {
    throw new Error("waitTimeoutMessage must be none, preview, or full");
  }
  return value;
}

function validateProfileFields(value: Record<string, unknown>): SubagentLaunchProfile {
  if (value.version !== LAUNCH_PROFILE_VERSION) {
    throw new Error("unsupported launch profile version");
  }
  if (typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking)) {
    throw new Error("thinking is invalid");
  }
  if (value.extensionMode !== "normal" && value.extensionMode !== "explicit") {
    throw new Error("extensionMode must be normal or explicit");
  }
  if (value.agent !== null && typeof value.agent !== "string") {
    throw new Error("agent must be a string or null");
  }

  return {
    version: LAUNCH_PROFILE_VERSION,
    model: validateString(value.model, "model"),
    thinking: value.thinking as ThinkingLevel,
    cwd: validateString(value.cwd, "cwd", { absolute: true }),
    agent: value.agent === null ? null : validateString(value.agent, "agent"),
    toolAllowlist: value.toolAllowlist === null
      ? null
      : validateStringList(value.toolAllowlist, "toolAllowlist", MAX_PROFILE_TOOLS, { toolName: true }),
    deniedTools: validateStringList(value.deniedTools, "deniedTools", MAX_PROFILE_TOOLS, { toolName: true }),
    extensionMode: value.extensionMode,
    extensionEntries: validateStringList(
      value.extensionEntries,
      "extensionEntries",
      MAX_PROFILE_EXTENSIONS,
      { absolute: true },
    ),
    inheritedExtensionEntries: validateStringList(
      value.inheritedExtensionEntries,
      "inheritedExtensionEntries",
      MAX_PROFILE_EXTENSIONS,
      { absolute: true },
    ),
    configRoot: validateString(value.configRoot, "configRoot", { absolute: true }),
    ...(value.allowedChildAgents === undefined
      ? {}
      : {
          allowedChildAgents: value.allowedChildAgents === null
            ? null
            : validateStringList(value.allowedChildAgents, "allowedChildAgents", MAX_PROFILE_TOOLS),
        }),
    ...(value.waitTimeout === undefined
      ? {}
      : {
          waitTimeout: value.waitTimeout === null
            ? null
            : validateWaitTimeout(value.waitTimeout, "waitTimeout"),
        }),
    ...(value.waitTimeoutMessage === undefined
      ? {}
      : { waitTimeoutMessage: validateWaitTimeoutMessage(value.waitTimeoutMessage) }),
  };
}

export function validateLaunchProfile(value: unknown): SubagentLaunchProfile {
  if (!isRecord(value)) throw new Error("launch profile must be an object");
  const allowedKeys = new Set([
    "version",
    "model",
    "thinking",
    "cwd",
    "agent",
    "toolAllowlist",
    "deniedTools",
    "extensionMode",
    "extensionEntries",
    "inheritedExtensionEntries",
    "configRoot",
    "allowedChildAgents",
    "waitTimeout",
    "waitTimeoutMessage",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`launch profile contains unsupported fields: ${unknown.join(", ")}`);
  }
  return validateProfileFields(value);
}

export function getLaunchProfilePath(sessionFile: string): string {
  return `${sessionFile}.profile.json`;
}

export function writeLaunchProfile(sessionFile: string, profile: SubagentLaunchProfile): string {
  const validated = validateLaunchProfile(profile);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROFILE_BYTES) {
    throw new Error(`serialized launch profile exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
  }

  const profilePath = getLaunchProfilePath(sessionFile);
  mkdirSync(dirname(profilePath), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(profilePath),
    `.${process.pid}-${randomBytes(8).toString("hex")}.profile.tmp`,
  );
  try {
    const fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, profilePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
  return profilePath;
}

export function readLaunchProfile(sessionFile: string): LaunchProfileReadResult {
  const path = getLaunchProfilePath(sessionFile);
  let raw: string;
  try {
    raw = readBoundedRegularFile(path, MAX_PROFILE_BYTES, "launch profile");
  } catch (error) {
    if (error instanceof UnsafeFileError && error.code === "missing") {
      return { status: "absent", path };
    }
    return {
      status: "malformed",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    return { status: "loaded", profile: validateLaunchProfile(JSON.parse(raw)), path };
  } catch (error) {
    return {
      status: "malformed",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Build the profile-controlled portion of a resume invocation. */
export function buildResumeProfileLaunch(
  sessionFile: string,
  profile: SubagentLaunchProfile,
): ResumeProfileLaunch {
  const validated = validateLaunchProfile(profile);
  const args = ["pi", "--session", sessionFile];
  if (validated.extensionMode === "explicit") args.push("--no-extensions");
  for (const entry of validated.extensionEntries) args.push("-e", entry);
  args.push("--model", validated.model, "--thinking", validated.thinking);
  if (validated.toolAllowlist) args.push("--tools", validated.toolAllowlist.join(","));

  return {
    cwd: validated.cwd,
    args,
    env: {
      PI_CODING_AGENT_DIR: validated.configRoot,
      PI_DENY_TOOLS: validated.deniedTools.join(","),
      PI_SUBAGENT_ALLOWED_CHILD_AGENTS: JSON.stringify(validated.allowedChildAgents ?? null),
      PI_SUBAGENT_EXTENSION_MODE: validated.extensionMode,
      PI_SUBAGENT_EXTENSIONS: validated.inheritedExtensionEntries.join(","),
      PI_SUBAGENT_AGENT: validated.agent ?? "",
    },
  };
}

function normalizedSet(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function compareToolProfile(
  profile: SubagentLaunchProfile | null,
  actualTools?: string[],
  deniedTools?: string[],
): ToolProfileEvidence {
  const actual = actualTools ? normalizedSet(actualTools) : undefined;
  const actualDenied = deniedTools ? normalizedSet(deniedTools) : undefined;
  if (!profile) {
    return {
      status: "unverified",
      expected: null,
      actual,
      actualDenied,
      reason: "no preserved launch profile was applied",
    };
  }

  const expectedDenied = normalizedSet(profile.deniedTools);
  const expected = profile.toolAllowlist === null
    ? null
    : normalizedSet(profile.toolAllowlist.filter((name) => !expectedDenied.includes(name)));
  if (!actual || !actualDenied) {
    return {
      status: "unverified",
      expected,
      actual,
      expectedDenied,
      actualDenied,
      reason: "child tool and deny telemetry are required",
    };
  }

  const actualSet = new Set(actual);
  const expectedDeniedSet = new Set(expectedDenied);
  const actualDeniedSet = new Set(actualDenied);
  const deniedMissing = expectedDenied.filter((name) => !actualDeniedSet.has(name));
  const deniedUnexpected = actualDenied.filter((name) => !expectedDeniedSet.has(name));
  const activeDenied = actual.filter((name) => expectedDeniedSet.has(name) || actualDeniedSet.has(name));
  if (deniedMissing.length || deniedUnexpected.length || activeDenied.length) {
    return {
      status: "mismatch",
      expected,
      actual,
      expectedDenied,
      actualDenied,
      ...(deniedMissing.length ? { deniedMissing } : {}),
      ...(deniedUnexpected.length ? { deniedUnexpected } : {}),
      ...(activeDenied.length ? { activeDenied } : {}),
    };
  }

  if (expected === null) {
    return { status: "unrestricted", expected: null, actual, expectedDenied, actualDenied };
  }
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));
  return {
    status: missing.length === 0 && unexpected.length === 0 ? "exact" : "mismatch",
    expected,
    actual,
    expectedDenied,
    actualDenied,
    ...(missing.length ? { missing } : {}),
    ...(unexpected.length ? { unexpected } : {}),
  };
}

export function formatToolProfileEvidence(evidence: ToolProfileEvidence): string {
  if (evidence.status === "exact") {
    return `Tool profile: exact (${evidence.actual?.length ?? 0} observed tools match the post-deny launch allowlist).`;
  }
  if (evidence.status === "unrestricted") {
    return `Tool profile: unrestricted (no --tools allowlist after matching deny checks; ${evidence.actual?.length ?? 0} tools observed).`;
  }
  if (evidence.status === "unverified") {
    return `Tool profile: unverified (${evidence.reason ?? "insufficient host evidence"}).`;
  }
  const details = [
    evidence.missing?.length ? `missing=[${evidence.missing.join(", ")}]` : "",
    evidence.unexpected?.length ? `unexpected=[${evidence.unexpected.join(", ")}]` : "",
    evidence.deniedMissing?.length ? `deny-missing=[${evidence.deniedMissing.join(", ")}]` : "",
    evidence.deniedUnexpected?.length ? `deny-unexpected=[${evidence.deniedUnexpected.join(", ")}]` : "",
    evidence.activeDenied?.length ? `denied-active=[${evidence.activeDenied.join(", ")}]` : "",
  ].filter(Boolean).join(" ");
  return `Tool profile: mismatch.${details ? ` ${details}` : ""}`;
}
