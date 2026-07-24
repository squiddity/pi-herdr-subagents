import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ThinkingLevel } from "./runtime-routing.ts";
import type { ExtensionMode } from "./extension-runtime.ts";
import {
  readBoundedRegularFile,
  readRegularFilePrefix,
  UnsafeFileError,
} from "./safe-file.ts";

export const LAUNCH_PROFILE_VERSION = 1 as const;
export const MAX_PROFILE_TOOLS = 256;
export const MAX_PROFILE_EXTENSIONS = 64;
export const MAX_PROFILE_BYTES = 128 * 1024;
export const PROFILE_ATTESTATION_CUSTOM_TYPE = "pi-herdr-subagents.launch-profile-attestation";
const MAX_VALUE_LENGTH = 4096;
const MAX_ATTESTATION_SCAN_BYTES = 1024 * 1024;
const PROFILE_KEY_BYTES = 32;
const PROFILE_KEY_FILE_BYTES = PROFILE_KEY_BYTES * 2 + 1;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const NONCE_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

export interface LaunchProfileAttestation {
  nonce: string;
  signature: string;
}

/** Credential- and prompt-free settings needed to reproduce a Pi child launch. */
export interface UnsignedSubagentLaunchProfile {
  version: typeof LAUNCH_PROFILE_VERSION;
  model: string;
  thinking: ThinkingLevel;
  cwd: string;
  /** Named agent key used by the recursive same-agent guard, or null. */
  agent: string | null;
  /** Exact value represented by --tools, or null when Pi tool loading had no allowlist. */
  toolAllowlist: string[] | null;
  deniedTools: string[];
  extensionMode: ExtensionMode;
  /** Exact absolute entries passed with -e on the original launch. */
  extensionEntries: string[];
  /** Absolute caller entries exported for recursive descendants. */
  inheritedExtensionEntries: string[];
  configRoot: string;
  /** Exact named child profiles allowed by the host-resolved parent profile. */
  allowedChildAgents?: string[] | null;
}

export interface SubagentLaunchProfile extends UnsignedSubagentLaunchProfile {
  /** Host HMAC bound to the absolute session path and all profile fields. */
  attestation: LaunchProfileAttestation;
}

export type LaunchProfileReadResult =
  | { status: "verified"; profile: SubagentLaunchProfile; path: string }
  | { status: "absent"; path: string }
  | { status: "malformed"; path: string; error: string }
  | { status: "untrusted"; path: string; error: string };

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

export function getLaunchProfilePath(sessionFile: string): string {
  return `${sessionFile}.profile.json`;
}

export function getHostAttestationKeyPath(): string {
  return process.env.PI_SUBAGENT_PROFILE_KEY_FILE ??
    join(homedir(), ".pi", "agent", ".subagent-profile-attestation.key");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateString(value: unknown, field: string, options: { absolute?: boolean } = {}): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
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
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicate entries`);
  return result;
}

function validateUnsignedFields(value: Record<string, unknown>): UnsignedSubagentLaunchProfile {
  if (value.version !== LAUNCH_PROFILE_VERSION) throw new Error("unsupported launch profile version");
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
  };
}

export function validateUnsignedLaunchProfile(value: unknown): UnsignedSubagentLaunchProfile {
  if (!isRecord(value)) throw new Error("launch profile must be an object");
  const allowedKeys = new Set([
    "version", "model", "thinking", "cwd", "agent", "toolAllowlist", "deniedTools",
    "extensionMode", "extensionEntries", "inheritedExtensionEntries", "configRoot", "allowedChildAgents",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`launch profile contains unsupported fields: ${unknown.join(", ")}`);
  return validateUnsignedFields(value);
}

export function validateLaunchProfile(value: unknown): SubagentLaunchProfile {
  if (!isRecord(value)) throw new Error("launch profile must be an object");
  const allowedKeys = new Set([
    "version", "model", "thinking", "cwd", "agent", "toolAllowlist", "deniedTools",
    "extensionMode", "extensionEntries", "inheritedExtensionEntries", "configRoot", "allowedChildAgents", "attestation",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`launch profile contains unsupported fields: ${unknown.join(", ")}`);
  const unsigned = validateUnsignedFields(value);
  if (!isRecord(value.attestation)) throw new Error("attestation must be an object");
  const attestationKeys = Object.keys(value.attestation);
  if (attestationKeys.some((key) => key !== "nonce" && key !== "signature")) {
    throw new Error("attestation contains unsupported fields");
  }
  const nonce = validateString(value.attestation.nonce, "attestation.nonce");
  const signature = validateString(value.attestation.signature, "attestation.signature");
  if (!NONCE_PATTERN.test(nonce)) throw new Error("attestation.nonce is invalid");
  if (!SIGNATURE_PATTERN.test(signature)) throw new Error("attestation.signature is invalid");
  return { ...unsigned, attestation: { nonce, signature } };
}

function signaturePayload(sessionFile: string, profile: UnsignedSubagentLaunchProfile, nonce: string): string {
  return [
    "pi-herdr-subagents-launch-profile-v1",
    resolve(sessionFile),
    nonce,
    JSON.stringify(profile),
  ].join("\0");
}

function calculateSignature(
  sessionFile: string,
  profile: UnsignedSubagentLaunchProfile,
  nonce: string,
  key: Buffer,
): string {
  return createHmac("sha256", key).update(signaturePayload(sessionFile, profile, nonce)).digest("hex");
}

export function attestLaunchProfile(
  sessionFile: string,
  profile: UnsignedSubagentLaunchProfile,
  key: Buffer,
  nonce = randomBytes(32).toString("hex"),
): SubagentLaunchProfile {
  if (key.length !== PROFILE_KEY_BYTES) throw new Error(`profile attestation key must be ${PROFILE_KEY_BYTES} bytes`);
  if (!NONCE_PATTERN.test(nonce)) throw new Error("profile attestation nonce is invalid");
  const validated = validateUnsignedLaunchProfile(profile);
  return {
    ...validated,
    attestation: {
      nonce,
      signature: calculateSignature(sessionFile, validated, nonce, key),
    },
  };
}

export function formatLaunchProfileAttestation(profile: SubagentLaunchProfile): string {
  return JSON.stringify({
    version: LAUNCH_PROFILE_VERSION,
    nonce: profile.attestation.nonce,
    signature: profile.attestation.signature,
  });
}

export function parseLaunchProfileAttestation(value: string | undefined): LaunchProfileAttestation | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== LAUNCH_PROFILE_VERSION) return null;
    if (typeof parsed.nonce !== "string" || !NONCE_PATTERN.test(parsed.nonce)) return null;
    if (typeof parsed.signature !== "string" || !SIGNATURE_PATTERN.test(parsed.signature)) return null;
    return { nonce: parsed.nonce, signature: parsed.signature };
  } catch {
    return null;
  }
}

export function loadOrCreateHostAttestationKey(path = getHostAttestationKeyPath()): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const temporaryPath = join(dirname(path), `.${process.pid}-${randomBytes(8).toString("hex")}.key.tmp`);
    const keyText = `${randomBytes(PROFILE_KEY_BYTES).toString("hex")}\n`;
    try {
      writeFileSync(temporaryPath, keyText, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        linkSync(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      try { unlinkSync(temporaryPath); } catch {}
    }
  }

  const raw = readBoundedRegularFile(path, PROFILE_KEY_FILE_BYTES, "profile attestation key");
  const mode = lstatSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("profile attestation key permissions must not allow group or other access");
  }
  const hex = raw.trim();
  if (!NONCE_PATTERN.test(hex)) throw new Error("profile attestation key is malformed");
  return Buffer.from(hex, "hex");
}

export function writeLaunchProfile(sessionFile: string, profile: SubagentLaunchProfile): string {
  const validated = validateLaunchProfile(profile);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > MAX_PROFILE_BYTES) {
    throw new Error(`serialized launch profile exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
  }

  const profilePath = getLaunchProfilePath(sessionFile);
  mkdirSync(dirname(profilePath), { recursive: true });
  const temporaryPath = join(
    dirname(profilePath),
    `.${process.pid}-${randomBytes(8).toString("hex")}.profile.tmp`,
  );
  try {
    const fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, profilePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  return profilePath;
}

function signatureMatches(
  sessionFile: string,
  profile: SubagentLaunchProfile,
  key: Buffer,
): boolean {
  if (key.length !== PROFILE_KEY_BYTES) return false;
  const { attestation, ...unsigned } = profile;
  const expected = Buffer.from(calculateSignature(sessionFile, unsigned, attestation.nonce, key), "hex");
  const actual = Buffer.from(attestation.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionContainsAttestation(
  sessionFile: string,
  attestation: LaunchProfileAttestation,
): boolean {
  const prefix = readRegularFilePrefix(
    sessionFile,
    MAX_ATTESTATION_SCAN_BYTES,
    "subagent session",
  );
  for (const line of prefix.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry?.type === "custom" &&
        entry.customType === PROFILE_ATTESTATION_CUSTOM_TYPE &&
        entry.data?.version === LAUNCH_PROFILE_VERSION &&
        entry.data?.nonce === attestation.nonce &&
        entry.data?.signature === attestation.signature
      ) return true;
    } catch {
      // Other malformed or truncated session lines cannot establish provenance.
    }
  }
  return false;
}

export function readLaunchProfile(sessionFile: string, key: Buffer): LaunchProfileReadResult {
  const path = getLaunchProfilePath(sessionFile);
  let raw: string;
  try {
    raw = readBoundedRegularFile(path, MAX_PROFILE_BYTES, "launch profile");
  } catch (error) {
    if (error instanceof UnsafeFileError && error.code === "missing") return { status: "absent", path };
    return { status: "malformed", path, error: error instanceof Error ? error.message : String(error) };
  }

  let profile: SubagentLaunchProfile;
  try {
    profile = validateLaunchProfile(JSON.parse(raw));
  } catch (error) {
    return { status: "malformed", path, error: error instanceof Error ? error.message : String(error) };
  }

  if (!signatureMatches(sessionFile, profile, key)) {
    return { status: "untrusted", path, error: "launch profile host signature does not match" };
  }
  try {
    if (!sessionContainsAttestation(sessionFile, profile.attestation)) {
      return { status: "untrusted", path, error: "launch profile attestation is absent from the bound session metadata" };
    }
  } catch (error) {
    return { status: "untrusted", path, error: error instanceof Error ? error.message : String(error) };
  }
  return { status: "verified", profile, path };
}

/** Build the profile-controlled portion of a resume invocation without shell quoting. */
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
      PI_SUBAGENT_PROFILE_ATTESTATION: formatLaunchProfileAttestation(validated),
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
      reason: "no host-verified launch profile was applied",
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
    return `Tool profile: unrestricted (no --tools allowlist after verified deny checks; ${evidence.actual?.length ?? 0} tools observed).`;
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
