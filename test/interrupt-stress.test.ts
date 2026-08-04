import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCompletionControlRequest,
  isSafelyWaitingForCompletion,
  requestMatchesWaitingTurn,
  type CompletionControlRequest,
  type WaitingTurnEvidence,
} from "../pi-extension/subagents/interrupt-control.ts";

function activity(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    runningChildId: "stress-child",
    createdAt: 0,
    updatedAt: 0,
    sequence: 1,
    latestEvent: "agent_end" as const,
    phase: "waiting" as const,
    usage: undefined as any,
    usageByModel: [],
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
    turnIndex: 1,
    waitingSince: 0,
    lastTurnOutcome: "completed" as const,
    lastTurnHasAssistantText: true,
    ...overrides,
  } as any;
}

function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value;
  };
}

describe("interrupt completion stress", () => {
  it("preserves completion safety and exactly-once delivery across 5,000 raced traces", () => {
    for (let seed = 1; seed <= 5_000; seed++) {
      const random = rng(seed);
      let snapshot = activity();
      let evidence: WaitingTurnEvidence = {
        outcome: "completed",
        hasAssistantText: true,
        turnIndex: 1,
      };
      let request: CompletionControlRequest | null = null;
      let descendants = 0;
      let delivered = 0;

      for (let step = 0; step < 40; step++) {
        switch (random() % 7) {
          case 0: // Parent asks the current safe waiting generation to complete.
            if (isSafelyWaitingForCompletion(snapshot)) {
              request = createCompletionControlRequest({
                runningChildId: "stress-child",
                activity: snapshot,
                requestedAt: step,
                requestId: `r-${seed}-${step}`,
              });
            }
            break;
          case 1: // A new input wins the race and invalidates every old request.
            snapshot = activity({
              sequence: snapshot.sequence + 1,
              updatedAt: step,
              phase: "active",
              latestEvent: "input",
              agentActive: true,
              turnActive: true,
              lastTurnOutcome: undefined,
              lastTurnHasAssistantText: undefined,
            });
            evidence = { outcome: undefined, hasAssistantText: false, turnIndex: snapshot.turnIndex };
            break;
          case 2: { // The newer turn completes normally.
            const nextTurn = (snapshot.turnIndex ?? 0) + 1;
            snapshot = activity({ sequence: snapshot.sequence + 1, updatedAt: step, turnIndex: nextTurn });
            evidence = { outcome: "completed", hasAssistantText: true, turnIndex: nextTurn };
            break;
          }
          case 3: // Escape produces an aborted turn with possibly misleading partial text.
            snapshot = activity({
              sequence: snapshot.sequence + 1,
              updatedAt: step,
              lastTurnOutcome: "aborted",
              lastTurnHasAssistantText: true,
            });
            evidence = { outcome: "aborted", hasAssistantText: true, turnIndex: snapshot.turnIndex };
            break;
          case 4:
            descendants++;
            break;
          case 5:
            descendants = Math.max(0, descendants - 1);
            break;
          case 6: { // Child control poll.
            const accepted = request != null &&
              descendants === 0 &&
              requestMatchesWaitingTurn(request, snapshot, evidence);
            if (accepted) {
              delivered++;
              request = null;
            }
            break;
          }
        }

        assert.ok(delivered <= 1, `seed ${seed}: duplicate delivery`);
        if (delivered > 0) break;
      }
    }
  });

  it("rejects every stale generation in a high-volume sequence barrier sweep", () => {
    const base = activity({ sequence: 100, turnIndex: 9 });
    const request = createCompletionControlRequest({
      runningChildId: "stress-child",
      activity: base,
      requestedAt: 1,
      requestId: "barrier",
    });
    for (let delta = 1; delta <= 25_000; delta++) {
      const newer = activity({ sequence: 100 + delta, turnIndex: 9 + (delta % 3) });
      assert.equal(requestMatchesWaitingTurn(request, newer, {
        outcome: "completed",
        hasAssistantText: true,
        turnIndex: newer.turnIndex,
      }), false);
    }
  });
});
