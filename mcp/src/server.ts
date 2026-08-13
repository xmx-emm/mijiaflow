import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asMijiaFlowError } from "./errors.js";
import { MijiaFlowService } from "./service.js";

const service = new MijiaFlowService();
const server = new McpServer({ name: "mijiaflow", version: "0.1.0" });

function success(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown): CallToolResult {
  const normalized = asMijiaFlowError(error);
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({ error: normalized.code, message: normalized.message, details: normalized.details }, null, 2),
    }],
  };
}

async function run(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return success(await action());
  } catch (error) {
    return failure(error);
  }
}

server.registerTool(
  "mijia_probe",
  {
    title: "Probe Mijia gateway",
    description: "Detect the LAN gateway frontend/protocol versions and read/write capability without pairing.",
    inputSchema: z.object({ baseUrl: z.string().url() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ({ baseUrl }) => run(() => service.probe(baseUrl)),
);

server.registerTool(
  "mijia_begin_session",
  {
    title: "Begin Mijia session",
    description: "Open a passcode-authenticated in-memory gateway session and return a one-time loopback pairing URL.",
    inputSchema: z.object({ baseUrl: z.string().url() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ({ baseUrl }) => run(() => service.beginSession(baseUrl)),
);

server.registerTool(
  "mijia_end_session",
  {
    title: "End Mijia session",
    description: "Close the gateway connection and clear authentication, plans, receipts, and rollback state.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  () => run(() => service.endSession()),
);

server.registerTool(
  "mijia_session_status",
  {
    title: "Check Mijia session status",
    description: "Report the current session state (none, awaiting-passcode, authenticating, ready, or failed) without touching the gateway.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  () => run(() => service.sessionStatus()),
);

server.registerTool(
  "mijia_workbench_status",
  {
    title: "Read Mijia workbench status",
    description: "Read the loopback workbench snapshot with session state and redacted recent operation progress.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  () => run(() => service.workbenchStatus()),
);

server.registerTool(
  "mijia_read",
  {
    title: "Read Mijia resource",
    description: "Read one allowlisted gateway resource: automations, devices, variables, logs, or backups.",
    inputSchema: z.object({
      resource: z.enum(["automations", "devices", "variables", "logs", "backups"]),
      filters: z.record(z.string(), z.unknown()).default({}),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ({ resource, filters }) => run(() => service.read(resource, filters)),
);

server.registerTool(
  "mijia_plan_change",
  {
    title: "Plan Mijia change",
    description: "Validate an allowlisted mutation and return a baseline-bound diff and one-time confirmation phrase.",
    inputSchema: z.object({ operation: z.string().min(1), payload: z.unknown() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ({ operation, payload }) => run(() => service.planChange(operation, payload)),
);

server.registerTool(
  "mijia_create_backup",
  {
    title: "Create verified Mijia backup",
    description: "Create and reopen a local backup; optionally create, poll, download, and verify a cloud backup.",
    inputSchema: z.object({
      fileName: z.string().min(1).max(180),
      outputDir: z.string().min(1),
      cloud: z.boolean().default(false),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ({ fileName, outputDir, cloud }) => run(() => service.createBackup(fileName, outputDir, cloud)),
);

server.registerTool(
  "mijia_apply_change",
  {
    title: "Apply planned Mijia change",
    description: "Consume a plan and verified backup receipt, recheck the baseline, write, read back, and compensate on failure.",
    inputSchema: z.object({
      planToken: z.string().min(1),
      backupReceipt: z.string().min(1),
      confirmation: z.string().min(1),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  ({ planToken, backupReceipt, confirmation }) =>
    run(() => service.applyChange(planToken, backupReceipt, confirmation)),
);

server.registerTool(
  "mijia_rollback",
  {
    title: "Roll back Mijia change",
    description: "Restore a retained object baseline after confirmation and verify the restored state.",
    inputSchema: z.object({ changeId: z.string().min(1), confirmation: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  ({ changeId, confirmation }) => run(() => service.rollback(changeId, confirmation)),
);

const transport = new StdioServerTransport();

async function shutdown(): Promise<void> {
  await service.endSession();
  await server.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(transport);
