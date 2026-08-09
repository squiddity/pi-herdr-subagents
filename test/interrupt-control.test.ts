import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteJson,
  createCompletionControlRequest,
  isSafelyWaitingForCompletion,
  publishCompletionSidecar,
  readCompletionControlRequest,
  requestMatchesWaitingTurn,
  type WaitingTurnEvidence,
} from "../pi-extension/subagents/interrupt-control.ts";
import { getWaitingTurnEvidence } from "../pi-extension/subagents/subagent-done.ts";
import type { SubagentActivityState } from "../pi-extension/subagents/activity.ts";

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagent-control-test-"));
}

function activity(overrides: Partial<SubagentActivityState> = {}): SubagentActivityState {
  return {
    version: 1,
    runningChildId: "child-1",
    createdAt: 1_000,
    updatedAt: 2_000,
    sequence: 7,
    latestEvent: "agent_end",
    phase: "waiting",
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
    turnIndex: 3,
    waitingSince: 2_000,
    lastTurnOutcome: "completed",
    lastTurnHasAssistantText: true,
    ...overrides,
  };
}

function evidence(overrides: Partial<WaitingTurnEvidence> = {}): WaitingTurnEvidence {
  return {
    outcome: "completed",
    hasAssistantText: true,
    turnIndex: 3,
    ...overrides,
  };
}

describe("interrupt control", () => {
  it("validates exact child and generation bindings", () => {
    const request = createCompletionControlRequest({
      runningChildId: "child-1",
      activity: activity(),
      requestId: "request-1",
      requestedAt: 3_000,
    });

    assert.equal(requestMatchesWaitingTurn(request, activity(), evidence()), true);
    assert.equal(requestMatchesWaitingTurn(request, activity({ sequence: 8 }), evidence()), false);
    assert.equal(requestMatchesWaitingTurn(request, activity({ turnIndex: 4 }), evidence({ turnIndex: 4 })), false);
    assert.equal(requestMatchesWaitingTurn(request, activity(), evidence({ outcome: "aborted" })), false);
    assert.equal(requestMatchesWaitingTurn(request, activity(), evidence({ hasAssistantText: false })), false);
    assert.equal(requestMatchesWaitingTurn({ ...request, runningChildId: "other" }, activity(), evidence()), false);
  });

  it("accepts only a completed content-bearing waiting snapshot", () => {
    assert.equal(isSafelyWaitingForCompletion(activity()), true);
    assert.equal(isSafelyWaitingForCompletion(activity({ phase: "active" })), false);
    assert.equal(isSafelyWaitingForCompletion(activity({ turnActive: true })), false);
    assert.equal(isSafelyWaitingForCompletion(activity({ lastTurnOutcome: "aborted" })), false);
    assert.equal(isSafelyWaitingForCompletion(activity({ lastTurnHasAssistantText: false })), false);
    assert.equal(isSafelyWaitingForCompletion(activity({ lastTurnOutcome: undefined })), false);
  });

  it("round-trips bounded control requests and rejects wrong or malformed files", () => {
    const dir = createTestDir();
    try {
      const controlFile = join(dir, "control.json");
      const request = createCompletionControlRequest({ runningChildId: "child-1", activity: activity() });
      atomicWriteJson(controlFile, request);
      assert.deepEqual(readCompletionControlRequest(controlFile, "child-1"), { ok: true, request });
      assert.deepEqual(readCompletionControlRequest(controlFile, "child-2"), { ok: false, reason: "wrong-id" });

      writeFileSync(controlFile, JSON.stringify({ ...request, expectedActivitySequence: -1 }));
      const malformed = readCompletionControlRequest(controlFile, "child-1");
      assert.equal(malformed.ok, false);
      assert.equal(malformed.reason, "invalid");

      rmSync(controlFile);
      const missing = readCompletionControlRequest(controlFile, "child-1");
      assert.deepEqual(missing, { ok: false, reason: "missing" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes completion sidecars atomically with restrictive permissions", () => {
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "session.jsonl");
      publishCompletionSidecar(sessionFile, {
        type: "done",
        runningChildId: "child-1",
        requestId: "request-1",
      });
      const exitFile = `${sessionFile}.exit`;
      assert.equal(existsSync(exitFile), true);
      assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), {
        type: "done",
        runningChildId: "child-1",
        requestId: "request-1",
      });
      assert.equal(statSync(exitFile).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives waiting evidence only from the latest assistant turn", () => {
    assert.deepEqual(getWaitingTurnEvidence([
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }] },
      { role: "toolResult", content: [] },
      { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
    ], 8), {
      outcome: "aborted",
      hasAssistantText: true,
      turnIndex: 8,
    });
    assert.deepEqual(getWaitingTurnEvidence([
      { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "only thinking" }] },
    ], 2), {
      outcome: "completed",
      hasAssistantText: false,
      turnIndex: 2,
    });
    assert.deepEqual(getWaitingTurnEvidence(undefined, undefined), {
      outcome: undefined,
      hasAssistantText: false,
      turnIndex: undefined,
    });
  });

  it("preserves completion safety across 5,000 raced traces", () => {
    for (let seed = 1; seed <= 5_000; seed++) {
      let current = activity();
      let currentEvidence = evidence();
      let request: ReturnType<typeof createCompletionControlRequest> | null = null;
      let delivered = 0;

      for (let step = 0; step < 40; step++) {
        switch ((seed * 17 + step * 31) % 7) {
          case 0:
            if (isSafelyWaitingForCompletion(current)) {
              request = createCompletionControlRequest({
                runningChildId: "child-1",
                activity: current,
                requestId: `r-${seed}-${step}`,
                requestedAt: step,
              });
            }
            break;
          case 1:
            current = activity({
              sequence: current.sequence + 1,
              phase: "active",
              latestEvent: "input",
              agentActive: true,
              turnActive: true,
              lastTurnOutcome: undefined,
              lastTurnHasAssistantText: undefined,
            });
            currentEvidence = evidence({ outcome: undefined, hasAssistantText: false });
            break;
          case 2:
            current = activity({ sequence: current.sequence + 1, turnIndex: (current.turnIndex ?? 0) + 1 });
            currentEvidence = evidence({ turnIndex: current.turnIndex });
            break;
          case 3:
            current = activity({ sequence: current.sequence + 1, lastTurnOutcome: "aborted" });
            currentEvidence = evidence({ outcome: "aborted" });
            break;
          default: {
            const accepted = request != null && requestMatchesWaitingTurn(request, current, currentEvidence);
            if (accepted) {
              delivered++;
              request = null;
            }
          }
        }
        assert.ok(delivered <= 1, `duplicate delivery in seed ${seed}`);
        if (delivered > 0) break;
      }
    }
  });
});
