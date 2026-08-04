import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
  cleanupSubagentsForShutdown,
  prepareSubagentWatcher,
  selectCompletionApi,
  shouldDeliverSubagentCompletion,
  shouldPreserveSubagentsOnShutdown,
} from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  findLastAssistantMessage,
  findObservedSessionRuntime,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";

import { isHerdrAvailable, __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import {
  loadModelConfig,
  parseModelConfig,
  resolveModelDefault,
} from "../pi-extension/subagents/model-config.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  MAX_ACTIVITY_FILE_BYTES,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  childDescendantRegistryPath,
  parentDescendantRegistryPath,
  registerDescendant,
  unregisterDescendant,
} from "../pi-extension/subagents/descendant-registry.ts";
import subagentDoneExtension, {
  shouldMarkUserTookOver,
  shouldDeferAutoExitForDescendants,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  buildCompletionSidecar,
  getWaitingTurnEvidence,
} from "../pi-extension/subagents/subagent-done.ts";
import {
  atomicWriteJson,
  createCompletionControlRequest,
  isSafelyWaitingForCompletion,
  readCompletionControlRequest,
  requestMatchesWaitingTurn,
} from "../pi-extension/subagents/interrupt-control.ts";
import { interpretExitSidecar, waitForCompletion } from "../pi-extension/subagents/completion.ts";
import {
  createLifecycle,
  lifecycleTransition,
  markCompleted,
  markCompletionDetected,
  markFailed,
  markInterruptRequested,
  observeActivity as observeLifecycleActivity,
  observePaneInspection,
  projectLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";

// Tool-registration behavior is environment-sensitive for child subagents.
// Isolate the unit suite from inherited parent/child capability variables.
const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
const inheritedDenyTools = process.env.PI_DENY_TOOLS;
before(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
});
after(() => {
  if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
  else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
  if (inheritedDenyTools == null) delete process.env.PI_DENY_TOOLS;
  else process.env.PI_DENY_TOOLS = inheritedDenyTools;
});

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const eventHandlers = new Map<string, Array<Function>>();
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    eventHandlers,
    sentUserMessages,
    sentMessages,
    api: {
      on(event: string, handler: Function) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("findObservedSessionRuntime", () => {
    it("extracts the latest model and thinking entries", () => {
      assert.deepEqual(
        findObservedSessionRuntime([
          { type: "model_change", id: "m1", provider: "fake", modelId: "old" },
          { type: "thinking_level_change", id: "t1", thinkingLevel: "medium" },
          { type: "model_change", id: "m2", provider: "other", modelId: "new" },
        ]),
        { provider: "other", modelId: "new", thinking: "medium" },
      );
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("puts host attestation metadata at the start of standalone sessions", () => {
      const childFile = join(dir, "standalone-child.jsonl");
      seedSubagentSessionFile({
        mode: "standalone",
        childSessionFile: childFile,
        childCwd: "/tmp/standalone-child-cwd",
        profileAttestation: {
          version: 1,
          customType: "pi-herdr-subagents.launch-profile-attestation",
          nonce: "ab".repeat(32),
          signature: "cd".repeat(32),
        },
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, undefined);
      assert.equal(entries[1].type, "custom");
      assert.equal(entries[1].data.nonce, "ab".repeat(32));
    });

    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("model configuration", () => {
  it("parses global and per-agent model defaults", () => {
    assert.deepEqual(
      parseModelConfig({
        models: {
          default: " anthropic/claude-sonnet-4-6 ",
          agents: { scout: " openai/gpt-5-mini " },
        },
      }),
      {
        default: "anthropic/claude-sonnet-4-6",
        agents: { scout: "openai/gpt-5-mini" },
      },
    );
  });

  it("loads no model overrides when config.json is absent", () => {
    const config = loadModelConfig(join(createTestDir(), "missing-config.json"));
    assert.deepEqual(config, { agents: {} });
  });

  it("resolves frontmatter, per-agent, global, and parent fallback precedence", () => {
    const config = parseModelConfig({
      models: {
        default: "fake/global",
        agents: { scout: "fake/scout" },
      },
    });

    assert.equal(resolveModelDefault("scout", "fake/frontmatter", config), "fake/frontmatter");
    assert.equal(resolveModelDefault("scout", undefined, config), "fake/scout");
    assert.equal(resolveModelDefault("reviewer", undefined, config), "fake/global");
    assert.equal(resolveModelDefault(undefined, undefined, { agents: {} }), undefined);
  });

  it("does not read inherited object properties as agent model defaults", () => {
    const config = parseModelConfig({ models: { agents: {} } });
    for (const agent of ["constructor", "toString", "__proto__"]) {
      assert.equal(resolveModelDefault(agent, undefined, config), undefined);
    }
  });

  it("supports reserved property names when explicitly configured", () => {
    const config = parseModelConfig(
      JSON.parse(
        '{"models":{"agents":{"constructor":"fake/constructor","__proto__":"fake/proto"}}}',
      ),
    );
    assert.equal(resolveModelDefault("constructor", undefined, config), "fake/constructor");
    assert.equal(resolveModelDefault("__proto__", undefined, config), "fake/proto");
  });

  it("rejects invalid model configuration", () => {
    assert.throws(() => parseModelConfig({ models: { default: "" } }), /non-empty string/);
    assert.throws(() => parseModelConfig({ models: { agents: [] } }), /must be an object/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("fails closed for an unknown explicit profile instead of returning bare defaults", async () => {
    await withIsolatedAgentEnv(async () => {
      assert.throws(
        () => testApi.resolveExplicitAgentDefaults("missing-profile"),
        new Error('Unknown named subagent profile "missing-profile"'),
      );
      assert.equal(testApi.loadAgentDefaults("missing-profile"), null);
    });
  });

  it("parses an exact child-profile allowlist, including an explicit empty policy", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "allowlist-test-agent",
        [
          "name: allowlist-test-agent",
          "allowed-child-agents: child-reader, child-writer",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "empty-allowlist-test-agent",
        [
          "name: empty-allowlist-test-agent",
          "allowed-child-agents:",
        ].join("\n"),
      );

      assert.deepEqual(
        testApi.loadAgentDefaults("allowlist-test-agent")?.allowedChildAgents,
        ["child-reader", "child-writer"],
      );
      assert.deepEqual(testApi.loadAgentDefaults("empty-allowlist-test-agent")?.allowedChildAgents, []);
    });
  });

  it("enforces the host-provided child-profile policy before launch", () => {
    const previous = process.env.PI_SUBAGENT_ALLOWED_CHILD_AGENTS;
    try {
      process.env.PI_SUBAGENT_ALLOWED_CHILD_AGENTS = JSON.stringify(["child-reader"]);
      assert.doesNotThrow(() => testApi.assertAllowedChildAgent("child-reader"));
      assert.throws(
        () => testApi.assertAllowedChildAgent("reviewer"),
        /Child profile "reviewer" is not allowed/,
      );
      assert.throws(
        () => testApi.assertAllowedChildAgent(undefined),
        /requires an explicit allowed child profile/,
      );

      process.env.PI_SUBAGENT_ALLOWED_CHILD_AGENTS = "[]";
      assert.throws(() => testApi.assertAllowedChildAgent("anything"), /not allowed/);
      process.env.PI_SUBAGENT_ALLOWED_CHILD_AGENTS = "not-json";
      assert.throws(() => testApi.assertAllowedChildAgent("anything"), /not allowed/);
    } finally {
      restoreEnvVar("PI_SUBAGENT_ALLOWED_CHILD_AGENTS", previous);
    }
  });

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("loads and resolves named-profile waiting timeout policy with spawn precedence", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "waiting-profile-test-agent",
        [
          "name: waiting-profile-test-agent",
          "auto-exit: false",
          "interactive: true",
          "wait-timeout: 45",
          "wait-timeout-message: full",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "waiting-off-test-agent",
        [
          "name: waiting-off-test-agent",
          "wait-timeout: off",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "waiting-immediate-test-agent",
        [
          "name: waiting-immediate-test-agent",
          "wait-timeout: immediate",
          "wait-timeout-message: preview",
        ].join("\n"),
      );

      const configured = testApi.loadAgentDefaults("waiting-profile-test-agent");
      assert.equal(configured?.waitTimeout, 45);
      assert.equal(configured?.waitTimeoutMessage, "full");
      assert.equal(testApi.resolveEffectiveWaitTimeout({ name: "A", task: "T" }, configured), 45);
      assert.equal(testApi.resolveEffectiveWaitTimeoutMessage({ name: "A", task: "T" }, configured), "full");
      assert.equal(testApi.resolveEffectiveWaitTimeout(
        { name: "A", task: "T", waitTimeout: 10 },
        configured,
      ), 10);
      assert.equal(testApi.resolveEffectiveWaitTimeout(
        { name: "A", task: "T", waitTimeout: "immediate" },
        configured,
      ), "immediate");
      assert.equal(testApi.resolveEffectiveWaitTimeout(
        { name: "A", task: "T", waitTimeout: "off" },
        configured,
      ), null);
      assert.equal(testApi.resolveEffectiveWaitTimeoutMessage(
        { name: "A", task: "T", waitTimeoutMessage: "none" },
        configured,
      ), "none");

      const immediate = testApi.loadAgentDefaults("waiting-immediate-test-agent");
      assert.equal(immediate?.waitTimeout, "immediate");
      assert.equal(testApi.resolveEffectiveWaitTimeout({ name: "A", task: "T" }, immediate), "immediate");

      const disabled = testApi.loadAgentDefaults("waiting-off-test-agent");
      assert.equal(disabled?.waitTimeout, null);
      assert.equal(testApi.resolveEffectiveWaitTimeout({ name: "A", task: "T" }, disabled), null);
      assert.equal(testApi.resolveEffectiveWaitTimeout({ name: "A", task: "T" }, null), null);
      assert.equal(testApi.resolveEffectiveWaitTimeoutMessage({ name: "A", task: "T" }, null), "preview");
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolves auto-exit and interactive behavior for named and bare spawns", () => {
    // Autonomous named agents are not interactive, so the parent gets status pings.
    assert.equal(
      testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, { autoExit: true }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );

    // A per-spawn override wins over named-agent frontmatter so recursive
    // orchestrators can remain alive until descendant results arrive.
    assert.equal(
      testApi.resolveEffectiveAutoExit(
        { name: "A", task: "T", autoExit: false },
        { autoExit: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", autoExit: false },
        { autoExit: true },
      ),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveAutoExit(
        { name: "A", task: "T", autoExit: true },
        { autoExit: false },
      ),
      true,
    );

    // Named agents without auto-exit preserve their interactive behavior.
    assert.equal(
      testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, { autoExit: false }),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );

    // Bare task spawns are autonomous by default. Otherwise a normal final
    // answer leaves the child open and no completion is delivered to the parent.
    assert.equal(testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, null), true);
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null), false);

    // A bare full-context fork invoked directly through the tool is still an
    // autonomous task. Forking only controls inherited conversation context.
    assert.equal(
      testApi.resolveEffectiveAutoExit({ name: "A", task: "T", fork: true }, null),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T", fork: true }, null),
      false,
    );

    // Interactive fork workflows such as /iterate opt out explicitly.
    assert.equal(
      testApi.resolveEffectiveAutoExit(
        { name: "A", task: "T", fork: true, interactive: true },
        null,
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", fork: true, interactive: true },
        null,
      ),
      true,
    );
  });

  it("rejects per-spawn autoExit overrides for Claude-backed agents", () => {
    assert.doesNotThrow(() => testApi.assertAutoExitOverrideSupported("pi", false));
    assert.doesNotThrow(() => testApi.assertAutoExitOverrideSupported("claude", undefined));
    assert.throws(
      () => testApi.assertAutoExitOverrideSupported("claude", false),
      /supported only for Pi-backed subagents/,
    );
    assert.throws(
      () => testApi.assertAutoExitOverrideSupported("claude", true),
      /supported only for Pi-backed subagents/,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("bundled agents inherit the parent runtime and preserve interaction modes", () => {
    const expectedInteraction = {
      scout: false,
      worker: false,
      reviewer: false,
      planner: true,
      "visual-tester": false,
    } as const;

    for (const [name, interactive] of Object.entries(expectedInteraction)) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.model, undefined, `${name} should inherit the parent model`);
      assert.equal(defs.thinking, undefined, `${name} should inherit the parent thinking level`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        interactive,
        `${name} should preserve its interaction mode`,
      );
    }

    const planner = testApi.loadAgentDefaults("planner");
    assert.equal(planner?.waitTimeout, "immediate");
    assert.equal(planner?.waitTimeoutMessage, "preview");
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  it("separates the parent-owned registration from each child's stable registry", () => {
    const dir = createTestDir();
    try {
      const sessionOne = join(dir, "session-one.jsonl");
      const first = childDescendantRegistryPath(dir, sessionOne);
      assert.equal(childDescendantRegistryPath(dir, sessionOne), first, "resume must reuse the child registry");
      assert.notEqual(childDescendantRegistryPath(dir, join(dir, "session-two.jsonl")), first, "siblings need distinct registries");
      assert.equal(parentDescendantRegistryPath("  /tmp/parent-descendants.json  "), "/tmp/parent-descendants.json");
      assert.equal(parentDescendantRegistryPath(""), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a child to complete when only its parent registry contains the child itself", async () => {
    const dir = createTestDir();
    try {
      const parentRegistry = join(dir, "parent-descendants.json");
      const childRegistry = childDescendantRegistryPath(dir, join(dir, "child-session.jsonl"));
      registerDescendant(parentRegistry, { id: "child-self", name: "Child self", state: "active" });
      const previous = process.env.PI_SUBAGENT_DESCENDANTS_FILE;
      process.env.PI_SUBAGENT_DESCENDANTS_FILE = childRegistry;
      let shutdown = false;
      try {
        const { api, registeredTools } = createMockExtensionApi();
        subagentDoneExtension(api as any);
        const done = registeredTools.find((tool) => tool.name === "subagent_done");
        assert.ok(done);
        await done.execute("call-self", {}, undefined, undefined, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true);
      } finally {
        restoreEnvVar("PI_SUBAGENT_DESCENDANTS_FILE", previous);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses completion while a tracked descendant remains", async () => {
    const dir = createTestDir();
    try {
      const descendantsFile = join(dir, "descendants.json");
      registerDescendant(descendantsFile, { id: "child-1", name: "Child one", state: "waiting-for-terminal-delivery" });
      const previous = process.env.PI_SUBAGENT_DESCENDANTS_FILE;
      process.env.PI_SUBAGENT_DESCENDANTS_FILE = descendantsFile;
      try {
        const { api, registeredTools } = createMockExtensionApi();
        subagentDoneExtension(api as any);
        const done = registeredTools.find((tool) => tool.name === "subagent_done");
        assert.ok(done);
        await assert.rejects(
          done.execute("call-1", {}, undefined, undefined, { shutdown() {} }),
          /tracked descendants remain: Child one \[child-1\]/,
        );
      } finally {
        restoreEnvVar("PI_SUBAGENT_DESCENDANTS_FILE", previous);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers auto-exit until tracked descendants have delivered", () => {
    const dir = createTestDir();
    const descendantsFile = join(dir, "descendants.json");
    const sessionFile = join(dir, "orchestrator.jsonl");
    registerDescendant(descendantsFile, { id: "child-1", name: "Child one", state: "active" });
    const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    const previousDescendants = process.env.PI_SUBAGENT_DESCENDANTS_FILE;
    const previousSession = process.env.PI_SUBAGENT_SESSION;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_DESCENDANTS_FILE = descendantsFile;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    try {
      const { api, eventHandlers } = createMockExtensionApi();
      subagentDoneExtension(api as any);
      const agentEnd = eventHandlers.get("agent_end")?.[0];
      assert.ok(agentEnd);
      let shutdowns = 0;
      const ctx = { shutdown() { shutdowns++; } };
      const event = { messages: [{ role: "assistant", stopReason: "stop" }] };

      agentEnd(event, ctx);
      assert.equal(shutdowns, 0);
      assert.equal(existsSync(`${sessionFile}.exit`), false);

      unregisterDescendant(descendantsFile, "child-1");
      agentEnd(event, ctx);
      assert.equal(shutdowns, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
    } finally {
      restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
      restoreEnvVar("PI_SUBAGENT_DESCENDANTS_FILE", previousDescendants);
      restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the descendant registry is unreadable", () => {
    const dir = createTestDir();
    try {
      const descendantsFile = join(dir, "descendants.json");
      writeFileSync(descendantsFile, "not json");
      assert.equal(shouldDeferAutoExitForDescendants(descendantsFile), true);
      assert.equal(shouldDeferAutoExitForDescendants(undefined), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures active tools at before_agent_start after awaited startup handlers", async () => {
    await withIsolatedAgentEnv(async ({ projectDir }) => {
      const activityFile = join(projectDir, "activity.json");
      const previousId = process.env.PI_SUBAGENT_ID;
      const previousActivity = process.env.PI_SUBAGENT_ACTIVITY_FILE;
      process.env.PI_SUBAGENT_ID = "telemetry-child";
      process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
      let activeTools = ["read", "write"];
      const handlers = new Map<string, Function[]>();
      try {
        subagentDoneExtension({
          on(event: string, handler: Function) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
          registerShortcut() {},
          registerTool() {},
          getActiveTools() {
            return activeTools;
          },
        } as any);
        const ctx = {
          sessionManager: { appendCustomEntry() {} },
          ui: { setWidget() {} },
        };
        // Pi awaits each session_start handler before invoking the next.
        await handlers.get("session_start")?.[0]({}, ctx);
        activeTools = ["read"];
        await Promise.resolve();
        await handlers.get("before_agent_start")?.[0]({}, ctx);

        const result = readSubagentActivityFile(activityFile, "telemetry-child");
        assert.ok(result.ok);
        assert.deepEqual(result.activity.actualTools, ["read"]);
        assert.deepEqual(result.activity.deniedTools, []);
      } finally {
        restoreEnvVar("PI_SUBAGENT_ID", previousId);
        restoreEnvVar("PI_SUBAGENT_ACTIVITY_FILE", previousActivity);
      }
    });
  });

  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("buildCompletionSidecar", () => {
    it("emits done immediately for a normal auto-exit completion", () => {
      assert.deepEqual(buildCompletionSidecar([
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ]), { type: "done" });
    });

    it("preserves provider errors in the immediate completion sidecar", () => {
      assert.deepEqual(buildCompletionSidecar([
        { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
      ]), {
        type: "error",
        errorMessage: "provider failed",
        stopReason: "error",
      });
    });
  });

  it("accepts a generation-bound parent request and publishes normal completion", async () => {
    const previous = {
      id: process.env.PI_SUBAGENT_ID,
      session: process.env.PI_SUBAGENT_SESSION,
      activity: process.env.PI_SUBAGENT_ACTIVITY_FILE,
      control: process.env.PI_SUBAGENT_CONTROL_FILE,
      descendants: process.env.PI_SUBAGENT_DESCENDANTS_FILE,
      autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
    };

    const dir = createTestDir();
    const sessionFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
    const activityFile = getSubagentActivityFile(dir, "child-control");
    const controlFile = join(dir, "control", "child-control.json");
    process.env.PI_SUBAGENT_ID = "child-control";
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
    process.env.PI_SUBAGENT_CONTROL_FILE = controlFile;
    delete process.env.PI_SUBAGENT_DESCENDANTS_FILE;
    delete process.env.PI_SUBAGENT_AUTO_EXIT;

    const { api, eventHandlers } = createMockExtensionApi();
    let shutdowns = 0;
    const ctx = {
      ui: { setWidget() {} },
      sessionManager: { appendCustomEntry() {} },
      shutdown() {
        shutdowns += 1;
        for (const handler of eventHandlers.get("session_shutdown") ?? []) {
          handler({ reason: "quit" }, ctx);
        }
      },
    } as any;

    try {
      subagentDoneExtension(api);
      for (const handler of eventHandlers.get("session_start") ?? []) handler({}, ctx);
      for (const handler of eventHandlers.get("turn_start") ?? []) handler({ turnIndex: 1 }, ctx);
      for (const handler of eventHandlers.get("agent_start") ?? []) handler({}, ctx);
      for (const handler of eventHandlers.get("agent_end") ?? []) {
        handler({
          messages: [{
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Useful final answer." }],
          }],
        }, ctx);
      }

      const activity = readSubagentActivityFile(activityFile, "child-control");
      assert.ok(activity.ok);
      const request = createCompletionControlRequest({
        runningChildId: "child-control",
        activity: activity.activity,
        requestId: "parent-request",
      });
      atomicWriteJson(controlFile, request);

      const deadline = Date.now() + 1_000;
      while (!existsSync(`${sessionFile}.exit`) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(shutdowns, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
        type: "done",
        runningChildId: "child-control",
        requestId: "parent-request",
      });
    } finally {
      for (const handler of eventHandlers.get("session_shutdown") ?? []) {
        handler({ reason: "quit" }, ctx);
      }
      restoreEnvVar("PI_SUBAGENT_ID", previous.id);
      restoreEnvVar("PI_SUBAGENT_SESSION", previous.session);
      restoreEnvVar("PI_SUBAGENT_ACTIVITY_FILE", previous.activity);
      restoreEnvVar("PI_SUBAGENT_CONTROL_FILE", previous.control);
      restoreEnvVar("PI_SUBAGENT_DESCENDANTS_FILE", previous.descendants);
      restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previous.autoExit);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("interrupt completion control", () => {
  function waitingActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1 as const,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 2_000,
      sequence: 12,
      latestEvent: "agent_end" as const,
      phase: "waiting" as const,
      usage: undefined as any,
      usageByModel: [],
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      turnIndex: 3,
      waitingSince: 2_000,
      lastTurnOutcome: "completed" as const,
      lastTurnHasAssistantText: true,
      ...overrides,
    };
  }

  it("classifies only a normal content-bearing idle turn as safely completable", () => {
    assert.equal(isSafelyWaitingForCompletion(waitingActivity()), true);
    for (const overrides of [
      { phase: "active", agentActive: true },
      { providerActive: true },
      { toolActive: true },
      { lastTurnOutcome: "aborted" },
      { lastTurnOutcome: "error" },
      { lastTurnHasAssistantText: false },
    ]) {
      assert.equal(isSafelyWaitingForCompletion(waitingActivity(overrides) as any), false);
    }
  });

  it("extracts privacy-preserving evidence from the latest assistant turn", () => {
    assert.deepEqual(getWaitingTurnEvidence([
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished" }] },
    ], 3), { outcome: "completed", hasAssistantText: true, turnIndex: 3 });
    assert.deepEqual(getWaitingTurnEvidence([
      { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
    ], 4), { outcome: "aborted", hasAssistantText: true, turnIndex: 4 });
  });

  it("accepts an exact waiting generation and rejects stale or aborted generations", () => {
    const activity = waitingActivity();
    const request = createCompletionControlRequest({
      runningChildId: "child-1",
      activity: activity as any,
      requestedAt: 3_000,
      requestId: "request-1",
    });
    assert.equal(requestMatchesWaitingTurn(request, activity as any, {
      outcome: "completed",
      hasAssistantText: true,
      turnIndex: 3,
    }), true);
    assert.equal(requestMatchesWaitingTurn(request, waitingActivity({ sequence: 13 }) as any, {
      outcome: "completed",
      hasAssistantText: true,
      turnIndex: 3,
    }), false);
    assert.equal(requestMatchesWaitingTurn(request, activity as any, {
      outcome: "aborted",
      hasAssistantText: true,
      turnIndex: 3,
    }), false);
  });

  it("atomically round-trips and identity-checks completion requests", () => {
    withTempDir((dir) => {
      const file = join(dir, "control", "child.json");
      const activity = waitingActivity();
      const request = createCompletionControlRequest({
        runningChildId: "child-1",
        activity: activity as any,
        requestedAt: 3_000,
        requestId: "request-1",
      });
      atomicWriteJson(file, request);
      assert.deepEqual(readCompletionControlRequest(file, "child-1"), { ok: true, request });
      assert.equal(readCompletionControlRequest(file, "other").reason, "wrong-id");
    });
  });
});

describe("lifecycle.ts", () => {
  const activity = (overrides: Record<string, unknown> = {}) => ({
    version: 1 as const,
    runningChildId: "child",
    createdAt: 1_000,
    updatedAt: 2_000,
    sequence: 1,
    latestEvent: "agent_start" as const,
    phase: "active" as const,
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: false,
    activeScope: "agent" as const,
    activeSince: 2_000,
    ...overrides,
  });

  it("interrupts only the turn and keeps process runtime open", () => {
    const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
    const interrupted = markInterruptRequested(running, 3_000);
    const projection = projectLifecycle(interrupted, 8_000);
    assert.equal(interrupted.process.kind, "running");
    assert.equal(interrupted.turn.kind, "interrupted");
    assert.equal(projection.runtimeEndedAt, undefined);
  });

  it("rejects stale activity after interrupt and accepts a newer sequence", () => {
    const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
    const interrupted = markInterruptRequested(running, 3_000);
    const stale = observeLifecycleActivity(interrupted, { ok: true, activity: activity({ updatedAt: 3_000 }) }, 3_100);
    assert.equal(stale.turn.kind, "interrupted");
    const resumed = observeLifecycleActivity(stale, {
      ok: true,
      activity: activity({ updatedAt: 3_000, sequence: 2, activeSince: 3_000 }),
    }, 3_100);
    assert.equal(resumed.turn.kind, "active");
  });

  it("makes finalizing and terminal process states irreversible", () => {
    const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
    const finalizing = markCompletionDetected(running, { reason: "done", exitCode: 0 }, 4_000);
    const ignored = observeLifecycleActivity(finalizing, {
      ok: true,
      activity: activity({ updatedAt: 5_000, sequence: 9 }),
    }, 5_000);
    assert.equal(ignored.process.kind, "finalizing");
    assert.deepEqual(projectLifecycle(ignored, 9_000), { kind: "finalizing", runtimeEndedAt: 4_000 });
    const completed = markCompleted(ignored, 6_000);
    assert.equal(markFailed(completed, "late failure", 7_000).process.kind, "completed");
  });

  it("projects confirmed running without turn detail as running, not starting", () => {
    const started = createLifecycle(1_000);
    const running = {
      ...started,
      process: { kind: "running" as const, startedAt: 1_000, confirmedAt: 1_500 },
    };
    assert.deepEqual(projectLifecycle(running, 3_000), { kind: "running" });
  });

  it("detects stalled and recovered transitions from lifecycle projections", () => {
    assert.equal(lifecycleTransition("active", "stalled"), "stalled");
    assert.equal(lifecycleTransition("stalled", "waiting"), "recovered");
    assert.equal(lifecycleTransition("stalled", "active"), "recovered");
    assert.equal(lifecycleTransition("stalled", "blocked"), "recovered");
    assert.equal(lifecycleTransition("stalled", "interrupted"), "recovered");
    assert.equal(lifecycleTransition("waiting", "active"), null);
  });

  it("does not interpret initial idle as completion", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "idle" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 3_000).kind, "starting");
    assert.equal(lifecycle.turn.kind, "starting");
  });

  it("treats working then idle as waiting", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 2_500).kind, "active");
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("preserves state entry time across repeated herdr observations", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "working" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).stateDurationSince, 2_000);

    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 5_000, agentStatus: "blocked" }, 5_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 6_000, agentStatus: "blocked" }, 6_000);
    assert.equal(projectLifecycle(lifecycle, 7_000).stateDurationSince, 5_000);

    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 8_000, agentStatus: "idle" }, 8_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 9_000, agentStatus: "done" }, 9_000);
    assert.equal(projectLifecycle(lifecycle, 10_000).stateDurationSince, 8_000);
  });

  it("does not enter finalizing from herdr idle/done", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "done" }, 3_000);
    assert.equal(lifecycle.process.kind, "running");
    assert.notEqual(projectLifecycle(lifecycle, 4_000).kind, "finalizing");
  });

  it("projects blocked when herdr reports blocked", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "blocked" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 3_000).kind, "blocked");
  });

  it("treats missing pane as pane observation but not immediate failure", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "missing", error: "pane_not_found" }, 3_000);
    assert.equal(lifecycle.pane.kind, "missing");
    assert.equal(lifecycle.process.kind, "running");
  });

  it("preserves local interrupt over stale herdr statuses", () => {
    for (const agentStatus of ["working", "blocked", "idle", "done"] as const) {
      let lifecycle = createLifecycle(1_000);
      lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
      lifecycle = markInterruptRequested(lifecycle, 3_000);
      lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_100, agentStatus }, 3_100);
      assert.equal(projectLifecycle(lifecycle, 4_000).kind, "interrupted", agentStatus);
    }
  });

  it("preserves hasWorked across unavailable observations", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_500);
    lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_600);
    assert.equal(lifecycle.pane.kind, "read-error");
    assert.equal(lifecycle.pane.kind === "read-error" ? lifecycle.pane.consecutiveFailures : 0, 2);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("does not let missing activity detail stall healthy herdr working", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observeLifecycleActivity(lifecycle, { ok: false, reason: "missing" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 120_000).kind, "active");
  });

  it("uses activity only as detail and does not override herdr waiting", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    lifecycle = observeLifecycleActivity(lifecycle, { ok: true, activity: activity({ updatedAt: 3_100, sequence: 2 }) }, 3_100);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("preserves activity detail duration across repeated updates", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observeLifecycleActivity(lifecycle, {
      ok: true,
      activity: activity({ updatedAt: 2_100, sequence: 1, activeSince: 2_000, activeScope: "tool", toolName: "bash", toolStartedAt: 2_000 }),
    }, 2_100);
    lifecycle = observeLifecycleActivity(lifecycle, {
      ok: true,
      activity: activity({ updatedAt: 3_000, sequence: 2, activeSince: 2_000, activeScope: "tool", toolName: "bash", toolStartedAt: 2_000 }),
    }, 3_000);
    const projection = projectLifecycle(lifecycle, 4_000);
    assert.equal(projection.kind, "active");
    assert.equal(projection.label, "bash");
    assert.equal(projection.stateDurationSince, 2_000);
  });
});

describe("completion.ts", () => {

  it("decodes ping payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "need help" },
      },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("rejects unknown completion sidecar payloads", () => {
    for (const payload of [{}, null]) {
      const result = interpretExitSidecar(payload);
      assert.equal(result.reason, "error");
      assert.equal(result.exitCode, 1);
      assert.match(result.errorMessage ?? "", /Invalid subagent completion sidecar/);
    }
  });

  it("consumes a sidecar and removes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-"));
    const sessionFile = join(dir, "session.jsonl");
    const exitFile = `${sessionFile}.exit`;
    writeFileSync(exitFile, JSON.stringify({ type: "ping", name: "Scout", message: "ready" }));
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
      });
      assert.deepEqual(result, {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Scout", message: "ready" },
      });
      assert.equal(existsSync(exitFile), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the terminal sentinel exit code", async () => {
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => "output\n__SUBAGENT_DONE_17__\n",
    });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 17 });
  });

  it("returns when an external sentinel file appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-sentinel-"));
    const sentinelFile = join(dir, "done");
    writeFileSync(sentinelFile, "complete");
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sentinelFile,
        readTerminalTail: async () => "",
      });
      assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries transient terminal read failures and reports ticks", async () => {
    let reads = 0;
    let ticks = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("pane temporarily unavailable");
        return "__SUBAGENT_DONE_0__";
      },
      onTick: () => {
        ticks += 1;
      },
    });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    assert.equal(reads, 2);
    assert.equal(ticks, 1);
  });

  it("returns a failure when the pane explicitly disappears", async () => {
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => { throw new Error("pane read failed"); },
      inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
      paneDisappearanceGraceMs: 0,
    });
    assert.deepEqual(result, {
      reason: "error",
      exitCode: 1,
      errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
    });
  });

  it("lets a sidecar win the pane-disappearance race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-race-"));
    const sessionFile = join(dir, "child.jsonl");
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
        inspectPane: async () => {
          writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
          return { kind: "missing", error: "pane_not_found" };
        },
      });
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits briefly for delayed sidecar publication after pane disappearance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-delayed-race-"));
    const sessionFile = join(dir, "child.jsonl");
    const timer = setTimeout(() => {
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    }, 30);
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
        inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
        paneDisappearanceGraceMs: 150,
      });
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous pane read failure retryable while the pane exists", async () => {
    let reads = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("socket unavailable");
        return "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => ({ kind: "present", observedAt: 0, agentStatus: "working" }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(reads, 2);
  });

  it("treats presence-check throws as unknown and keeps polling", async () => {
    let reads = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("pane read failed");
        return "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => { throw new Error("herdr list failed"); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(reads, 2);
  });

  it("inspects herdr status even when terminal reads succeed", async () => {
    let reads = 0;
    const inspections: string[] = [];
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        return reads === 1 ? "shell output" : "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => ({ kind: "present", observedAt: 2_000, agentStatus: "blocked" }),
      onPaneInspection: (inspection) => inspections.push(inspection.kind === "present" ? inspection.agentStatus : inspection.kind),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(inspections, ["blocked"]);
  });

  it("rejects promptly when aborted", async () => {
    const controller = new AbortController();
    const completion = waitForCompletion(controller.signal, {
      intervalMs: 10_000,
      readTerminalTail: async () => "",
    });
    controller.abort();
    await assert.rejects(completion, /Aborted while waiting for subagent to finish/);
  });
});

describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const iterate = registeredCommands.find((command) => command.name === "iterate");
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /fork: true/);
    assert.match(sentUserMessages[0], /interactive: true/);
    assert.match(sentUserMessages[0], /name: "Iterate"/);
  });
});

describe("tool registration", () => {
  it("refreshes subagent routing guidance from the live authenticated model registry", () => {
    const { api, registeredTools, eventHandlers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagent = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagent);
    const sessionStart = eventHandlers.get("session_start")?.[0];
    assert.ok(sessionStart);
    sessionStart({}, {
      hasUI: false,
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
        getAvailable: () => [{
          provider: "fake",
          id: "fast",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_000,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        }],
        hasConfiguredAuth: () => true,
      },
    });

    assert.match(subagent.promptGuidelines.join("\n"), /fake\/fast/);
    assert.match(subagent.promptGuidelines.join("\n"), /inherit the parent runtime/);
  });

  it("ignores an inherited deny list in a parent process", () => {
    delete process.env.PI_SUBAGENT_ID;
    process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt,subagent_resume,subagents_list";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent"), true);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), true);
    } finally {
      delete process.env.PI_DENY_TOOLS;
    }
  });

  it("applies the deny list inside a child subagent process", () => {
    process.env.PI_SUBAGENT_ID = "child-test";
    process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent"), false);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), false);
      assert.equal(registeredTools.some((tool) => tool.name === "subagents_list"), true);
    } finally {
      delete process.env.PI_SUBAGENT_ID;
      delete process.env.PI_DENY_TOOLS;
    }
  });

  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("canonicalizes relative resume paths before profile-controlled cwd changes", () => {
    withTempDir((dir) => {
      const previousCwd = process.cwd();
      try {
        process.chdir(dir);
        const resolved = (subagentsModule as any).__test__.resolveResumeSessionPath("sessions/child.jsonl");
        assert.equal(resolved, join(dir, "sessions", "child.jsonl"));
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("constructs external/legacy resumes with no ambient extension discovery", () => {
    const args = (subagentsModule as any).__test__.buildIsolatedResumeArgs("/tmp/external.jsonl");
    assert.deepEqual(args, [
      "pi",
      "--session",
      "/tmp/external.jsonl",
      "--no-extensions",
    ]);
  });

  it("keeps the recursive same-agent guard effective for restored resume identity", async () => {
    const previousAgent = process.env.PI_SUBAGENT_AGENT;
    process.env.PI_SUBAGENT_AGENT = "reviewer";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
      const result = await subagentTool.execute(
        "call",
        { name: "Nested reviewer", task: "review", agent: "reviewer" },
        undefined,
        undefined,
        {},
      );
      assert.equal(result.details.error, "self-spawn blocked");
      assert.match(result.content[0].text, /do not start another reviewer/);
    } finally {
      restoreEnvVar("PI_SUBAGENT_AGENT", previousAgent);
    }
  });

  it("expands spawning false to deny every subagent lifecycle tool", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_interrupt"), true);
    assert.equal(denied.has("subagent_snooze"), true);
    assert.equal(denied.has("subagents_list"), true);
    assert.equal(denied.has("subagent_resume"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers recursive runtime and lifecycle parameters on subagent", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const modeSchema = subagentTool.parameters.properties.extensionMode;
    assert.deepEqual(modeSchema.anyOf.map((entry: any) => entry.const), ["normal", "explicit"]);
    assert.equal(subagentTool.parameters.properties.extensions.type, "string");
    assert.match(subagentTool.parameters.properties.extensions.description, /effective child cwd/);
    assert.match(modeSchema.description, /ambient extension discovery/);
    assert.match(modeSchema.description, /does not restrict OS access/);

    const autoExitSchema = subagentTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /recursive orchestrators/);
    assert.match(autoExitSchema.description, /Overrides agent frontmatter/);
  });

  it("registers subagent_resume with lifecycle controls", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
    assert.ok(resumeTool, "expected subagent_resume tool to be registered");

    const autoExitSchema = resumeTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /Defaults to true/);

  });

  it("rejects symlink and special resume session paths before terminal creation", async () => {
    const dir = createTestDir();
    try {
      const target = createSessionFile(dir, []);
      const symlinkPath = join(dir, "linked-session.jsonl");
      symlinkSync(target, symlinkPath);
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");

      let result = await resumeTool.execute("call", { sessionPath: symlinkPath }, undefined, undefined, {});
      assert.equal(result.details.error, "unsafe session path");
      assert.match(result.content[0].text, /symbolic link/);

      const fifoPath = join(dir, "fifo-session.jsonl");
      execFileSync("mkfifo", [fifoPath]);
      result = await resumeTool.execute("call", { sessionPath: fifoPath }, undefined, undefined, {});
      assert.equal(result.details.error, "unsafe session path");
      assert.match(result.content[0].text, /regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a malformed resume profile before checking or creating a terminal", async () => {
    const dir = createTestDir();
    try {
      const sessionPath = createSessionFile(dir, []);
      writeFileSync(`${sessionPath}.profile.json`, JSON.stringify({ version: 1, task: "must not load" }));
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");

      const result = await resumeTool.execute("call", { sessionPath }, undefined, undefined, {});
      assert.equal(result.details.error, "invalid launch profile");
      assert.equal(result.details.profileStatus, "malformed");
      assert.match(result.content[0].text, /Refusing to resume/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent parent lifecycle", () => {
  it("gives launch and resume completion watchers independent abort lifetimes", () => {
    const running: { abortController?: AbortController } = {};
    const signal = prepareSubagentWatcher(running as any);

    assert.ok(running.abortController);
    assert.equal(signal, running.abortController.signal);
    assert.equal(signal.aborted, false);

    const source = readFileSync(
      fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url)),
      "utf8",
    );
    const wiredWatchers = source.match(
      /watchSubagent\(running, prepareSubagentWatcher\(running\)\)/g,
    ) ?? [];
    assert.equal(wiredWatchers.length, 2, "both launch and resume must initialize their completion watcher");
  });

  it("preserves active subagents during extension reload", () => {
    const abortController = new AbortController();
    const agents = new Map([["child", {
      abortController,
      lifecycle: createLifecycle(1_000),
    }]]);

    cleanupSubagentsForShutdown("reload", agents);

    assert.equal(shouldPreserveSubagentsOnShutdown("reload"), true);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(shouldDeliverSubagentCompletion(agents.get("child")!), true);
    assert.equal(agents.size, 1);
  });

  it("aborts and clears active subagents during final shutdown", () => {
    for (const reason of ["quit", "new", "resume", "fork", undefined]) {
      const abortController = new AbortController();
      const running = { abortController, lifecycle: createLifecycle(1_000) };
      const agents = new Map([["child", running]]);

      cleanupSubagentsForShutdown(reason, agents);

      assert.equal(shouldPreserveSubagentsOnShutdown(reason), false);
      assert.equal(abortController.signal.aborted, true);
      // Delivery is suppressed before the map is cleared so a racing watcher
      // that still holds a reference cannot deliver after shutdown.
      assert.equal(running.lifecycle.delivery, "suppressed");
      assert.equal(shouldDeliverSubagentCompletion(running), false);
      assert.equal(agents.size, 0);
    }
  });

  it("treats lifecycle.delivery as the authoritative completion gate", () => {
    const pending = { lifecycle: createLifecycle(1_000) };
    assert.equal(shouldDeliverSubagentCompletion(pending), true);

    const delivered = {
      lifecycle: { ...createLifecycle(1_000), delivery: "delivered" as const },
    };
    assert.equal(shouldDeliverSubagentCompletion(delivered), false);

    const suppressed = {
      lifecycle: { ...createLifecycle(1_000), delivery: "suppressed" as const },
    };
    assert.equal(shouldDeliverSubagentCompletion(suppressed), false);

    // Pre-lifecycle fixtures without a lifecycle field still default to pending.
    assert.equal(shouldDeliverSubagentCompletion({} as any), true);
  });

  it("delivers completion through the reloaded extension API", () => {
    const previous = { id: "previous" };
    const current = { id: "current" };

    assert.equal(selectCompletionApi(previous, current), current);
    assert.equal(selectCompletionApi(previous, undefined), previous);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolTelemetry(
        ["write", "read", "read"],
        ["subagent_resume", "subagent"],
      );
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.deepEqual(read.activity.actualTools, ["read", "write"]);
      assert.deepEqual(read.activity.deniedTools, ["subagent", "subagent_resume"]);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records provider usage without persisting message content", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "usage-child");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "usage-child",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.turnStart(1);
      recorder.messageEnd({
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-test",
        secretPrompt: "must not be persisted",
        usage: {
          input: 10,
          output: 7,
          cacheRead: 3,
          cacheWrite: 2,
          reasoning: 4,
          totalTokens: 20,
          cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.2, total: 3.5 },
        },
      });
      recorder.messageEnd({ role: "user", content: "also not persisted" });

      const read = readSubagentActivityFile(activityFile, "usage-child");
      assert.ok(read.ok);
      assert.deepEqual(read.activity.usage, {
        version: 1,
        sessions: 1,
        turns: 1,
        responses: 1,
        inputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 4,
        totalTokens: 20,
        cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.2, total: 3.5 },
      });
      assert.deepEqual(read.activity.usageByModel, [{
        version: 1,
        provider: "openai-codex",
        model: "gpt-test",
        responses: 1,
        inputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 4,
        totalTokens: 20,
        cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.2, total: 3.5 },
      }]);
      assert.equal(JSON.stringify(read.activity).includes("secretPrompt"), false);
      assert.equal(JSON.stringify(read.activity).includes("also not persisted"), false);
    });
  });

  it("refreshes the final activity sidecar before completion details are constructed", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "completion-usage-child");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "completion-usage-child",
        activityFile,
        now: () => 2_000,
      });
      recorder.sessionStart();
      recorder.turnStart(1);
      recorder.messageEnd({
        role: "assistant",
        provider: "provider-a",
        model: "model-a",
        usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 0, totalTokens: 23, cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0, total: 0.35 } },
      });

      const running = {
        id: "completion-usage-child",
        cli: "pi",
        startTime: 1_000,
        activityFile,
        lifecycle: createLifecycle(1_000),
      } as any;
      assert.equal(running.activity, undefined, "cached completion state begins stale");
      subagentsModule.refreshCompletionActivity(running, 2_001);
      assert.equal(running.activity?.usage?.totalTokens, 23);
      assert.equal(running.activity?.usageByModel?.[0]?.responses, 1);
    });
  });

  it("preserves cumulative usage across profile-preserving resume", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "resume-usage-child");
      const first = createSubagentActivityRecorder({
        runningChildId: "resume-usage-child",
        activityFile,
        now: () => 1_000,
      });
      first.sessionStart();
      first.turnStart(1);
      first.messageEnd({
        role: "assistant",
        provider: "provider-a",
        model: "model-a",
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });

      const resumed = createSubagentActivityRecorder({
        runningChildId: "resume-usage-child",
        activityFile,
        now: () => 2_000,
      });
      resumed.sessionStart();
      resumed.turnStart(1);
      resumed.messageEnd({
        role: "assistant",
        provider: "provider-a",
        model: "model-a",
        usage: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });

      const read = readSubagentActivityFile(activityFile, "resume-usage-child");
      assert.ok(read.ok);
      assert.equal(read.activity.usage.sessions, 2);
      assert.equal(read.activity.usage.turns, 2);
      assert.equal(read.activity.usage.responses, 2);
      assert.equal(read.activity.usage.inputTokens, 6);
      assert.equal(read.activity.usage.totalTokens, 14);
      assert.equal(read.activity.usageByModel[0]?.responses, 2);
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting({ outcome: "completed", hasAssistantText: true });
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);
      assert.equal(read.activity.lastTurnOutcome, "completed");
      assert.equal(read.activity.lastTurnHasAssistantText, true);

      currentNow = 4_000;
      recorder.subagentDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
        { actualTools: "read" },
        { actualTools: ["read", "read"] },
        { deniedTools: ["bad tool"] },
        { lastTurnOutcome: "cancelled" },
        { lastTurnHasAssistantText: "yes" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("rejects symlink, FIFO, directory, and oversized activity files without blocking", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "special");
      const target = join(dir, "target-activity.json");
      writeFileSync(target, "{}\n");
      symlinkSync(target, activityFile);
      let read = readSubagentActivityFile(activityFile, "special");
      assert.equal(read.ok, false);
      assert.match((read as { ok: false; error?: string }).error ?? "", /symbolic link/);
      rmSync(activityFile);

      mkdirSync(activityFile);
      read = readSubagentActivityFile(activityFile, "special");
      assert.equal(read.ok, false);
      assert.match((read as { ok: false; error?: string }).error ?? "", /regular file/);
      rmSync(activityFile, { recursive: true });

      execFileSync("mkfifo", [activityFile]);
      read = readSubagentActivityFile(activityFile, "special");
      assert.equal(read.ok, false);
      assert.match((read as { ok: false; error?: string }).error ?? "", /regular file/);
      rmSync(activityFile);

      writeFileSync(activityFile, Buffer.alloc(MAX_ACTIVITY_FILE_BYTES + 1, 0x20));
      read = readSubagentActivityFile(activityFile, "special");
      assert.equal(read.ok, false);
      assert.match((read as { ok: false; error?: string }).error ?? "", /byte limit/);
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      lifecycle: createLifecycle(0),
      ...overrides,
    };
  }

  it("registers subagent_interrupt in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), true);
  });

  it("resolves interrupt targets by exact id and reports name ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byId = testApi.resolveInterruptTarget({ id: "c3", name: "Worker" });
      assert.equal(byId.running.id, "c3");

      const ambiguous = testApi.resolveInterruptTarget({ name: "Worker" });
      assert.match(ambiguous.error, /Ambiguous subagent name/);
    } finally {
      runningMap.clear();
    }
  });

  it("returns an explicit error when Escape delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to send Escape/);
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeLifecycle = observeLifecycleActivity(
      createLifecycle(0),
      {
        ok: true,
        activity: {
          version: 1,
          runningChildId: "a1",
          createdAt: 0,
          updatedAt: 5_000,
          sequence: 1,
          latestEvent: "tool_execution_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: true,
          activeScope: "tool",
          activeSince: 5_000,
          toolName: "bash",
        },
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ lifecycle: activeLifecycle }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        throw new Error("mux write failed");
      }));

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(projectLifecycle(runningMap.get("a1").lifecycle, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape without aborting or mutating running state", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    let sentSurface = "";
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, (surface: string) => {
      sentSurface = surface;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "a1");
      const activity = {
        version: 1,
        runningChildId: "a1",
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: 19_000,
        toolName: "bash",
      };
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

      try {
        runningMap.set("a1", makeRunning({ activityFile }));

        withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          sentSurface = surface;
        }));

        assert.equal(sentSurface, "pane-1");
        const lifecycle = runningMap.get("a1").lifecycle;
        const projection = projectLifecycle(lifecycle, 20_000);
        assert.equal(projection.kind, "interrupted");
        assert.equal(lifecycle.turn.kind, "interrupted");
        assert.equal(lifecycle.lastActivitySequence, 7);
        assert.equal(lifecycle.turn.previousActivitySequence, 7);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("completes a safely waiting manual child without sending Escape", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, {
        ...ASSISTANT_MSG,
        message: {
          ...ASSISTANT_MSG.message,
          stopReason: "stop",
          content: [{ type: "text", text: "Useful final answer." }],
        },
      }]);
      const activityFile = getSubagentActivityFile(dir, "a1");
      const controlFile = join(dir, "control", "a1.json");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "a1",
        activityFile,
        now: () => 10_000,
      });
      recorder.sessionStart();
      recorder.turnStart(1);
      recorder.agentEndWaiting({ outcome: "completed", hasAssistantText: true });
      let escapes = 0;

      try {
        runningMap.set("a1", makeRunning({ sessionFile, activityFile, controlFile }));
        const first = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
          escapes += 1;
        });
        const second = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
          escapes += 1;
        });

        assert.equal(escapes, 0);
        assert.equal(first.details.status, "completion_requested");
        assert.equal(first.details.repeated, false);
        assert.equal(second.details.status, "completion_requested");
        assert.equal(second.details.repeated, true);
        assert.equal(second.details.requestId, first.details.requestId);
        const request = readCompletionControlRequest(controlFile, "a1");
        assert.ok(request.ok);
        assert.equal(request.request.expectedActivitySequence, runningMap.get("a1").activity.sequence);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("refuses to complete an aborted waiting turn even when it contains partial text", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const activityFile = getSubagentActivityFile(dir, "a1");
      const controlFile = join(dir, "control", "a1.json");
      const recorder = createSubagentActivityRecorder({ runningChildId: "a1", activityFile });
      recorder.sessionStart();
      recorder.turnStart(1);
      recorder.agentEndWaiting({ outcome: "aborted", hasAssistantText: true });
      let escapes = 0;

      try {
        runningMap.set("a1", makeRunning({ sessionFile, activityFile, controlFile }));
        const result = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
          escapes += 1;
        });
        assert.equal(escapes, 0);
        assert.match(result.content[0].text, /not safely waiting/);
        assert.equal(existsSync(controlFile), false);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    const activeLifecycle = observeLifecycleActivity(
      createLifecycle(0),
      {
        ok: true,
        activity: {
          version: 1,
          runningChildId: "a1",
          createdAt: 0,
          updatedAt: 5_000,
          sequence: 1,
          latestEvent: "tool_execution_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: true,
          activeScope: "tool",
          activeSince: 5_000,
          toolName: "bash",
        },
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ lifecycle: activeLifecycle }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        sentSurface = surface;
      }));

      assert.equal(sentSurface, "pane-1");
      assert.match(result.content[0].text, /Interrupt requested for subagent "Worker"/);
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "interrupt_requested" });
      const projection = projectLifecycle(runningMap.get("a1").lifecycle, 20_000);
      assert.equal(projection.kind, "interrupted");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape again for repeated explicit turn-only interrupt requests", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const surfaces: string[] = [];
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning());

      testApi.handleSubagentInterrupt({ name: "Worker", finish: false }, (surface: string) => {
        surfaces.push(surface);
      });
      testApi.handleSubagentInterrupt({ name: "Worker", finish: false }, (surface: string) => {
        surfaces.push(surface);
      });

      assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("rejects Claude-backed interrupt requests before delivery", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let delivered = false;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ cli: "claude" }));

      const result = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        delivered = true;
      });

      assert.equal(delivered, false);
      assert.match(result.content[0].text, /currently supported only for Pi-backed subagents/i);
      assert.deepEqual(result.details, {
        error: "claude interrupt unsupported",
        id: "a1",
        name: "Worker",
      });
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: subagent_resume/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_resume/);
    assert.match(presentation, /Resume: subagent_resume/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("waiting-timeout parent supervision", () => {
  function makeWaitingRunning(params: {
    dir: string;
    outcome?: "completed" | "aborted" | "error";
    hasText?: boolean;
    waitTimeout?: number | "immediate" | null;
  }) {
    const id = "waiting-child";
    const sessionFile = createSessionFile(params.dir, [
      SESSION_HEADER,
      MODEL_CHANGE,
      USER_MSG,
      {
        ...ASSISTANT_MSG,
        message: {
          ...ASSISTANT_MSG.message,
          stopReason: params.outcome === "aborted" ? "aborted" : "stop",
          content: params.hasText === false ? [] : [{ type: "text", text: "Final timeout answer." }],
        },
      },
    ]);
    const activityFile = getSubagentActivityFile(params.dir, id);
    const recorder = createSubagentActivityRecorder({
      runningChildId: id,
      activityFile,
      now: () => 1_000,
    });
    recorder.sessionStart();
    recorder.turnStart(2);
    recorder.agentEndWaiting({
      outcome: params.outcome ?? "completed",
      hasAssistantText: params.hasText !== false,
    });
    return {
      id,
      name: "Waiting Worker",
      task: "",
      surface: "waiting-pane",
      startTime: 0,
      sessionFile,
      activityFile,
      interactive: true,
      waitTimeout: params.waitTimeout === undefined ? 1 : params.waitTimeout,
      waitTimeoutMessage: "preview",
      lifecycle: createLifecycle(0),
    };
  }

  it("emits one generation-bound steer with the available final answer", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const timeoutStates = testApi.waitingTimeoutStates as Map<string, any>;
    runningMap.clear();
    timeoutStates.clear();

    withTempDir((dir) => {
      const running = makeWaitingRunning({ dir });
      const { api, sentMessages } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      try {
        runningMap.set(running.id, running);
        testApi.runWaitingTimeoutTick(api, 2_000);
        testApi.runWaitingTimeoutTick(api, 3_000);

        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].message.customType, "subagent_waiting_timeout");
        assert.match(sentMessages[0].message.content, /Final timeout answer/);
        assert.match(sentMessages[0].message.content, /subagent_interrupt/);
        assert.equal(sentMessages[0].message.details.activitySequence, running.activity.sequence);
        assert.equal(sentMessages[0].message.details.turnIndex, 2);
        assert.equal(sentMessages[0].message.details.safelyCompletable, true);
        assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
      } finally {
        runningMap.clear();
        timeoutStates.clear();
      }
    });
  });

  it("notifies immediate mode on first observation and suppresses duplicates", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const timeoutStates = testApi.waitingTimeoutStates as Map<string, any>;
    runningMap.clear();
    timeoutStates.clear();

    withTempDir((dir) => {
      const running = makeWaitingRunning({ dir, waitTimeout: "immediate" });
      const { api } = createMockExtensionApi();
      const sent: any[] = [];
      (api as any).sendMessage = (message: any) => { sent.push(message); };
      (subagentsModule as any).default(api);
      try {
        runningMap.set(running.id, running);
        testApi.runWaitingTimeoutTick(api, 1_000);
        testApi.runWaitingTimeoutTick(api, 1_001);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].details.notificationKind, "initial");
        assert.equal(timeoutStates.get(running.id).notified, true);
      } finally {
        runningMap.clear();
        timeoutStates.clear();
      }
    });
  });

  it("retries immediate delivery after a failed send and rearms on a new generation", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const timeoutStates = testApi.waitingTimeoutStates as Map<string, any>;
    runningMap.clear();
    timeoutStates.clear();

    withTempDir((dir) => {
      const running = makeWaitingRunning({ dir, waitTimeout: "immediate" });
      const { api } = createMockExtensionApi();
      const sent: any[] = [];
      let attempts = 0;
      (api as any).sendMessage = (message: any) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient send failure");
        sent.push(message);
      };
      (subagentsModule as any).default(api);
      try {
        runningMap.set(running.id, running);
        testApi.runWaitingTimeoutTick(api, 1_000);
        testApi.runWaitingTimeoutTick(api, 1_001);
        assert.equal(attempts, 2);
        assert.equal(sent.length, 1);

        const recorder = createSubagentActivityRecorder({
          runningChildId: running.id,
          activityFile: running.activityFile,
          now: () => 2_000,
        });
        recorder.input();
        testApi.runWaitingTimeoutTick(api, 2_000);
        assert.equal(timeoutStates.has(running.id), false);

        recorder.turnStart(4);
        recorder.agentEndWaiting({ outcome: "completed", hasAssistantText: true });
        testApi.runWaitingTimeoutTick(api, 2_001);
        assert.equal(sent.length, 2);
        assert.equal(sent[1].details.notificationKind, "initial");
        assert.equal(sent[1].details.turnIndex, 4);
        assert.notEqual(sent[1].details.turnIndex, sent[0].details.turnIndex);
      } finally {
        runningMap.clear();
        timeoutStates.clear();
      }
    });
  });

  it("suppresses immediate notifications while the child is active", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const timeoutStates = testApi.waitingTimeoutStates as Map<string, any>;
    runningMap.clear();
    timeoutStates.clear();

    withTempDir((dir) => {
      const running = makeWaitingRunning({ dir, waitTimeout: "immediate" });
      const { api } = createMockExtensionApi();
      const sent: any[] = [];
      (api as any).sendMessage = (message: any) => { sent.push(message); };
      (subagentsModule as any).default(api);
      try {
        runningMap.set(running.id, running);
        const recorder = createSubagentActivityRecorder({
          runningChildId: running.id,
          activityFile: running.activityFile,
          now: () => 2_000,
        });
        recorder.input();
        testApi.runWaitingTimeoutTick(api, 2_000);
        assert.equal(sent.length, 0);
        assert.equal(timeoutStates.has(running.id), false);
      } finally {
        runningMap.clear();
        timeoutStates.clear();
      }
    });
  });

  it("retries failed steer delivery and accurately labels an aborted waiting turn", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const timeoutStates = testApi.waitingTimeoutStates as Map<string, any>;
    runningMap.clear();
    timeoutStates.clear();

    withTempDir((dir) => {
      const running = makeWaitingRunning({ dir, outcome: "aborted" });
      const { api } = createMockExtensionApi();
      const sent: any[] = [];
      let attempts = 0;
      (api as any).sendMessage = (message: any) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient send failure");
        sent.push(message);
      };
      (subagentsModule as any).default(api);
      try {
        runningMap.set(running.id, running);
        testApi.runWaitingTimeoutTick(api, 2_000);
        testApi.runWaitingTimeoutTick(api, 2_001);

        assert.equal(attempts, 2);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].details.safelyCompletable, false);
        assert.doesNotMatch(sent[0].content, /You may accept the waiting answer/);
        assert.match(sent[0].content, /not currently safe to accept/);
      } finally {
        runningMap.clear();
        timeoutStates.clear();
      }
    });
  });

  it("coexists with immediate delivery without creating a periodic reminder", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const timeoutStates = testApi.waitingTimeoutStates as Map<string, any>;
    runningMap.clear();
    timeoutStates.clear();

    withTempDir((dir) => {
      const running = makeWaitingRunning({ dir, waitTimeout: "immediate" });
      const { api } = createMockExtensionApi();
      const sent: any[] = [];
      (api as any).sendMessage = (message: any) => { sent.push(message); };
      (subagentsModule as any).default(api);
      try {
        runningMap.set(running.id, running);
        testApi.runWaitingTimeoutTick(api, 1_000);
        assert.equal(sent.length, 1);

        const result = withMockedNow(2_000, () =>
          testApi.handleSubagentSnooze({ id: running.id, seconds: 5 }),
        );
        assert.equal(result.details.status, "snoozed");
        testApi.runWaitingTimeoutTick(api, 6_999);
        assert.equal(sent.length, 1);
        testApi.runWaitingTimeoutTick(api, 7_000);
        testApi.runWaitingTimeoutTick(api, 8_000);
        assert.equal(sent.length, 2);
        assert.equal(sent[1].details.notificationKind, "snooze");
      } finally {
        runningMap.clear();
        timeoutStates.clear();
      }
    });
  });

  it("snoozes exactly once for the current generation and invalidates on new activity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const timeoutStates = testApi.waitingTimeoutStates as Map<string, any>;
    runningMap.clear();
    timeoutStates.clear();

    withTempDir((dir) => {
      const running = makeWaitingRunning({ dir });
      running.waitTimeout = null;
      const { api } = createMockExtensionApi();
      const sent: any[] = [];
      (api as any).sendMessage = (message: any) => { sent.push(message); };
      (subagentsModule as any).default(api);
      try {
        runningMap.set(running.id, running);
        const result = withMockedNow(2_000, () =>
          testApi.handleSubagentSnooze({ id: running.id, seconds: 5 }),
        );
        assert.equal(result.details.status, "snoozed");
        testApi.runWaitingTimeoutTick(api, 6_999);
        testApi.runWaitingTimeoutTick(api, 7_000);
        testApi.runWaitingTimeoutTick(api, 8_000);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].details.notificationKind, "snooze");

        const recorder = createSubagentActivityRecorder({
          runningChildId: running.id,
          activityFile: running.activityFile,
          now: () => 9_000,
        });
        recorder.sessionStart();
        recorder.input();
        testApi.runWaitingTimeoutTick(api, 100_000);
        assert.equal(sent.length, 1);
        assert.equal(timeoutStates.has(running.id), false);
      } finally {
        runningMap.clear();
        timeoutStates.clear();
      }
    });
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("projects Claude agents as running and counts them as active", () => {
    const testApi = (subagentsModule as any).__test__;
    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([{
        id: "c1",
        name: "Claude",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        cli: "claude",
        lifecycle: { ...createLifecycle(5_000), process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 } },
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 active/);
      assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
      assert.match(lines[1], /running/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("shows interrupted agents as open while process runtime continues", () => {
    const testApi = (subagentsModule as any).__test__;
    const interruptedAt = 20_000;
    const lifecycle = markInterruptRequested(
      { ...createLifecycle(5_000), process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 } },
      interruptedAt,
    );

    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([{
        id: "a1",
        name: "Worker",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        lifecycle,
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 open/);
      assert.ok(lines[0].includes("\x1b[38;2;214;158;46m"));
      assert.match(lines[1], /00:25\s+Worker/);
      assert.match(lines[1], /interrupted 10s/);
      assert.doesNotMatch(lines.join("\n"), /running|active/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("hydrates legacy activity done as waiting, not finalizing", () => {
    const testApi = (subagentsModule as any).__test__;
    const doneAt = 20_000;
    const legacyDone = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 5_000 }),
      {
        snapshot: "present",
        updatedAt: doneAt,
        sequence: 1,
        phase: "done",
        latestEvent: "subagent_done",
      },
      doneAt,
    );
    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([{
        id: "legacy",
        name: "Legacy",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        statusState: legacyDone,
        interactive: false,
      }], 64);
      assert.match(lines[1], /waiting/);
      assert.doesNotMatch(lines[1], /finalizing/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("freezes runtime when the subagent reports done", () => {
    const testApi = (subagentsModule as any).__test__;
    const doneAt = 20_000;
    const lifecycle = markCompletionDetected(createLifecycle(5_000), { reason: "done", exitCode: 0 }, doneAt);

    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([{
        id: "a1",
        name: "Reviewer",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        lifecycle,
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 open/);
      assert.match(lines[1], /00:15\s+Reviewer/);
      assert.match(lines[1], /finalizing…/);
      assert.doesNotMatch(lines[1], /00:25/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps a blue border and summarizes mixed active and open agents", () => {
    const testApi = (subagentsModule as any).__test__;
    const now = 30_000;
    const active = observeLifecycleActivity(
      createLifecycle(5_000),
      {
        ok: true,
        activity: {
          version: 1,
          runningChildId: "a1",
          createdAt: 5_000,
          updatedAt: 29_000,
          sequence: 1,
          latestEvent: "agent_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: false,
          activeScope: "agent",
          activeSince: 29_000,
        },
      },
      29_000,
    );
    const interrupted = markInterruptRequested(
      { ...createLifecycle(10_000), process: { kind: "running", startedAt: 10_000, confirmedAt: 10_000 } },
      20_000,
    );

    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        { id: "a1", name: "Active", task: "", surface: "s1", startTime: 5_000, sessionFile: "s1", lifecycle: active, interactive: false },
        { id: "a2", name: "Open", task: "", surface: "s2", startTime: 10_000, sessionFile: "s2", lifecycle: interrupted, interactive: false },
      ], 72);

      assert.match(lines[0], /1 active · 1 open/);
      assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          lifecycle: createLifecycle(1_000_000 - 13_000),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          lifecycle: createLifecycle(1_000_000 - 21_000),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          lifecycle: createLifecycle(1_000_000 - 27_000),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          lifecycle: createLifecycle(startTime),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("herdr.ts", () => {
  describe("isHerdrAvailable", () => {
    it("returns boolean based on HERDR_ENV", () => {
      const result = isHerdrAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("herdr command construction", () => {
    it("targets the current workspace when creating a subagent tab", () => {
      assert.deepEqual(__herdrTest__.buildTabCreateArgs("reviewer", "/repo", "workspace-2"), [
        "tab",
        "create",
        "--workspace",
        "workspace-2",
        "--label",
        "reviewer",
        "--cwd",
        "/repo",
        "--no-focus",
      ]);
    });
  });

  describe("herdr response parsing", () => {
    it("extracts pane id from a pane split response", () => {
      const output = JSON.stringify({
        result: {
          pane: {
            pane_id: "1-3",
            tab_id: "1:2",
            workspace_id: "1",
          },
        },
      });
      assert.equal(__herdrTest__.extractHerdrPaneId(output, "pane split"), "1-3");
    });

    it("extracts root pane id from a tab create response", () => {
      const output = JSON.stringify({
        result: {
          tab: { tab_id: "1:2" },
          root_pane: { pane_id: "1-2" },
        },
      });
      assert.equal(__herdrTest__.extractHerdrRootPaneId(output, "tab create"), "1-2");
    });

    it("throws on malformed herdr JSON", () => {
      assert.throws(
        () => __herdrTest__.extractHerdrPaneId("not json", "pane split"),
        /Unexpected herdr pane split output/,
      );
    });

    it("parses pane-not-found JSON from stderr-shaped errors", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
        stdout: "",
      });
      assert.deepEqual(result, { kind: "missing", error: "pane gone" });
    });

    it("continues from non-JSON stderr to structured stdout", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "warning: connection closed",
        stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
      });
      assert.deepEqual(result, { kind: "missing", error: "pane gone" });
    });

    it("returns unavailable when both error streams are non-JSON", () => {
      const result = __herdrTest__.parsePaneGetError({
        message: "command failed",
        stderr: "warning: connection closed",
        stdout: "not json either",
      });
      assert.deepEqual(result, { kind: "unavailable", error: "command failed" });
    });

    it("recognizes plain-text pane_not_found on stderr", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "pane_not_found: pane w1:p1 not found",
        stdout: "unrelated output",
      });
      assert.deepEqual(result, {
        kind: "missing",
        error: "pane_not_found: pane w1:p1 not found",
      });
    });

    it("recognizes plain-text not_found on stdout after malformed stderr", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "{malformed json",
        stdout: "not_found: pane w1:p1",
      });
      assert.deepEqual(result, { kind: "missing", error: "not_found: pane w1:p1" });
    });

    it("normalizes unknown agent_status values", () => {
      const result = __herdrTest__.parsePaneGetOutput(JSON.stringify({
        result: { pane: { pane_id: "w1:p1", agent: "pi", agent_status: "paused" } },
      }), "w1:p1");
      assert.deepEqual(result, { kind: "present", agent: "pi", agentStatus: "unknown" });
    });
  });
});
