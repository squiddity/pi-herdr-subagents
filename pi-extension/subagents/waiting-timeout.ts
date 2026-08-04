import type { SubagentActivityState } from "./activity.ts";

/** Maximum configured timeout and snooze values, in seconds. */
export const WAIT_TIMEOUT_MAX_SECONDS = 7 * 24 * 60 * 60;
export const WAIT_TIMEOUT_MAX_SNOOZE_SECONDS = 24 * 60 * 60;
export const WAIT_TIMEOUT_DEFAULT_MESSAGE: WaitTimeoutMessagePolicy = "preview";
export const WAIT_TIMEOUT_PREVIEW_MAX_CHARS = 800;
export const WAIT_TIMEOUT_FULL_MAX_CHARS = 4_000;
export const WAIT_TIMEOUT_MESSAGE_MAX_BYTES = 8 * 1024;
export const WAIT_TIMEOUT_NOTIFICATION_MAX_CHARS = 9_000;
export const WAIT_TIMEOUT_NOTIFICATION_MAX_BYTES = 16 * 1024;

export type WaitTimeoutMessagePolicy = "none" | "preview" | "full";
export type WaitTimeoutSetting = number | "immediate" | null;
export type WaitingTimeoutNotificationKind = "initial" | "snooze";

export interface WaitingGeneration {
  runningChildId: string;
  activitySequence: number;
  turnIndex: number | null;
  waitingSince: number;
}

export interface WaitingTimeoutState {
  generation: WaitingGeneration | null;
  /** The initial configured deadline. Null means no automatic deadline. */
  dueAt: number | null;
  /** True once the initial notification has been successfully emitted. */
  notified: boolean;
  /** A single replacement deadline scheduled by subagent_snooze. */
  snoozeDueAt: number | null;
}

export interface WaitingTimeoutAdvance {
  state: WaitingTimeoutState;
  due: WaitingTimeoutNotificationKind | null;
}

export function normalizeWaitTimeoutSeconds(value: unknown): WaitTimeoutSetting | undefined {
  if (value === null || value === "off") return null;
  if (value === "immediate") return "immediate";
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > WAIT_TIMEOUT_MAX_SECONDS) {
    return undefined;
  }
  return value as number;
}

export function normalizeSnoozeSeconds(value: unknown): number | undefined {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > WAIT_TIMEOUT_MAX_SNOOZE_SECONDS) {
    return undefined;
  }
  return value as number;
}

function cloneGeneration(generation: WaitingGeneration | null): WaitingGeneration | null {
  return generation ? { ...generation } : null;
}

export function createWaitingTimeoutState(generation: WaitingGeneration | null = null): WaitingTimeoutState {
  return {
    generation: cloneGeneration(generation),
    dueAt: null,
    notified: false,
    snoozeDueAt: null,
  };
}

export function getWaitingGeneration(
  activity: Pick<SubagentActivityState, "runningChildId" | "sequence" | "turnIndex" | "phase" | "waitingSince" | "agentActive" | "turnActive" | "providerActive" | "toolActive"> | null | undefined,
): WaitingGeneration | null {
  if (!activity || activity.phase !== "waiting") return null;
  if (activity.agentActive || activity.turnActive || activity.providerActive || activity.toolActive) return null;
  if (typeof activity.runningChildId !== "string" || !Number.isInteger(activity.sequence)) return null;
  const waitingSince = Number.isFinite(activity.waitingSince) ? activity.waitingSince! : Date.now();
  return {
    runningChildId: activity.runningChildId,
    activitySequence: activity.sequence,
    turnIndex: activity.turnIndex ?? null,
    waitingSince,
  };
}

export function sameWaitingGeneration(
  left: WaitingGeneration | null | undefined,
  right: WaitingGeneration | null | undefined,
): boolean {
  return !!left && !!right &&
    left.runningChildId === right.runningChildId &&
    left.activitySequence === right.activitySequence &&
    left.turnIndex === right.turnIndex;
}

function resetForGeneration(
  generation: WaitingGeneration,
  timeoutSeconds: WaitTimeoutSetting,
): WaitingTimeoutState {
  return {
    generation: cloneGeneration(generation),
    dueAt: typeof timeoutSeconds === "number" ? generation.waitingSince + timeoutSeconds * 1000 : null,
    notified: false,
    snoozeDueAt: null,
  };
}

/**
 * Advance the one-shot state machine using an activity snapshot. This is pure:
 * successful delivery is acknowledged separately, so a sendMessage failure
 * remains retryable. A non-waiting snapshot invalidates all snoozes.
 */
export function advanceWaitingTimeout(
  previous: WaitingTimeoutState | undefined,
  activity: Pick<SubagentActivityState, "runningChildId" | "sequence" | "turnIndex" | "phase" | "waitingSince" | "agentActive" | "turnActive" | "providerActive" | "toolActive"> | null | undefined,
  timeoutSeconds: WaitTimeoutSetting,
  now: number,
): WaitingTimeoutAdvance {
  const state = previous ?? createWaitingTimeoutState();
  const generation = getWaitingGeneration(activity);
  if (!generation) return { state: createWaitingTimeoutState(), due: null };

  let next = state;
  if (!sameWaitingGeneration(state.generation, generation)) {
    next = resetForGeneration(generation, timeoutSeconds);
  } else if (next.dueAt == null && !next.notified && typeof timeoutSeconds === "number") {
    // A state may be created by reload hydration or by a snooze-capable runtime
    // before the configured timeout is applied. Arm the initial deadline once.
    next = {
      ...next,
      generation: cloneGeneration(generation),
      dueAt: generation.waitingSince + timeoutSeconds * 1000,
    };
  }

  if (next.snoozeDueAt != null && now >= next.snoozeDueAt) {
    return { state: { ...next, generation: cloneGeneration(generation) }, due: "snooze" };
  }
  // Immediate mode deliberately becomes due only while this parent-side
  // observation is advancing a newly observed waiting generation. The child
  // activity writer never sends a steer synchronously from agent_end.
  if (!next.notified && timeoutSeconds === "immediate") {
    return { state: { ...next, generation: cloneGeneration(generation) }, due: "initial" };
  }
  if (!next.notified && next.dueAt != null && now >= next.dueAt) {
    return { state: { ...next, generation: cloneGeneration(generation) }, due: "initial" };
  }
  return { state: { ...next, generation: cloneGeneration(generation) }, due: null };
}

export function markWaitingTimeoutNotificationSent(
  state: WaitingTimeoutState,
  generation: WaitingGeneration,
  kind: WaitingTimeoutNotificationKind,
): WaitingTimeoutState {
  if (!sameWaitingGeneration(state.generation, generation)) return state;
  return kind === "initial"
    ? { ...state, generation: cloneGeneration(generation), notified: true }
    : { ...state, generation: cloneGeneration(generation), snoozeDueAt: null };
}

/** Schedule exactly one replacement notification for the current generation. */
export function scheduleWaitingSnooze(
  state: WaitingTimeoutState | undefined,
  generation: WaitingGeneration,
  now: number,
  seconds: number,
): WaitingTimeoutState {
  const current = state && sameWaitingGeneration(state.generation, generation)
    ? state
    : resetForGeneration(generation, null);
  return {
    ...current,
    generation: cloneGeneration(generation),
    // A snooze replaces the initial deadline rather than creating a second
    // reminder. The deadline is cleared only after successful emission.
    notified: true,
    snoozeDueAt: now + seconds * 1000,
  };
}

export function cancelWaitingSnooze(
  state: WaitingTimeoutState | undefined,
  generation: WaitingGeneration,
): { state: WaitingTimeoutState; cancelled: boolean } {
  if (!state || !sameWaitingGeneration(state.generation, generation) || state.snoozeDueAt == null) {
    return { state: state ?? createWaitingTimeoutState(generation), cancelled: false };
  }
  return {
    state: { ...state, generation: cloneGeneration(generation), snoozeDueAt: null },
    cancelled: true,
  };
}

function cappedText(value: string, maxChars: number, maxBytes: number): { text: string; truncated: boolean } {
  const marker = " … [truncated]";
  if (value.length <= maxChars && Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }

  const markerFits = marker.length <= maxChars && Buffer.byteLength(marker, "utf8") <= maxBytes;
  const suffix = markerFits ? marker : "";
  let result = "";
  for (const char of Array.from(value)) {
    if (result.length + char.length + suffix.length > maxChars) break;
    if (Buffer.byteLength(result + char + suffix, "utf8") > maxBytes) break;
    result += char;
  }
  return { text: `${result}${suffix}`, truncated: true };
}

export function capWaitingText(value: string, maxChars: number, maxBytes: number): string {
  return cappedText(value, maxChars, maxBytes).text;
}

export function formatWaitingTimeoutNotification(params: {
  name: string;
  elapsedSeconds: number;
  generation: WaitingGeneration;
  messagePolicy: WaitTimeoutMessagePolicy;
  latestMessage?: string | null;
  descendantCount?: number;
  descendantRegistryReadable?: boolean;
  safelyCompletable?: boolean;
}): string {
  const elapsed = Math.max(0, Math.floor(params.elapsedSeconds));
  const lines = [
    `Subagent "${params.name}" is still waiting (${elapsed}s) on child ${params.generation.runningChildId}, activity sequence ${params.generation.activitySequence}, turn ${params.generation.turnIndex ?? "unknown"}.`,
    params.descendantRegistryReadable === false
      ? "The descendant registry is unreadable, so completion remains fail-closed."
      : params.descendantCount && params.descendantCount > 0
        ? `Tracked descendants remain (${params.descendantCount}); completion will stay fail-closed until they finish.`
        : "No active turn was interrupted and no Escape was sent.",
  ];

  if (params.messagePolicy !== "none" && params.latestMessage?.trim()) {
    const limit = params.messagePolicy === "preview" ? WAIT_TIMEOUT_PREVIEW_MAX_CHARS : WAIT_TIMEOUT_FULL_MAX_CHARS;
    const message = capWaitingText(params.latestMessage.trim(), limit, WAIT_TIMEOUT_MESSAGE_MAX_BYTES);
    lines.push(`Latest final assistant message (${params.messagePolicy}):\n${message}`);
  }

  lines.push(
    params.safelyCompletable
      ? `You may accept the waiting answer with subagent_interrupt({ id: ${JSON.stringify(params.generation.runningChildId)} }), or snooze one additional notification with subagent_snooze({ id: ${JSON.stringify(params.generation.runningChildId)}, seconds: 60 }).`
      : `This waiting turn is not currently safe to accept automatically. You may snooze one additional notification with subagent_snooze({ id: ${JSON.stringify(params.generation.runningChildId)}, seconds: 60 }) while deciding how to intervene.`,
  );
  return capWaitingText(lines.join("\n\n"), WAIT_TIMEOUT_NOTIFICATION_MAX_CHARS, WAIT_TIMEOUT_NOTIFICATION_MAX_BYTES);
}
