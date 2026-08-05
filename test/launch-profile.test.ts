import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildResumeProfileLaunch,
  compareToolProfile,
  formatToolProfileEvidence,
  getLaunchProfilePath,
  MAX_PROFILE_BYTES,
  readLaunchProfile,
  validateLaunchProfile,
  writeLaunchProfile,
  type SubagentLaunchProfile,
} from "../pi-extension/subagents/launch-profile.ts";

const profile: SubagentLaunchProfile = {
  version: 1,
  model: "openai/gpt-test",
  thinking: "high",
  cwd: "/workspace/child",
  agent: "reviewer",
  toolAllowlist: ["read", "bash", "subagent", "caller_ping", "subagent_done"],
  deniedTools: ["subagent", "subagent_resume"],
  extensionMode: "explicit",
  extensionEntries: [
    "/package/pi-extension/subagents/index.ts",
    "/package/pi-extension/subagents/subagent-done.ts",
    "/workspace/tools/example-child-extension.ts",
  ],
  inheritedExtensionEntries: ["/workspace/tools/example-child-extension.ts"],
  configRoot: "/workspace/child/.pi/agent",
  allowedChildAgents: ["child-reader"],
  waitTimeout: 120,
  waitTimeoutMessage: "preview",
};

function fixture(dir: string): { session: string; path: string } {
  const session = join(dir, "child.jsonl");
  writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "session-1" })}\n`);
  const path = writeLaunchProfile(session, profile);
  return { session, path };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "subagent-profile-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Pi subagent launch profiles", () => {
  it("round-trips a bounded policy profile including waiting settings", () => {
    withTempDir((dir) => {
      const { session, path } = fixture(dir);
      assert.equal(path, `${session}.profile.json`);
      assert.deepEqual(readLaunchProfile(session), { status: "loaded", profile, path });

      const immediate = { ...profile, waitTimeout: "immediate" as const };
      assert.equal(validateLaunchProfile(immediate).waitTimeout, "immediate");
      assert.equal(validateLaunchProfile(immediate).waitTimeoutMessage, "preview");
    });
  });

  it("distinguishes absent profiles and rejects malformed or sensitive fields", () => {
    withTempDir((dir) => {
      const session = join(dir, "child.jsonl");
      writeFileSync(session, "{}\n");
      assert.deepEqual(readLaunchProfile(session), {
        status: "absent",
        path: getLaunchProfilePath(session),
      });

      writeFileSync(getLaunchProfilePath(session), JSON.stringify({ ...profile, task: "secret prompt" }));
      const malformed = readLaunchProfile(session);
      assert.equal(malformed.status, "malformed");
      if (malformed.status === "malformed") assert.match(malformed.error, /unsupported fields: task/);

      assert.throws(
        () => validateLaunchProfile({ ...profile, grants: ["credential"] }),
        /unsupported fields: grants/,
      );
      assert.throws(
        () => validateLaunchProfile({ ...profile, extensionEntries: ["./relative.ts"] }),
        /must be absolute/,
      );
      assert.throws(
        () => validateLaunchProfile({ ...profile, waitTimeout: 0 }),
        /waitTimeout must be an integer/,
      );
      assert.throws(
        () => validateLaunchProfile({ ...profile, waitTimeoutMessage: "everything" }),
        /waitTimeoutMessage must be/,
      );
    });
  });

  it("rejects symlink, FIFO, directory, and oversized profile inputs without blocking", () => {
    withTempDir((dir) => {
      const session = join(dir, "child.jsonl");
      writeFileSync(session, "{}\n");
      const path = getLaunchProfilePath(session);
      const target = join(dir, "target.json");
      writeFileSync(target, "{}\n");
      symlinkSync(target, path);
      let result = readLaunchProfile(session);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /symbolic link/);
      rmSync(path);

      mkdirSync(path);
      result = readLaunchProfile(session);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /regular file/);
      rmSync(path, { recursive: true });

      execFileSync("mkfifo", [path]);
      result = readLaunchProfile(session);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /regular file/);
      rmSync(path);

      writeFileSync(path, Buffer.alloc(MAX_PROFILE_BYTES + 1, 0x20));
      result = readLaunchProfile(session);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /byte limit/);
    });
  });

  it("enforces the serialized profile size before creating a sidecar", () => {
    withTempDir((dir) => {
      const session = join(dir, "child.jsonl");
      const hugeEntries = Array.from({ length: 64 }, (_, index) => `/${index}-${"x".repeat(3000)}`);
      assert.throws(
        () => writeLaunchProfile(session, { ...profile, extensionEntries: hugeEntries }),
        /serialized launch profile exceeds/,
      );
      assert.equal(existsSync(getLaunchProfilePath(session)), false);
    });
  });

  it("reconstructs an absolute resume command and restores policy identity", () => {
    const session = resolve("sessions/child.jsonl");
    const launch = buildResumeProfileLaunch(session, profile);
    assert.deepEqual(launch.args, [
      "pi", "--session", session,
      "--no-extensions",
      "-e", "/package/pi-extension/subagents/index.ts",
      "-e", "/package/pi-extension/subagents/subagent-done.ts",
      "-e", "/workspace/tools/example-child-extension.ts",
      "--model", "openai/gpt-test",
      "--thinking", "high",
      "--tools", "read,bash,subagent,caller_ping,subagent_done",
    ]);
    assert.equal(launch.env.PI_SUBAGENT_AGENT, "reviewer");
    assert.equal(launch.env.PI_SUBAGENT_ALLOWED_CHILD_AGENTS, '["child-reader"]');
    assert.equal(buildResumeProfileLaunch(session, { ...profile, agent: null }).env.PI_SUBAGENT_AGENT, "");
    assert.equal(launch.env.PI_CODING_AGENT_DIR, "/workspace/child/.pi/agent");
    assert.equal(launch.env.PI_DENY_TOOLS, "subagent,subagent_resume");
  });

  it("requires telemetry, applies deny intersection, and reports deny drift", () => {
    const exact = compareToolProfile(
      profile,
      ["subagent_done", "read", "caller_ping", "bash"],
      ["subagent_resume", "subagent"],
    );
    assert.equal(exact.status, "exact");
    assert.deepEqual(exact.expected, ["bash", "caller_ping", "read", "subagent_done"]);
    assert.match(formatToolProfileEvidence(exact), /post-deny launch allowlist/);

    const missingTelemetry = compareToolProfile(profile, ["read"]);
    assert.equal(missingTelemetry.status, "unverified");
    assert.match(formatToolProfileEvidence(missingTelemetry), /telemetry are required/);

    const denyDrift = compareToolProfile(profile, ["read"], ["subagent"]);
    assert.equal(denyDrift.status, "mismatch");
    assert.deepEqual(denyDrift.deniedMissing, ["subagent_resume"]);

    const deniedActive = compareToolProfile(
      profile,
      ["read", "subagent"],
      ["subagent", "subagent_resume"],
    );
    assert.equal(deniedActive.status, "mismatch");
    assert.deepEqual(deniedActive.activeDenied, ["subagent"]);
    assert.match(formatToolProfileEvidence(deniedActive), /denied-active/);
  });

  it("calls a no-allowlist profile unrestricted only after matching deny checks", () => {
    const unrestrictedProfile = { ...profile, toolAllowlist: null };
    assert.equal(compareToolProfile(unrestrictedProfile, ["read"]).status, "unverified");
    assert.equal(
      compareToolProfile(unrestrictedProfile, ["read"], ["subagent", "subagent_resume"]).status,
      "unrestricted",
    );
    assert.equal(
      compareToolProfile(unrestrictedProfile, ["read", "subagent"], ["subagent", "subagent_resume"]).status,
      "mismatch",
    );
    assert.equal(compareToolProfile(null, ["read"], []).status, "unverified");
  });
});
