import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { retireHeartbeatWithDoctor } from "../commands/doctor-heartbeat-retirement.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { createSubagentStopFixture } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

it("opens the transcript of a manually run migrated main heartbeat", async () => {
  const marker = "Synthetic migrated heartbeat result 165903";
  let modelRequests = 0;
  const model = await startOpenAiResponsesModelServer({
    modelId: "stop-proof",
    bindError: "Expected an isolated model server",
    onRequest: async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request before returning the scripted assistant reply.
      }
      modelRequests += 1;
      writeOpenAiResponsesText(response, {
        text: marker,
        messageId: "heartbeat_reply",
        responseId: "heartbeat_response",
      });
    },
  });
  let fixture: Awaited<ReturnType<typeof createSubagentStopFixture>> | undefined;
  let gateway: Awaited<ReturnType<NonNullable<typeof fixture>["start"]>> | undefined;
  try {
    fixture = await createSubagentStopFixture("migrated-heartbeat-transcript", model.baseUrl + "/v1");
    const { cfg, state } = fixture;
    const legacy: OpenClawConfig = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          heartbeat: { every: "24h", target: "none" },
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      cron: { enabled: true },
    };
    await fs.writeFile(path.join(state.workspaceDir, "HEARTBEAT.md"), "Report the synthetic monitor result.\n");
    const migrated = await withStateMigrationBackupForTest({}, () =>
      retireHeartbeatWithDoctor(legacy, state.env),
    );
    expect(migrated.agents?.defaults).not.toHaveProperty("heartbeat");
    Object.assign(cfg, migrated);
    gateway = await fixture.start();
    await gateway.server.startupSettled;
    const { client } = gateway;
    const listing = await client.request<{
      jobs: Array<{ id: string; payload: { kind: string } }>;
    }>("cron.list", { includeDisabled: true });
    expect(listing.jobs).toHaveLength(1);
    const job = listing.jobs[0]!;
    expect(job.payload.kind).toBe("agentTurn");

    const run = await client.request<{
      runId: string;
      run?: { runId: string; status: string; completionStatus: string };
    }>("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 30_000 });
    expect(run.run).toMatchObject({
      runId: run.runId,
      status: "ok",
      completionStatus: "succeeded",
    });
    expect(modelRequests).toBeGreaterThan(0);

    const listingAfterRun = await client.request<{ entries: Array<{ runId: string }> }>(
      "cron.runs",
      { id: job.id, limit: 10 },
    );
    expect(listingAfterRun.entries).toContainEqual(
      expect.objectContaining({ runId: run.runId, status: "ok" }),
    );
    const history = await client.request("cron.history", { id: job.id, runId: run.runId });
    expect(JSON.stringify(history)).toContain(marker);
    await expect(
      client.request("cron.history", { id: job.id, runId: "missing-run-control" }),
    ).rejects.toThrow(/transcript is unavailable/i);
  } finally {
    try {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "migrated heartbeat proof complete" });
      }
    } finally {
      await fixture?.state.cleanup();
      await model.close();
    }
  }
}, 120_000);
