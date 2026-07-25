import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBoundedRegularFile, UnsafeFileError } from "./safe-file.ts";

export type SubagentActivityPhase = "starting" | "active" | "waiting" | "done";
export type SubagentActivityScope = "agent" | "turn" | "provider" | "streaming" | "tool";

export type SubagentActivityEvent =
  | "session_start"
  | "tool_telemetry"
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "before_provider_request"
  | "after_provider_response"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_call"
  | "tool_execution_update"
  | "tool_result"
  | "tool_execution_end"
  | "caller_ping"
  | "subagent_done"
  | "session_shutdown";

export interface SubagentUsageCost {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
}

export interface SubagentUsageTotals {
  version: 1;
  sessions: number;
  turns: number;
  responses: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cost: SubagentUsageCost;
}

export interface SubagentModelUsage {
  version: 1;
  provider: string;
  model: string;
  responses: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cost: SubagentUsageCost;
}

export interface SubagentActivityState {
  version: 1;
  runningChildId: string;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  latestEvent: SubagentActivityEvent;
  phase: SubagentActivityPhase;
  usage: SubagentUsageTotals;
  usageByModel: SubagentModelUsage[];
  agentActive: boolean;
  turnActive: boolean;
  providerActive: boolean;
  toolActive: boolean;
  activeScope?: SubagentActivityScope;
  activeSince?: number;
  waitingSince?: number;
  turnIndex?: number;
  messageEventType?: string;
  toolCallId?: string;
  toolName?: string;
  toolStartedAt?: number;
  toolEndedAt?: number;
  /** Active callable tool names captured after child session startup handlers. */
  actualTools?: string[];
  /** Policy deny names exported by the host for this child. */
  deniedTools?: string[];
}

export type ActivityReadResult =
  | { ok: true; activity: SubagentActivityState }
  | { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export type SubagentShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface SubagentActivityRecorder {
  sessionStart(actualTools?: string[], deniedTools?: string[]): void;
  toolTelemetry(actualTools: string[], deniedTools: string[]): void;
  messageEnd(message: unknown): void;
  input(): void;
  beforeAgentStart(): void;
  agentStart(): void;
  agentEndWaiting(): void;
  agentEndDone(): void;
  turnStart(turnIndex?: number): void;
  turnEnd(turnIndex?: number): void;
  beforeProviderRequest(): void;
  afterProviderResponse(): void;
  messageUpdate(messageEventType?: string): void;
  toolExecutionStart(toolCallId?: string, toolName?: string): void;
  toolCall(toolCallId?: string, toolName?: string): void;
  toolExecutionUpdate(toolCallId?: string, toolName?: string): void;
  toolResult(toolCallId?: string, toolName?: string): void;
  toolExecutionEnd(toolCallId?: string, toolName?: string): void;
  callerPing(): void;
  subagentDone(): void;
  sessionShutdown(reason: SubagentShutdownReason): void;
}

const ACTIVITY_UPDATE_THROTTLE_MS = 500;
const MAX_WRITE_FAILURES = 3;
const KNOWN_PHASES = new Set<SubagentActivityPhase>(["starting", "active", "waiting", "done"]);
const KNOWN_SCOPES = new Set<SubagentActivityScope>(["agent", "turn", "provider", "streaming", "tool"]);
const KNOWN_EVENTS = new Set<SubagentActivityEvent>([
  "session_start",
  "tool_telemetry",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "before_provider_request",
  "after_provider_response",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "caller_ping",
  "subagent_done",
  "session_shutdown",
]);
const MAX_ACTIVITY_STRING_LENGTH = 200;
const MAX_ACTIVITY_TOOL_NAMES = 256;
const MAX_ACTIVITY_MODEL_USAGES = 64;
const MAX_USAGE_IDENTIFIER_LENGTH = 200;
export const MAX_ACTIVITY_FILE_BYTES = 128 * 1024;

export function getSubagentActivityFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}

function requireObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isFinite(object[fieldName]) ? null : `${fieldName} must be finite`;
}

function validateOptionalFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isFinite(value) ? null : `${fieldName} must be finite when present`;
}

function validateInteger(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isInteger(object[fieldName]) ? null : `${fieldName} must be an integer`;
}

function validateOptionalInteger(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isInteger(value) ? null : `${fieldName} must be an integer when present`;
}

function validateBoolean(object: Record<string, unknown>, fieldName: string): string | null {
  return typeof object[fieldName] === "boolean" ? null : `${fieldName} must be a boolean`;
}

function validateOptionalActivityString(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  if (value == null) return null;
  if (typeof value !== "string") return `${fieldName} must be a string when present`;
  if (/\r|\n/.test(value)) return `${fieldName} must not contain newlines`;
  return value.length <= MAX_ACTIVITY_STRING_LENGTH ? null : `${fieldName} is too long`;
}

function validateOptionalToolNames(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  if (value == null) return null;
  if (!Array.isArray(value)) return `${fieldName} must be an array when present`;
  if (value.length > MAX_ACTIVITY_TOOL_NAMES) return `${fieldName} has too many entries`;
  const names = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_ACTIVITY_STRING_LENGTH ||
      /\s|,|\r|\n/.test(entry)
    ) return `${fieldName} contains an invalid tool name`;
    if (names.has(entry)) return `${fieldName} contains duplicate tool names`;
    names.add(entry);
  }
  return null;
}

function normalizeToolNames(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const names = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_ACTIVITY_STRING_LENGTH ||
      /\s|,|\r|\n/.test(value)
    ) return undefined;
    names.add(value);
    if (names.size > MAX_ACTIVITY_TOOL_NAMES) return undefined;
  }
  return [...names].sort();
}

function validateUsageIdentifier(value: unknown, fieldName: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_USAGE_IDENTIFIER_LENGTH || /\r|\n/.test(value)) {
    return `${fieldName} must be a non-empty bounded string`;
  }
  return null;
}

function validateUsageNumber(value: unknown, fieldName: string, integer: boolean): string | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    return `${fieldName} must be a non-negative ${integer ? "integer" : "finite number"} or null`;
  }
  return null;
}

function validateUsageCost(value: unknown, fieldName: string): string | null {
  const object = requireObject(value);
  if (!object) return `${fieldName} must be an object`;
  return ["input", "output", "cacheRead", "cacheWrite", "total"]
    .map((key) => validateUsageNumber(object[key], `${fieldName}.${key}`, false))
    .find((error) => error != null) ?? null;
}

function validateUsage(value: unknown, fieldName = "usage"): string | null {
  const object = requireObject(value);
  if (!object) return `${fieldName} must be an object`;
  if (object.version !== 1) return `${fieldName}.version must be 1`;

  const countError = ["sessions", "turns", "responses"]
    .map((key) => validateUsageNumber(object[key], `${fieldName}.${key}`, true))
    .find((error) => error != null);
  if (countError) return countError;

  const tokenError = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]
    .map((key) => validateUsageNumber(object[key], `${fieldName}.${key}`, true))
    .find((error) => error != null);
  if (tokenError) return tokenError;

  const costError = validateUsageCost(object.cost, `${fieldName}.cost`);
  if (costError) return costError;

  return null;
}

function validateUsageByModel(value: unknown, fieldName = "usageByModel"): string | null {
  if (!Array.isArray(value)) return `${fieldName} must be an array`;
  if (value.length > MAX_ACTIVITY_MODEL_USAGES) return `${fieldName} has too many entries`;
  for (const [index, modelUsage] of value.entries()) {
    const modelObject = requireObject(modelUsage);
    if (!modelObject) return `${fieldName}[${index}] must be an object`;
    const providerError = validateUsageIdentifier(modelObject.provider, `${fieldName}[${index}].provider`);
    if (providerError) return providerError;
    const modelError = validateUsageIdentifier(modelObject.model, `${fieldName}[${index}].model`);
    if (modelError) return modelError;
    if (modelObject.version !== 1) return `${fieldName}[${index}].version must be 1`;
    const responseError = validateUsageNumber(modelObject.responses, `${fieldName}[${index}].responses`, true);
    if (responseError) return responseError;
    const tokenError = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]
      .map((key) => validateUsageNumber(modelObject[key], `${fieldName}[${index}].${key}`, true))
      .find((error) => error != null);
    if (tokenError) return tokenError;
    const costError = validateUsageCost(modelObject.cost, `${fieldName}[${index}].cost`);
    if (costError) return costError;
  }
  return null;
}

function invalidActivity(error: string): ActivityReadResult {
  return { ok: false, reason: "invalid", error };
}

function validateActivity(value: unknown, expectedRunningChildId: string): ActivityReadResult {
  const object = requireObject(value);
  if (!object) return invalidActivity("activity must be an object");
  if (object.version !== 1) return invalidActivity("unsupported activity version");
  if (typeof object.runningChildId !== "string") return invalidActivity("runningChildId must be a string");
  if (object.runningChildId !== expectedRunningChildId) return { ok: false, reason: "wrong-id" };
  if (typeof object.latestEvent !== "string" || !KNOWN_EVENTS.has(object.latestEvent as SubagentActivityEvent)) {
    return invalidActivity("unknown latestEvent");
  }
  if (typeof object.phase !== "string" || !KNOWN_PHASES.has(object.phase as SubagentActivityPhase)) {
    return invalidActivity("unknown activity phase");
  }
  if (
    object.activeScope != null &&
    (typeof object.activeScope !== "string" || !KNOWN_SCOPES.has(object.activeScope as SubagentActivityScope))
  ) {
    return invalidActivity("unknown activeScope");
  }

  const validationError = [
    object.usage == null ? null : validateUsage(object.usage),
    object.usageByModel == null ? null : validateUsageByModel(object.usageByModel),
    validateFiniteNumber(object, "createdAt"),
    validateFiniteNumber(object, "updatedAt"),
    validateInteger(object, "sequence"),
    validateBoolean(object, "agentActive"),
    validateBoolean(object, "turnActive"),
    validateBoolean(object, "providerActive"),
    validateBoolean(object, "toolActive"),
    validateOptionalFiniteNumber(object, "activeSince"),
    validateOptionalFiniteNumber(object, "waitingSince"),
    validateOptionalInteger(object, "turnIndex"),
    validateOptionalFiniteNumber(object, "toolStartedAt"),
    validateOptionalFiniteNumber(object, "toolEndedAt"),
    validateOptionalActivityString(object, "messageEventType"),
    validateOptionalActivityString(object, "toolCallId"),
    validateOptionalActivityString(object, "toolName"),
    validateOptionalToolNames(object, "actualTools"),
    validateOptionalToolNames(object, "deniedTools"),
  ].find((error) => error != null);
  if (validationError) return invalidActivity(validationError);

  return { ok: true, activity: object as unknown as SubagentActivityState };
}

export function readSubagentActivityFile(
  activityFile: string,
  expectedRunningChildId: string,
): ActivityReadResult {
  let parsed: unknown;
  try {
    const raw = readBoundedRegularFile(activityFile, MAX_ACTIVITY_FILE_BYTES, "subagent activity");
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof UnsafeFileError && error.code === "missing") {
      return { ok: false, reason: "missing" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid", error: message };
  }

  return validateActivity(parsed, expectedRunningChildId);
}

export function writeSubagentActivityFile(activityFile: string, activity: SubagentActivityState): void {
  const dir = dirname(activityFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = join(dir, `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.tmp`);

  try {
    const serialized = `${JSON.stringify(activity)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_ACTIVITY_FILE_BYTES) {
      throw new Error(`serialized activity exceeds the ${MAX_ACTIVITY_FILE_BYTES}-byte limit`);
    }
    writeFileSync(tempFile, serialized, "utf8");
    renameSync(tempFile, activityFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      // Temp cleanup is best effort; preserve the original write/rename failure
      void cleanupError;
    }
    throw error;
  }
}

function emptyUsage(): SubagentUsageTotals {
  return {
    version: 1,
    sessions: 0,
    turns: 0,
    responses: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cost: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: null,
    },
  };
}

function addUsageNumber(target: Record<string, any>, fieldName: string, value: unknown, integer: boolean): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) return;
  target[fieldName] = target[fieldName] == null ? value : target[fieldName] + value;
}

function addUsageFields(target: SubagentUsageTotals | SubagentModelUsage, rawUsage: Record<string, unknown>): void {
  addUsageNumber(target, "inputTokens", rawUsage.input, true);
  addUsageNumber(target, "outputTokens", rawUsage.output, true);
  addUsageNumber(target, "cacheReadTokens", rawUsage.cacheRead, true);
  addUsageNumber(target, "cacheWriteTokens", rawUsage.cacheWrite, true);
  addUsageNumber(target, "reasoningTokens", rawUsage.reasoning, true);
  addUsageNumber(target, "totalTokens", rawUsage.totalTokens, true);

  const rawCost = requireObject(rawUsage.cost);
  if (!rawCost) return;
  addUsageNumber(target.cost, "input", rawCost.input, false);
  addUsageNumber(target.cost, "output", rawCost.output, false);
  addUsageNumber(target.cost, "cacheRead", rawCost.cacheRead, false);
  addUsageNumber(target.cost, "cacheWrite", rawCost.cacheWrite, false);
  addUsageNumber(target.cost, "total", rawCost.total, false);
}

function cloneUsage(usage: SubagentUsageTotals | undefined): SubagentUsageTotals {
  if (!usage) return emptyUsage();
  return {
    version: 1,
    sessions: usage.sessions,
    turns: usage.turns,
    responses: usage.responses,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function cloneModelUsage(usage: SubagentModelUsage): SubagentModelUsage {
  return { ...usage, cost: { ...usage.cost } };
}

function recordAssistantUsage(
  usage: SubagentUsageTotals,
  usageByModel: SubagentModelUsage[],
  message: unknown,
): void {
  const object = requireObject(message);
  if (object?.role !== "assistant") return;

  usage.responses += 1;
  const rawUsage = requireObject(object.usage);
  if (rawUsage) addUsageFields(usage, rawUsage);

  const provider = object.provider;
  const model = object.model;
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    !provider ||
    !model ||
    provider.length > MAX_USAGE_IDENTIFIER_LENGTH ||
    model.length > MAX_USAGE_IDENTIFIER_LENGTH ||
    /\r|\n/.test(provider) ||
    /\r|\n/.test(model)
  ) return;
  let modelUsage = usageByModel.find((entry) => entry.provider === provider && entry.model === model);
  if (!modelUsage) {
    if (usageByModel.length >= MAX_ACTIVITY_MODEL_USAGES) return;
    modelUsage = {
      version: 1,
      provider,
      model,
      responses: 0,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      cost: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
    };
    usageByModel.push(modelUsage);
  }
  modelUsage.responses += 1;
  if (rawUsage) addUsageFields(modelUsage, rawUsage);
}

function createNoopRecorder(): SubagentActivityRecorder {
  return {
    sessionStart() {},
    toolTelemetry() {},
    messageEnd() {},
    input() {},
    beforeAgentStart() {},
    agentStart() {},
    agentEndWaiting() {},
    agentEndDone() {},
    turnStart() {},
    turnEnd() {},
    beforeProviderRequest() {},
    afterProviderResponse() {},
    messageUpdate() {},
    toolExecutionStart() {},
    toolCall() {},
    toolExecutionUpdate() {},
    toolResult() {},
    toolExecutionEnd() {},
    callerPing() {},
    subagentDone() {},
    sessionShutdown() {},
  };
}

function clearActiveState(activity: SubagentActivityState): void {
  activity.agentActive = false;
  activity.turnActive = false;
  activity.providerActive = false;
  activity.toolActive = false;
  delete activity.activeScope;
  delete activity.activeSince;
}

function refreshActiveScope(activity: SubagentActivityState): void {
  if (activity.toolActive) {
    activity.phase = "active";
    activity.activeScope = "tool";
    return;
  }
  if (activity.providerActive) {
    activity.phase = "active";
    activity.activeScope = "provider";
    return;
  }
  if (activity.turnActive) {
    activity.phase = "active";
    activity.activeScope = "turn";
    return;
  }
  if (activity.agentActive) {
    activity.phase = "active";
    activity.activeScope = "agent";
    return;
  }
  delete activity.activeScope;
  delete activity.activeSince;
}

function markActive(
  activity: SubagentActivityState,
  scope: SubagentActivityScope,
  now: number,
  resetActiveSince = false,
): void {
  activity.phase = "active";
  activity.activeScope = scope;
  if (activity.activeSince == null || resetActiveSince) activity.activeSince = now;
  delete activity.waitingSince;
}

export function createSubagentActivityRecorder(params: {
  runningChildId?: string;
  activityFile?: string;
  now?: () => number;
}): SubagentActivityRecorder {
  const runningChildId = params.runningChildId?.trim();
  const activityFile = params.activityFile?.trim();
  if (!runningChildId || !activityFile) return createNoopRecorder();

  const now = params.now ?? (() => Date.now());
  const createdAt = now();
  const previous = readSubagentActivityFile(activityFile, runningChildId);
  const activity: SubagentActivityState = {
    version: 1,
    runningChildId,
    createdAt,
    updatedAt: createdAt,
    sequence: 0,
    latestEvent: "session_start",
    phase: "starting",
    usage: cloneUsage(previous.ok ? previous.activity.usage : undefined),
    usageByModel: previous.ok ? previous.activity.usageByModel?.map(cloneModelUsage) ?? [] : [],
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
  };

  let disabled = false;
  let failureCount = 0;
  let lastFlushAt = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  function clearPendingFlush(): void {
    if (!pendingFlush) return;
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }

  function disable(): void {
    disabled = true;
    clearPendingFlush();
  }

  function flushNow(): void {
    if (disabled) return;
    try {
      writeSubagentActivityFile(activityFile, activity);
      lastFlushAt = now();
      failureCount = 0;
    } catch {
      failureCount += 1;
      if (failureCount >= MAX_WRITE_FAILURES) disable();
    }
  }

  function scheduleFlush(): void {
    if (disabled || pendingFlush) return;

    const remainingMs = Math.max(0, ACTIVITY_UPDATE_THROTTLE_MS - (now() - lastFlushAt));
    if (remainingMs === 0) {
      flushNow();
      return;
    }

    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      flushNow();
    }, remainingMs);
  }

  function record(
    latestEvent: SubagentActivityEvent,
    update: (current: SubagentActivityState, now: number) => void,
    flush: "immediate" | "throttled",
  ): void {
    if (disabled) return;
    if (flush === "immediate") clearPendingFlush();

    const observedAt = now();
    activity.latestEvent = latestEvent;
    activity.updatedAt = observedAt;
    activity.sequence += 1;
    update(activity, observedAt);

    if (flush === "immediate") flushNow();
    else scheduleFlush();
  }

  function markDone(latestEvent: SubagentActivityEvent): void {
    record(latestEvent, (current) => {
      current.phase = "done";
      clearActiveState(current);
      delete current.waitingSince;
    }, "immediate");
    disable();
  }

  return {
    sessionStart(actualTools, deniedTools) {
      record("session_start", (current) => {
        current.phase = "starting";
        current.usage.sessions += 1;
        clearActiveState(current);
        delete current.waitingSince;
        const normalizedActual = normalizeToolNames(actualTools);
        const normalizedDenied = normalizeToolNames(deniedTools);
        if (normalizedActual) current.actualTools = normalizedActual;
        if (normalizedDenied) current.deniedTools = normalizedDenied;
      }, "immediate");
    },
    toolTelemetry(actualTools, deniedTools) {
      record("tool_telemetry", (current) => {
        const normalizedActual = normalizeToolNames(actualTools);
        const normalizedDenied = normalizeToolNames(deniedTools);
        if (normalizedActual) current.actualTools = normalizedActual;
        else delete current.actualTools;
        if (normalizedDenied) current.deniedTools = normalizedDenied;
        else delete current.deniedTools;
      }, "immediate");
    },
    messageEnd(message) {
      record("message_end", (current) => {
        recordAssistantUsage(current.usage, current.usageByModel, message);
      }, "immediate");
    },
    input() {
      record("input", () => {}, "immediate");
    },
    beforeAgentStart() {
      record("before_agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentStart() {
      record("agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentEndWaiting() {
      record("agent_end", (current, observedAt) => {
        clearActiveState(current);
        current.phase = "waiting";
        current.waitingSince = observedAt;
      }, "immediate");
    },
    agentEndDone() {
      markDone("agent_end");
    },
    turnStart(turnIndex) {
      record("turn_start", (current, observedAt) => {
        current.usage.turns += 1;
        current.agentActive = true;
        current.turnActive = true;
        if (turnIndex != null) current.turnIndex = turnIndex;
        markActive(current, current.toolActive || current.providerActive ? current.activeScope ?? "turn" : "turn", observedAt);
      }, "immediate");
    },
    turnEnd(turnIndex) {
      record("turn_end", (current) => {
        current.turnActive = false;
        current.providerActive = false;
        current.toolActive = false;
        if (turnIndex != null) current.turnIndex = turnIndex;
        refreshActiveScope(current);
      }, "immediate");
    },
    beforeProviderRequest() {
      record("before_provider_request", (current, observedAt) => {
        current.providerActive = true;
        markActive(current, "provider", observedAt, true);
      }, "immediate");
    },
    afterProviderResponse() {
      record("after_provider_response", (current) => {
        current.providerActive = false;
        refreshActiveScope(current);
      }, "immediate");
    },
    messageUpdate(messageEventType) {
      record("message_update", (current, observedAt) => {
        current.agentActive = true;
        current.turnActive = true;
        current.messageEventType = messageEventType;
        if (!current.toolActive) markActive(current, "streaming", observedAt);
      }, "throttled");
    },
    toolExecutionStart(toolCallId, toolName) {
      record("tool_execution_start", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId;
        current.toolName = toolName;
        current.toolStartedAt = observedAt;
        markActive(current, "tool", observedAt, true);
      }, "immediate");
    },
    toolCall(toolCallId, toolName) {
      record("tool_call", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "immediate");
    },
    toolExecutionUpdate(toolCallId, toolName) {
      record("tool_execution_update", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "throttled");
    },
    toolResult(toolCallId, toolName) {
      record("tool_result", (current) => {
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        refreshActiveScope(current);
      }, "immediate");
    },
    toolExecutionEnd(toolCallId, toolName) {
      record("tool_execution_end", (current, observedAt) => {
        current.toolActive = false;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        current.toolEndedAt = observedAt;
        refreshActiveScope(current);
      }, "immediate");
    },
    callerPing() {
      markDone("caller_ping");
    },
    subagentDone() {
      markDone("subagent_done");
    },
    sessionShutdown(reason) {
      if (reason === "quit") markDone("session_shutdown");
      else disable();
    },
  };
}
