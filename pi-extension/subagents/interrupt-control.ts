import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SubagentActivityState } from "./activity.ts";
import { readBoundedRegularFile, UnsafeFileError } from "./safe-file.ts";

export const INTERRUPT_CONTROL_VERSION = 1;
export const MAX_INTERRUPT_CONTROL_BYTES = 16 * 1024;

export interface CompletionControlRequest {
  version: 1;
  operation: "complete-waiting";
  requestId: string;
  runningChildId: string;
  expectedActivitySequence: number;
  expectedTurnIndex: number | null;
  requestedAt: number;
}

export type CompletionControlReadResult =
  | { ok: true; request: CompletionControlRequest }
  | { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export interface WaitingTurnEvidence {
  outcome: "completed" | "aborted" | "error" | undefined;
  hasAssistantText: boolean;
  turnIndex: number | undefined;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

function parseCompletionControlRequest(
  value: unknown,
  expectedRunningChildId: string,
): CompletionControlReadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid", error: "completion control request must be an object" };
  }
  const request = value as Record<string, unknown>;
  if (request.version !== INTERRUPT_CONTROL_VERSION || request.operation !== "complete-waiting") {
    return { ok: false, reason: "invalid", error: "unsupported completion control request" };
  }
  if (request.runningChildId !== expectedRunningChildId) {
    return { ok: false, reason: "wrong-id" };
  }
  if (!isRequestId(request.requestId)) {
    return { ok: false, reason: "invalid", error: "invalid completion control request id" };
  }
  if (!Number.isInteger(request.expectedActivitySequence) || (request.expectedActivitySequence as number) < 0) {
    return { ok: false, reason: "invalid", error: "invalid expected activity sequence" };
  }
  if (
    request.expectedTurnIndex !== null &&
    (!Number.isInteger(request.expectedTurnIndex) || (request.expectedTurnIndex as number) < 0)
  ) {
    return { ok: false, reason: "invalid", error: "invalid expected turn index" };
  }
  if (!Number.isFinite(request.requestedAt)) {
    return { ok: false, reason: "invalid", error: "invalid completion request timestamp" };
  }
  return { ok: true, request: request as unknown as CompletionControlRequest };
}

export function readCompletionControlRequest(
  controlFile: string,
  expectedRunningChildId: string,
): CompletionControlReadResult {
  try {
    const raw = readBoundedRegularFile(
      controlFile,
      MAX_INTERRUPT_CONTROL_BYTES,
      "subagent completion control",
    );
    return parseCompletionControlRequest(JSON.parse(raw), expectedRunningChildId);
  } catch (error) {
    if (error instanceof UnsafeFileError && error.code === "missing") {
      return { ok: false, reason: "missing" };
    }
    return {
      ok: false,
      reason: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
  try {
    const serialized = `${JSON.stringify(value)}\n`;
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

export function createCompletionControlRequest(params: {
  runningChildId: string;
  activity: SubagentActivityState;
  requestedAt?: number;
  requestId?: string;
}): CompletionControlRequest {
  return {
    version: INTERRUPT_CONTROL_VERSION,
    operation: "complete-waiting",
    requestId: params.requestId ?? randomUUID(),
    runningChildId: params.runningChildId,
    expectedActivitySequence: params.activity.sequence,
    expectedTurnIndex: params.activity.turnIndex ?? null,
    requestedAt: params.requestedAt ?? Date.now(),
  };
}

export function isSafelyWaitingForCompletion(activity: SubagentActivityState): boolean {
  return (
    activity.phase === "waiting" &&
    !activity.agentActive &&
    !activity.turnActive &&
    !activity.providerActive &&
    !activity.toolActive &&
    activity.lastTurnOutcome === "completed" &&
    activity.lastTurnHasAssistantText === true
  );
}

export function requestMatchesWaitingTurn(
  request: CompletionControlRequest,
  activity: SubagentActivityState,
  localEvidence: WaitingTurnEvidence,
): boolean {
  return (
    request.runningChildId === activity.runningChildId &&
    request.expectedActivitySequence === activity.sequence &&
    request.expectedTurnIndex === (activity.turnIndex ?? null) &&
    isSafelyWaitingForCompletion(activity) &&
    localEvidence.outcome === "completed" &&
    localEvidence.hasAssistantText &&
    localEvidence.turnIndex === activity.turnIndex
  );
}

export function publishCompletionSidecar(
  sessionFile: string,
  payload: Record<string, unknown>,
): void {
  atomicWriteJson(`${sessionFile}.exit`, payload);
}

export function completionControlFileExists(controlFile: string): boolean {
  return existsSync(controlFile);
}
