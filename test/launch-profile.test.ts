import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
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
  attestLaunchProfile,
  buildResumeProfileLaunch,
  compareToolProfile,
  formatToolProfileEvidence,
  getLaunchProfilePath,
  loadOrCreateHostAttestationKey,
  MAX_PROFILE_BYTES,
  PROFILE_ATTESTATION_CUSTOM_TYPE,
  readLaunchProfile,
  validateLaunchProfile,
  writeLaunchProfile,
  type SubagentLaunchProfile,
  type UnsignedSubagentLaunchProfile,
} from "../pi-extension/subagents/launch-profile.ts";

const unsignedProfile: UnsignedSubagentLaunchProfile = {
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

function fixture(dir: string): {
  session: string;
  key: Buffer;
  profile: SubagentLaunchProfile;
  path: string;
} {
  const session = join(dir, "child.jsonl");
  const key = Buffer.alloc(32, 0x5a);
  const profile = attestLaunchProfile(session, unsignedProfile, key, "ab".repeat(32));
  writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "session-1" })}\n`);
  appendFileSync(session, `${JSON.stringify({
    type: "custom",
    id: "attestation-1",
    parentId: null,
    customType: PROFILE_ATTESTATION_CUSTOM_TYPE,
    data: { version: 1, ...profile.attestation },
  })}\n`);
  const path = writeLaunchProfile(session, profile);
  return { session, key, profile, path };
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
  it("round-trips only with a valid host signature and matching session metadata", () => {
    withTempDir((dir) => {
      const { session, key, profile, path } = fixture(dir);
      assert.equal(path, `${session}.profile.json`);
      assert.deepEqual(readLaunchProfile(session, key), { status: "verified", profile, path });
    });
  });

  it("round-trips immediate waiting policy and rejects tampering", () => {
    withTempDir((dir) => {
      const session = join(dir, "immediate-child.jsonl");
      const key = Buffer.alloc(32, 0x5a);
      const profile = attestLaunchProfile(
        session,
        { ...unsignedProfile, waitTimeout: "immediate" },
        key,
        "cd".repeat(32),
      );
      writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "session-1" })}\n`);
      appendFileSync(session, `${JSON.stringify({
        type: "custom",
        id: "attestation-immediate",
        parentId: null,
        customType: PROFILE_ATTESTATION_CUSTOM_TYPE,
        data: { version: 1, ...profile.attestation },
      })}\n`);
      const path = writeLaunchProfile(session, profile);
      const verified = readLaunchProfile(session, key);
      assert.equal(verified.status, "verified");
      if (verified.status === "verified") {
        assert.equal(verified.profile.waitTimeout, "immediate");
        assert.equal(buildResumeProfileLaunch(session, verified.profile).env.PI_SUBAGENT_PROFILE_ATTESTATION.includes(profile.attestation.signature), true);
      }

      writeFileSync(path, `${JSON.stringify({ ...profile, waitTimeout: 30 })}\n`);
      const tampered = readLaunchProfile(session, key);
      assert.equal(tampered.status, "untrusted");
      if (tampered.status === "untrusted") assert.match(tampered.error, /signature/);
    });
  });

  it("rejects schema-valid arbitrary and tampered executable/config fields", () => {
    withTempDir((dir) => {
      const { session, key, profile, path } = fixture(dir);
      const mutations = [
        { ...profile, extensionEntries: [...profile.extensionEntries, "/tmp/payload.ts"] },
        { ...profile, configRoot: "/tmp/attacker-config" },
        { ...profile, cwd: "/tmp/attacker-cwd" },
        { ...profile, allowedChildAgents: ["reviewer"] },
        { ...profile, waitTimeout: 121 },
        { ...profile, waitTimeout: "immediate" as const },
        { ...profile, waitTimeoutMessage: "full" as const },
      ];
      for (const mutation of mutations) {
        writeFileSync(path, `${JSON.stringify(mutation)}\n`);
        const result = readLaunchProfile(session, key);
        assert.equal(result.status, "untrusted");
        if (result.status === "untrusted") assert.match(result.error, /signature/);
      }

      const attackerProfile = attestLaunchProfile(session, unsignedProfile, Buffer.alloc(32, 0x33));
      writeFileSync(path, `${JSON.stringify(attackerProfile)}\n`);
      assert.equal(readLaunchProfile(session, key).status, "untrusted");
    });
  });

  it("round-trips and validates an attested immediate waiting policy", () => {
    withTempDir((dir) => {
      const session = join(dir, "immediate-child.jsonl");
      const immediate = attestLaunchProfile(
        session,
        { ...unsignedProfile, waitTimeout: "immediate" },
        Buffer.alloc(32, 0x5a),
        "cd".repeat(32),
      );
      assert.equal(validateLaunchProfile(immediate).waitTimeout, "immediate");
      assert.equal(validateLaunchProfile(immediate).waitTimeoutMessage, "preview");
    });
  });

  it("requires the same attestation inside the bound session metadata", () => {
    withTempDir((dir) => {
      const session = join(dir, "child.jsonl");
      const key = Buffer.alloc(32, 0x5a);
      const profile = attestLaunchProfile(session, unsignedProfile, key);
      writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "session-1" })}\n`);
      writeLaunchProfile(session, profile);
      const result = readLaunchProfile(session, key);
      assert.equal(result.status, "untrusted");
      if (result.status === "untrusted") assert.match(result.error, /session metadata/);
    });
  });

  it("distinguishes absent profiles and rejects malformed or sensitive fields", () => {
    withTempDir((dir) => {
      const session = join(dir, "child.jsonl");
      writeFileSync(session, "{}\n");
      const key = Buffer.alloc(32, 0x5a);
      assert.deepEqual(readLaunchProfile(session, key), {
        status: "absent",
        path: getLaunchProfilePath(session),
      });

      writeFileSync(getLaunchProfilePath(session), JSON.stringify({ ...unsignedProfile, task: "secret prompt" }));
      const malformed = readLaunchProfile(session, key);
      assert.equal(malformed.status, "malformed");
      if (malformed.status === "malformed") assert.match(malformed.error, /unsupported fields: task/);

      const attested = attestLaunchProfile(session, unsignedProfile, key);
      assert.throws(
        () => validateLaunchProfile({ ...attested, grants: ["credential"] }),
        /unsupported fields: grants/,
      );
      assert.throws(
        () => validateLaunchProfile({ ...attested, extensionEntries: ["./relative.ts"] }),
        /must be absolute/,
      );
      assert.throws(
        () => validateLaunchProfile({ ...attested, waitTimeout: 0 }),
        /waitTimeout must be an integer/,
      );
      assert.throws(
        () => validateLaunchProfile({ ...attested, waitTimeoutMessage: "everything" }),
        /waitTimeoutMessage must be/,
      );
    });
  });

  it("rejects symlink, FIFO, directory, and oversized profile inputs without blocking", () => {
    withTempDir((dir) => {
      const session = join(dir, "child.jsonl");
      writeFileSync(session, "{}\n");
      const key = Buffer.alloc(32, 0x5a);
      const path = getLaunchProfilePath(session);
      const target = join(dir, "target.json");
      writeFileSync(target, "{}\n");
      symlinkSync(target, path);
      let result = readLaunchProfile(session, key);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /symbolic link/);
      rmSync(path);

      mkdirSync(path);
      result = readLaunchProfile(session, key);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /regular file/);
      rmSync(path, { recursive: true });

      execFileSync("mkfifo", [path]);
      result = readLaunchProfile(session, key);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /regular file/);
      rmSync(path);

      writeFileSync(path, Buffer.alloc(MAX_PROFILE_BYTES + 1, 0x20));
      result = readLaunchProfile(session, key);
      assert.equal(result.status, "malformed");
      if (result.status === "malformed") assert.match(result.error, /byte limit/);
    });
  });

  it("enforces the serialized profile size before creating a sidecar", () => {
    withTempDir((dir) => {
      const session = join(dir, "child.jsonl");
      const hugeEntries = Array.from(
        { length: 64 },
        (_, index) => `/${index}-${"x".repeat(3000)}`,
      );
      const huge = attestLaunchProfile(
        session,
        { ...unsignedProfile, extensionEntries: hugeEntries },
        Buffer.alloc(32, 0x5a),
      );
      assert.throws(() => writeLaunchProfile(session, huge), /serialized launch profile exceeds/);
      assert.equal(existsSync(getLaunchProfilePath(session)), false);
    });
  });

  it("creates a stable private host key and rejects unsafe key files", () => {
    withTempDir((dir) => {
      const keyPath = join(dir, "keys", "host.key");
      const first = loadOrCreateHostAttestationKey(keyPath);
      assert.equal(first.length, 32);
      assert.deepEqual(loadOrCreateHostAttestationKey(keyPath), first);

      chmodSync(keyPath, 0o644);
      assert.throws(() => loadOrCreateHostAttestationKey(keyPath), /permissions/);
      rmSync(keyPath);
      const target = join(dir, "target-key");
      writeFileSync(target, `${"ab".repeat(32)}\n`, { mode: 0o600 });
      symlinkSync(target, keyPath);
      assert.throws(() => loadOrCreateHostAttestationKey(keyPath), /symbolic link/);
    });
  });

  it("reconstructs an absolute resume command and restores named-agent identity", () => {
    withTempDir((dir) => {
      const { profile } = fixture(dir);
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
      assert.equal(profile.waitTimeout, 120);
      assert.equal(profile.waitTimeoutMessage, "preview");
      assert.match(launch.env.PI_SUBAGENT_PROFILE_ATTESTATION, /"signature"/);
    });
  });

  it("requires telemetry, applies deny intersection, and reports deny drift", () => {
    withTempDir((dir) => {
      const { profile } = fixture(dir);
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
  });

  it("calls a no-allowlist profile unrestricted only after verified deny checks", () => {
    withTempDir((dir) => {
      const { profile } = fixture(dir);
      const unrestrictedProfile = { ...profile, toolAllowlist: null };
      assert.equal(compareToolProfile(unrestrictedProfile, ["read"]).status, "unverified");
      assert.equal(
        compareToolProfile(
          unrestrictedProfile,
          ["read"],
          ["subagent", "subagent_resume"],
        ).status,
        "unrestricted",
      );
      assert.equal(
        compareToolProfile(
          unrestrictedProfile,
          ["read", "subagent"],
          ["subagent", "subagent_resume"],
        ).status,
        "mismatch",
      );
      assert.equal(compareToolProfile(null, ["read"], []).status, "unverified");
    });
  });
});
