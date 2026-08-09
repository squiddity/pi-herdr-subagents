/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { createSubagentActivityRecorder, readSubagentActivityFile } from "./activity.ts";
import {
  publishCompletionSidecar,
  readCompletionControlRequest,
  requestMatchesWaitingTurn,
  type WaitingTurnEvidence,
} from "./interrupt-control.ts";
import { readTrackedDescendants } from "./descendant-registry.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldDeferAutoExitForDescendants(descendantsFile: string | undefined): boolean {
  if (!descendantsFile) return false;
  try {
    return readTrackedDescendants(descendantsFile).length > 0;
  } catch {
    // Fail closed: an unreadable registry must never let an orchestrator
    // abandon descendants whose terminal delivery cannot be ruled out.
    return true;
  }
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function buildCompletionSidecar(messages: any[] | undefined):
  | { type: "done" }
  | { type: "error"; errorMessage: string; stopReason: "error" } {
  const errorInfo = findLatestAssistantError(messages);
  return errorInfo ? { type: "error", ...errorInfo } : { type: "done" };
}

export function getWaitingTurnEvidence(
  messages: any[] | undefined,
  turnIndex: number | undefined,
): WaitingTurnEvidence {
  if (!messages) return { outcome: undefined, hasAssistantText: false, turnIndex };
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const hasAssistantText = Array.isArray(message.content) && message.content.some(
      (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    );
    const outcome = message.stopReason === "aborted"
      ? "aborted" as const
      : message.stopReason === "error"
        ? "error" as const
        : "completed" as const;
    return { outcome, hasAssistantText, turnIndex };
  }
  return { outcome: undefined, hasAssistantText: false, turnIndex };
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const descendantsFile = process.env.PI_SUBAGENT_DESCENDANTS_FILE;
  const runningChildId = process.env.PI_SUBAGENT_ID;
  const activityFile = process.env.PI_SUBAGENT_ACTIVITY_FILE;
  const controlFile = process.env.PI_SUBAGENT_CONTROL_FILE;
  const sessionFile = process.env.PI_SUBAGENT_SESSION;
  const recorder = createSubagentActivityRecorder({
    runningChildId,
    activityFile,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let latestAgentMessages: any[] | undefined;
  let currentTurnIndex: number | undefined;
  let waitingEvidence: WaitingTurnEvidence = {
    outcome: undefined,
    hasAssistantText: false,
    turnIndex: undefined,
  };
  let controlInterval: ReturnType<typeof setInterval> | null = null;
  let completionAccepted = false;

  function descendantsAllowCompletion(): boolean {
    if (!descendantsFile) return true;
    try {
      return readTrackedDescendants(descendantsFile).length === 0;
    } catch {
      return false;
    }
  }

  function pollCompletionControl(ctx: { shutdown(): void }): void {
    if (
      completionAccepted ||
      !controlFile ||
      !sessionFile ||
      !runningChildId ||
      !activityFile
    ) return;

    const control = readCompletionControlRequest(controlFile, runningChildId);
    if (!control.ok) return;
    const activity = readSubagentActivityFile(activityFile, runningChildId);
    if (!activity.ok) return;
    if (!requestMatchesWaitingTurn(control.request, activity.activity, waitingEvidence)) return;
    if (!descendantsAllowCompletion()) return;

    completionAccepted = true;
    try {
      publishCompletionSidecar(sessionFile, {
        type: "done",
        runningChildId,
        requestId: control.request.requestId,
      });
    } catch {
      completionAccepted = false;
      return;
    }
    recorder.subagentDone();
    ctx.shutdown();
  }

  // Show widget + status bar on session start. Active tools are captured later
  // at before_agent_start, after every startup handler has run.
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
    if (controlFile && !controlInterval) {
      controlInterval = setInterval(() => pollCompletionControl(ctx), 100);
    }
  });

  pi.on("input", () => {
    waitingEvidence = { outcome: undefined, hasAssistantText: false, turnIndex: currentTurnIndex };
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    waitingEvidence = { outcome: undefined, hasAssistantText: false, turnIndex: currentTurnIndex };
    toolNames = pi.getActiveTools().slice().sort();
    recorder.toolTelemetry(toolNames, denied);
    recorder.beforeAgentStart();
    renderWidget(ctx, null);
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    // agent_end is not terminal: Pi may compact and automatically retry after
    // this event. Keep the latest result and waiting evidence, but do not
    // publish completion or shut down until agent_settled confirms no
    // continuation will run.
    latestAgentMessages = (event as any).messages as any[] | undefined;
    waitingEvidence = getWaitingTurnEvidence(latestAgentMessages, currentTurnIndex);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const shouldExit = autoExit
      && !shouldDeferAutoExitForDescendants(descendantsFile)
      && shouldAutoExitOnAgentEnd(userTookOver, latestAgentMessages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      if (sessionFile) {
        try {
          publishCompletionSidecar(sessionFile, {
            ...buildCompletionSidecar(latestAgentMessages),
            ...(runningChildId ? { runningChildId } : {}),
          });
        } catch {
          // Best effort — the watcher can still detect the terminal sentinel
          // after shutdown if the completion sidecar cannot be written.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    // Only settled output is eligible for parent-driven completion or waiting
    // timeout notifications. agent_end may still be followed by automatic
    // compaction or retry.
    recorder.agentEndWaiting({
      outcome: waitingEvidence.outcome ?? "error",
      hasAssistantText: waitingEvidence.hasAssistantText,
    });

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest settled agent run completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    currentTurnIndex = (event as any).turnIndex;
    waitingEvidence = { outcome: undefined, hasAssistantText: false, turnIndex: currentTurnIndex };
    recorder.turnStart(currentTurnIndex);
  });

  pi.on("turn_end", (event) => {
    currentTurnIndex = (event as any).turnIndex;
    recorder.turnEnd(currentTurnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("message_end", (event) => {
    recorder.messageEnd((event as any).message);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    if (controlInterval) {
      clearInterval(controlInterval);
      controlInterval = null;
    }
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      publishCompletionSidecar(sessionFile, {
        ...exitData,
        ...(runningChildId ? { runningChildId } : {}),
      });

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (descendantsFile) {
        const descendants = readTrackedDescendants(descendantsFile);
        if (descendants.length > 0) {
          const summary = descendants
            .map((child) => `${child.name} [${child.id}]`)
            .join(", ");
          throw new Error(`Cannot complete while tracked descendants remain: ${summary}`);
        }
      }
      recorder.subagentDone();
      if (sessionFile) {
        publishCompletionSidecar(sessionFile, {
          type: "done",
          ...(runningChildId ? { runningChildId } : {}),
        });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
