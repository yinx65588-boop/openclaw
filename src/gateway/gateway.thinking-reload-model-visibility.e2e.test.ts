import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import * as visibility from "../agents/model-visibility-policy.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as presentation from "./operator-model-presentation.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it("avoids rebuilding model visibility when changing only one agent's thinking level", async () => {
  await using state = await createStartupTestState("thinking-reload-proof", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  });
  const token = "thinking-reload-proof-token";
  const entries = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [i === 0 ? "main" : `agent-${i}`, {}]),
  );
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "openai/gpt-4o" },
        modelPolicy: { allow: ["openai/gpt-4o"] },
      },
      entries,
    },
    gateway: { auth: { mode: "token", token } },
    plugins: { slots: { memory: "none" } },
  };
  const compare = presentation.modelSelectionPoliciesMatch;
  const observations: { builds: number; equal: boolean; elapsedMs: number }[] = [];
  using build = vi.spyOn(visibility, "createModelVisibilityPolicy");
  using compareSpy = vi.spyOn(presentation, "modelSelectionPoliciesMatch").mockImplementation(
    (...args) => {
      const before = build.mock.calls.length;
      const start = performance.now();
      const equal = compare(...args);
      observations.push({
        builds: build.mock.calls.length - before,
        equal,
        elapsedMs: performance.now() - start,
      });
      return equal;
    },
  );
  const gateway = await startGatewayWithClient({
    cfg,
    configPath: state.path("openclaw.json"),
    token,
  });
  try {
    await gateway.server.startupSettled;
    observations.length = 0;
    const patch = async (agents: NonNullable<OpenClawConfig["agents"]>) => {
      const { hash } = await gateway.client.request<{ hash: string }>("config.get", {});
      await gateway.client.request("config.patch", {
        baseHash: hash,
        raw: JSON.stringify({ agents }),
      });
    };
    await patch({ entries: { main: { thinkingDefault: "low" } } });
    await expect.poll(() => observations.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(getRuntimeConfig().agents?.entries?.main?.thinkingDefault).toBe("low");
    expect(Object.keys(getRuntimeConfig().agents?.entries ?? {})).toHaveLength(32);
    const thinkingOnly = observations.splice(0);
    expect(thinkingOnly.every(({ equal }) => equal)).toBe(true);

    await patch({ defaults: { modelPolicy: { allow: ["openai/gpt-4o-mini"] } } });
    await expect
      .poll(() => observations.some(({ equal }) => !equal), { timeout: 15_000 })
      .toBe(true);
    expect(observations.some(({ builds }) => builds > 0)).toBe(true);
    console.log(JSON.stringify({ thinkingOnly, modelPolicyControl: observations }));
    expect(thinkingOnly.reduce((total, { builds }) => total + builds, 0)).toBe(0);
  } finally {
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "thinking reload proof complete" });
  }
}, 120_000);
