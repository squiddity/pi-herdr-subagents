import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WAIT_TIMEOUT_MAX_SECONDS,
  WAIT_TIMEOUT_MAX_SNOOZE_SECONDS,
  advanceWaitingTimeout,
  cancelWaitingSnooze,
  capWaitingText,
  createWaitingTimeoutState,
  formatWaitingTimeoutNotification,
  getWaitingGeneration,
  markWaitingTimeoutNotificationSent,
  normalizeSnoozeSeconds,
  normalizeWaitTimeoutSeconds,
  sameWaitingGeneration,
  scheduleWaitingSnooze,
} from "../pi-extension/subagents/waiting-timeout.ts";

function activity(overrides: Record<string, unknown> = {}) {
  return {
    runningChildId: "child-1",
    sequence: 4,
    turnIndex: 2,
    phase: "waiting",
    waitingSince: 1_000,
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
    ...overrides,
  } as any;
}

describe("waiting-timeout", () => {
  it("normalizes bounded timeout and snooze settings, including off", () => {
    assert.equal(normalizeWaitTimeoutSeconds("off"), null);
    assert.equal(normalizeWaitTimeoutSeconds(null), null);
    assert.equal(normalizeWaitTimeoutSeconds("immediate"), "immediate");
    assert.equal(normalizeWaitTimeoutSeconds(1), 1);
    assert.equal(normalizeWaitTimeoutSeconds(WAIT_TIMEOUT_MAX_SECONDS), WAIT_TIMEOUT_MAX_SECONDS);
    assert.equal(normalizeWaitTimeoutSeconds(0), undefined);
    assert.equal(normalizeWaitTimeoutSeconds(WAIT_TIMEOUT_MAX_SECONDS + 1), undefined);
    assert.equal(normalizeSnoozeSeconds(1), 1);
    assert.equal(normalizeSnoozeSeconds(WAIT_TIMEOUT_MAX_SNOOZE_SECONDS + 1), undefined);
  });

  it("binds generation identity to child, sequence, and turn", () => {
    const first = getWaitingGeneration(activity());
    assert.ok(first);
    assert.equal(sameWaitingGeneration(first, getWaitingGeneration(activity())), true);
    assert.equal(sameWaitingGeneration(first, getWaitingGeneration(activity({ sequence: 5 }))), false);
    assert.equal(sameWaitingGeneration(first, getWaitingGeneration(activity({ turnIndex: 3 }))), false);
    assert.equal(sameWaitingGeneration(first, getWaitingGeneration(activity({ runningChildId: "child-2" }))), false);
    assert.equal(getWaitingGeneration(activity({ phase: "active" })), null);
  });

  it("arms immediate mode on the first parent observation only", () => {
    const generation = getWaitingGeneration(activity())!;
    let state = createWaitingTimeoutState();

    let advanced = advanceWaitingTimeout(state, activity(), "immediate", 1_000);
    assert.equal(advanced.due, "initial");
    state = advanced.state;

    // A failed send leaves the same generation retryable, but a successful
    // acknowledgement suppresses duplicate observations.
    assert.equal(advanceWaitingTimeout(state, activity(), "immediate", 1_001).due, "initial");
    state = markWaitingTimeoutNotificationSent(state, generation, "initial");
    assert.equal(advanceWaitingTimeout(state, activity(), "immediate", 1_002).due, null);

    // Activity resumption clears the old generation; its next waiting turn
    // arms a fresh immediate notification.
    const resumed = activity({ phase: "active", sequence: 5, agentActive: true, turnActive: true });
    const cleared = advanceWaitingTimeout(state, resumed, "immediate", 2_000);
    assert.equal(cleared.state.generation, null);
    const nextGeneration = activity({ sequence: 6, turnIndex: 3, waitingSince: 2_001 });
    assert.equal(advanceWaitingTimeout(cleared.state, nextGeneration, "immediate", 2_001).due, "initial");
  });

  it("lets an acknowledged immediate notification be replaced by one snooze", () => {
    const snapshot = activity();
    const generation = getWaitingGeneration(snapshot)!;
    let advanced = advanceWaitingTimeout(undefined, snapshot, "immediate", 1_000);
    let state = markWaitingTimeoutNotificationSent(advanced.state, generation, "initial");
    state = scheduleWaitingSnooze(state, generation, 2_000, 5);

    assert.equal(advanceWaitingTimeout(state, snapshot, "immediate", 6_999).due, null);
    advanced = advanceWaitingTimeout(state, snapshot, "immediate", 7_000);
    assert.equal(advanced.due, "snooze");
    state = markWaitingTimeoutNotificationSent(advanced.state, generation, "snooze");
    assert.equal(advanceWaitingTimeout(state, snapshot, "immediate", 100_000).due, null);
  });

  it("retries a due notification until delivery is acknowledged", () => {
    const generation = getWaitingGeneration(activity())!;
    let state = createWaitingTimeoutState(generation);
    let advanced = advanceWaitingTimeout(state, activity(), 10, 10_999);
    assert.equal(advanced.due, null);
    advanced = advanceWaitingTimeout(state, activity(), 10, 11_000);
    assert.equal(advanced.due, "initial");
    state = advanced.state;
    assert.equal(advanceWaitingTimeout(state, activity(), 10, 11_001).due, "initial");
    state = markWaitingTimeoutNotificationSent(state, generation, "initial");
    assert.equal(advanceWaitingTimeout(state, activity(), 10, 99_999).due, null);
  });

  it("schedules one replacement snooze and cancels it", () => {
    const generation = getWaitingGeneration(activity())!;
    let state = createWaitingTimeoutState(generation);
    state = scheduleWaitingSnooze(state, generation, 5_000, 2);
    assert.equal(advanceWaitingTimeout(state, activity(), 10, 6_999).due, null);
    assert.equal(advanceWaitingTimeout(state, activity(), 10, 7_000).due, "snooze");
    const cancelled = cancelWaitingSnooze(state, generation);
    assert.equal(cancelled.cancelled, true);
    assert.equal(advanceWaitingTimeout(cancelled.state, activity(), 10, 100_000).due, null);
    assert.equal(cancelWaitingSnooze(cancelled.state, generation).cancelled, false);
  });

  it("invalidates old state when activity resumes or changes generation", () => {
    const generation = getWaitingGeneration(activity())!;
    const state = createWaitingTimeoutState(generation);
    assert.equal(advanceWaitingTimeout(state, activity({ phase: "active", agentActive: true }), 10, 20_000).due, null);
    const changed = activity({ sequence: 5 });
    const advanced = advanceWaitingTimeout(state, changed, 10, 2_000);
    assert.equal(advanced.state.generation?.activitySequence, 5);
    assert.equal(advanced.state.notified, false);
  });

  it("caps final notification text by characters and bytes and preserves truncation marker", () => {
    const generation = getWaitingGeneration(activity())!;
    const notification = formatWaitingTimeoutNotification({
      name: "Worker\nname",
      elapsedSeconds: 125,
      generation,
      messagePolicy: "preview",
      latestMessage: "x".repeat(2_000),
      safelyCompletable: true,
    });
    assert.ok(notification.length <= 9_000);
    assert.ok(Buffer.byteLength(notification) <= 16 * 1024);
    assert.match(notification, /truncated/);
    const tiny = capWaitingText("abcdef", 4, 4);
    assert.ok(tiny.length <= 4);
    assert.ok(Buffer.byteLength(tiny) <= 4);
  });

  it("stress-tests immediate delivery across 10,000 deterministic generations", () => {
    for (let seed = 1; seed <= 10_000; seed++) {
      const generation = getWaitingGeneration(activity({
        runningChildId: `child-${seed}`,
        sequence: seed,
        turnIndex: seed % 11,
      }))!;
      let state = createWaitingTimeoutState();
      const first = advanceWaitingTimeout(state, activity({
        runningChildId: generation.runningChildId,
        sequence: generation.activitySequence,
        turnIndex: generation.turnIndex,
      }), "immediate", seed);
      assert.equal(first.due, "initial", `seed ${seed}: immediate notification did not arm`);
      state = markWaitingTimeoutNotificationSent(first.state, generation, "initial");
      assert.equal(
        advanceWaitingTimeout(state, activity({
          runningChildId: generation.runningChildId,
          sequence: generation.activitySequence,
          turnIndex: generation.turnIndex,
        }), "immediate", seed + 1).due,
        null,
        `seed ${seed}: duplicate immediate notification`,
      );
    }
  });

  it("stress-tests one-shot delivery across 10,000 deterministic raced traces", () => {
    function randomFor(seed: number) {
      let value = seed >>> 0;
      return () => {
        value = (Math.imul(value, 1103515245) + 12345) >>> 0;
        return value;
      };
    }

    for (let seed = 1; seed <= 10_000; seed++) {
      const random = randomFor(seed);
      let snapshot = activity();
      let state = createWaitingTimeoutState();
      let now = 1_000;
      let snoozeSerial = 0;
      let activeSnoozeSerial: number | null = null;
      const deliveredInitial = new Set<string>();
      const deliveredSnoozes = new Set<number>();

      for (let step = 0; step < 30; step++) {
        now += random() % 2_000;
        switch (random() % 6) {
          case 0:
            snapshot = activity({
              sequence: snapshot.sequence + 1,
              turnIndex: (snapshot.turnIndex ?? 0) + 1,
              waitingSince: now,
            });
            activeSnoozeSerial = null;
            break;
          case 1:
            snapshot = activity({
              sequence: snapshot.sequence + 1,
              phase: "active",
              waitingSince: undefined,
              agentActive: true,
              turnActive: true,
            });
            activeSnoozeSerial = null;
            break;
          case 2: {
            const generation = getWaitingGeneration(snapshot);
            if (generation) {
              snoozeSerial += 1;
              activeSnoozeSerial = snoozeSerial;
              state = scheduleWaitingSnooze(state, generation, now, 1 + (random() % 10));
            }
            break;
          }
          case 3: {
            const generation = getWaitingGeneration(snapshot);
            if (generation) {
              state = cancelWaitingSnooze(state, generation).state;
              activeSnoozeSerial = null;
            }
            break;
          }
        }

        const advanced = advanceWaitingTimeout(state, snapshot, 5, now);
        state = advanced.state;
        if (!advanced.due) continue;
        const generation = getWaitingGeneration(snapshot);
        assert.ok(generation, `seed ${seed}: notification without a waiting generation`);
        assert.equal(sameWaitingGeneration(state.generation, generation), true);
        if (advanced.due === "initial") {
          const key = `${generation.runningChildId}:${generation.activitySequence}:${generation.turnIndex}`;
          assert.equal(deliveredInitial.has(key), false, `seed ${seed}: duplicate initial notification`);
          deliveredInitial.add(key);
        } else {
          assert.notEqual(activeSnoozeSerial, null, `seed ${seed}: snooze notification without schedule`);
          assert.equal(deliveredSnoozes.has(activeSnoozeSerial!), false, `seed ${seed}: duplicate snooze notification`);
          deliveredSnoozes.add(activeSnoozeSerial!);
          activeSnoozeSerial = null;
        }
        state = markWaitingTimeoutNotificationSent(state, generation, advanced.due);
      }
    }
  });
});
