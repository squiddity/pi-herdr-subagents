import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertExtensionRuntimeSupported,
  buildPiExtensionArgs,
  getExtensionRuntimeEnv,
  readExtensionRuntimeSidecar,
  resolveExtensionRuntime,
  resolveResumeExtensionRuntime,
  writeExtensionRuntimeSidecar,
} from "../pi-extension/subagents/extension-runtime.ts";

const entries = {
  subagentsEntry: "/package/pi-extension/subagents/index.ts",
  subagentDoneEntry: "/package/pi-extension/subagents/subagent-done.ts",
};

describe("recursive extension runtime", () => {
  it("defaults to normal discovery with no caller extensions", () => {
    assert.deepEqual(
      resolveExtensionRuntime({}, "/workspace", {}),
      { extensionMode: "normal", extensions: [] },
    );
    assert.deepEqual(
      buildPiExtensionArgs({ extensionMode: "normal", extensions: [] }, entries),
      ["-e", entries.subagentDoneEntry],
    );
  });

  it("keeps normal discovery while adding caller-specified extension entries", () => {
    assert.deepEqual(
      buildPiExtensionArgs({ extensionMode: "normal", extensions: ["/workspace/custom.ts"] }, entries),
      ["-e", entries.subagentDoneEntry, "-e", "/workspace/custom.ts"],
    );
  });

  it("builds explicit launches with discovery disabled and mandatory entries first", () => {
    const runtime = resolveExtensionRuntime(
      { extensionMode: "explicit", extensions: "./dev.ts,../shared.ts,./dev.ts" },
      "/workspace/child",
      {},
    );

    assert.deepEqual(runtime, {
      extensionMode: "explicit",
      extensions: ["/workspace/child/dev.ts", "/workspace/shared.ts"],
    });
    assert.deepEqual(buildPiExtensionArgs(runtime, entries), [
      "--no-extensions",
      "-e", entries.subagentsEntry,
      "-e", entries.subagentDoneEntry,
      "-e", "/workspace/child/dev.ts",
      "-e", "/workspace/shared.ts",
    ]);
  });

  it("deduplicates caller paths against mandatory extension entries", () => {
    assert.deepEqual(
      buildPiExtensionArgs({
        extensionMode: "explicit",
        extensions: [entries.subagentsEntry, entries.subagentDoneEntry, "/extra.ts", "/extra.ts"],
      }, entries),
      [
        "--no-extensions",
        "-e", entries.subagentsEntry,
        "-e", entries.subagentDoneEntry,
        "-e", "/extra.ts",
      ],
    );
  });

  it("inherits mode and absolute paths independently while allowing overrides", () => {
    const inherited = {
      extensionMode: "explicit",
      extensions: "/parent/a.ts,/parent/b.ts",
    };

    assert.deepEqual(resolveExtensionRuntime({}, "/descendant", inherited), {
      extensionMode: "explicit",
      extensions: ["/parent/a.ts", "/parent/b.ts"],
    });
    assert.deepEqual(
      resolveExtensionRuntime({ extensionMode: "normal" }, "/descendant", inherited),
      { extensionMode: "normal", extensions: ["/parent/a.ts", "/parent/b.ts"] },
    );
    assert.deepEqual(
      resolveExtensionRuntime({ extensions: "./replacement.ts" }, "/descendant", inherited),
      { extensionMode: "explicit", extensions: ["/descendant/replacement.ts"] },
    );
    assert.deepEqual(
      resolveExtensionRuntime({ extensions: "" }, "/descendant", inherited),
      { extensionMode: "explicit", extensions: [] },
    );
  });

  it("exports only resolved absolute caller paths to descendants", () => {
    assert.deepEqual(getExtensionRuntimeEnv({
      extensionMode: "explicit",
      extensions: ["/workspace/a.ts", "/workspace/b.ts"],
    }), {
      PI_SUBAGENT_EXTENSION_MODE: "explicit",
      PI_SUBAGENT_EXTENSIONS: "/workspace/a.ts,/workspace/b.ts",
    });
  });

  it("rejects extension settings for Claude-backed children", () => {
    assert.doesNotThrow(() => assertExtensionRuntimeSupported("claude", {}));
    assert.throws(
      () => assertExtensionRuntimeSupported("claude", { extensionMode: "explicit" }),
      /supported only for Pi-backed subagents/,
    );
    assert.throws(
      () => assertExtensionRuntimeSupported("claude", { extensions: "" }),
      /supported only for Pi-backed subagents/,
    );
  });

  it("persists the exact runtime and mandatory source entries for opted-in resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-extension-runtime-"));
    const sessionPath = join(dir, "child.jsonl");
    const runtime = {
      extensionMode: "explicit" as const,
      extensions: ["/workspace/dev-extension.ts"],
    };

    try {
      writeExtensionRuntimeSidecar(sessionPath, runtime, entries);
      const resumed = readExtensionRuntimeSidecar(sessionPath);
      assert.deepEqual(resumed, { runtime, entries });
      assert.deepEqual(buildPiExtensionArgs(resumed!.runtime, resumed!.entries), [
        "--no-extensions",
        "-e", entries.subagentsEntry,
        "-e", entries.subagentDoneEntry,
        "-e", "/workspace/dev-extension.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores adjacent executable metadata by default and consumes it only with opt-in", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-extension-runtime-trust-"));
    const sessionPath = join(dir, "downloaded.jsonl");
    const recorded = {
      runtime: { extensionMode: "explicit" as const, extensions: ["/untrusted/payload.ts"] },
      entries,
    };
    const fallback = {
      runtime: { extensionMode: "normal" as const, extensions: [] },
      entries: {
        subagentsEntry: "/current/index.ts",
        subagentDoneEntry: "/current/subagent-done.ts",
      },
    };

    try {
      writeExtensionRuntimeSidecar(sessionPath, recorded.runtime, recorded.entries);
      assert.deepEqual(resolveResumeExtensionRuntime({
        sessionPath,
        preserveExtensionRuntime: false,
        fallback,
      }), fallback);
      assert.deepEqual(resolveResumeExtensionRuntime({
        sessionPath,
        preserveExtensionRuntime: true,
        fallback,
      }), recorded);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects old, malformed, and relative-path runtime sidecars", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-extension-runtime-invalid-"));
    const sessionPath = join(dir, "child.jsonl");
    const sidecarPath = `${sessionPath}.subagent-runtime.json`;

    try {
      writeFileSync(sidecarPath, JSON.stringify({
        version: 1,
        extensionMode: "explicit",
        extensions: ["/old.ts"],
      }));
      assert.equal(readExtensionRuntimeSidecar(sessionPath), null);

      writeFileSync(sidecarPath, JSON.stringify({
        version: 2,
        runtime: { extensionMode: "explicit", extensions: ["relative.ts"] },
        entries,
      }));
      assert.equal(readExtensionRuntimeSidecar(sessionPath), null);

      writeFileSync(sidecarPath, "not json");
      assert.equal(readExtensionRuntimeSidecar(sessionPath), null);
      assert.throws(() => resolveResumeExtensionRuntime({
        sessionPath,
        preserveExtensionRuntime: true,
        fallback: { runtime: { extensionMode: "normal", extensions: [] }, entries },
      }), /no valid version-2 runtime sidecar/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
