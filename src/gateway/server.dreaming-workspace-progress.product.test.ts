import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { getCurrentSessionControllerOwner } from "../sessions/session-controller.context.js";
import { createSubagentStopFixture } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

it("keeps a healthy multi-workspace Dreaming cron below the semantic stall deadline", async () => {
  const model = await startOpenAiResponsesModelServer({
    modelId: "stop-proof",
    bindError: "Expected an isolated model server",
    onRequest: async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request before sending a synthetic response.
      }
      writeOpenAiResponsesText(response, {
        text: "Synthetic fallback model reply",
        messageId: "dreaming_proof_reply",
        responseId: "dreaming_proof_response",
      });
    },
  });
  let fixture: Awaited<ReturnType<typeof createSubagentStopFixture>> | undefined;
  let gateway: Awaited<ReturnType<NonNullable<typeof fixture>["start"]>> | undefined;
  const originalNow = Date.now;
  const originalReaddir = fs.readdir;
  let elapsedMs = 0;
  const clocks = vi.spyOn(Date, "now").mockImplementation(() => originalNow() + elapsedMs);
  let directoryReads: { mockRestore(): void } | undefined;
  try {
    fixture = await createSubagentStopFixture("dreaming-workspace-progress", model.baseUrl + "/v1");
    const { cfg, state } = fixture;
    const entries = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [
        index === 0 ? "main" : `dreaming-${index}`,
        { workspace: state.path("workspaces", String(index)) },
      ]),
    );
    const observedPaths = new Set(
      Object.values(entries).map(({ workspace }) => path.join(workspace, "memory")),
    );
    await Promise.all([...observedPaths].map((directory) => fs.mkdir(directory, { recursive: true })));
    cfg.agents = {
      defaults: { ...cfg.agents?.defaults, systemAgent: { agentId: "main" } },
      entries,
    };
    cfg.cron = { enabled: true };
    cfg.plugins = {
      enabled: true,
      allow: ["memory-core"],
      slots: { memory: "none" },
      entries: {
        "memory-core": {
          enabled: true,
          config: {
            dreaming: {
              enabled: true,
              timezone: "UTC",
              phases: {
                light: { enabled: true, limit: 20, lookbackDays: 2 },
                rem: { enabled: false },
                deep: { enabled: true, limit: 20 },
              },
            },
          },
        },
      },
    };
    gateway = await fixture.start();
    await gateway.server.startupSettled;
    const { client } = gateway;
    const job = await vi.waitFor(async () => {
      const listing = await client.request<{ jobs: Array<{ id: string; name: string }> }>(
        "cron.list",
        { includeDisabled: true },
      );
      const found = listing.jobs.find(({ name }) => name === "Memory Dreaming Promotion");
      expect(found).toBeDefined();
      return found!;
    }, { timeout: 15_000, interval: 100 });

    const observed = new Set<string>();
    const decisions: string[] = [];
    directoryReads = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
      const [directory] = args;
      const owner = getCurrentSessionControllerOwner();
      if (owner && typeof directory === "string" && observedPaths.has(directory) && !observed.has(directory)) {
        observed.add(directory);
        // Compress the reported 22 seconds per workspace without replacing its I/O.
        elapsedMs += 22_000;
        decisions.push(owner.watchdog.decide().reason);
      }
      return originalReaddir(...args);
    });
    const result = await client.request<{ run?: { status: string } }>(
      "cron.run",
      { id: job.id, mode: "force", waitTimeoutMs: 30_000 },
    );
    expect(result.run?.status).toBe("ok");
    expect(observed.size).toBe(18);
    expect(elapsedMs).toBe(396_000);
    console.log(JSON.stringify({ workspaces: observed.size, simulatedMs: elapsedMs, decisions }));
    expect(decisions).not.toContain("semantic_stall");
  } finally {
    directoryReads?.mockRestore();
    clocks.mockRestore();
    try {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "dreaming proof complete" });
      }
    } finally {
      await fixture?.state.cleanup();
      await model.close();
    }
  }
}, 120_000);
