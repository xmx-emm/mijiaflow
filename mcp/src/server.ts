import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asMijiaFlowError } from "./errors.js";
import { GUIDE_RESOURCES, SERVER_INSTRUCTIONS } from "./guide.js";
import { DEFAULT_BACKUP_DIR, MijiaFlowService } from "./service.js";

const VERSION = typeof __MIJIAFLOW_VERSION__ === "string" ? __MIJIAFLOW_VERSION__ : "0.0.0-dev";

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  console.log(`mijiaflow ${VERSION} - unofficial MCP server for Mijia Central Hub Geek Edition.

This executable is an MCP stdio server. Launch it from an MCP client
configuration instead of running it interactively, for example:

  { "command": "npx", "args": ["-y", "mijiaflow"] }

Documentation: https://github.com/xmx-emm/mijiaflow`);
  process.exit(0);
}

const service = new MijiaFlowService();
const server = new McpServer(
  { name: "mijiaflow", version: VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);

/** Next-step guidance per stable error code; never derived from gateway-provided text. */
const ERROR_HINTS: Record<string, string> = {
  SESSION_NOT_READY: "Call mijia_begin_session, have the user enter the passcode on the 127.0.0.1 page, and poll mijia_session_status until it reports ready.",
  SESSION_CLOSED: "The gateway connection ended. Start a new session with mijia_begin_session.",
  READ_ONLY_VERSION: "This gateway version pair is read-only; only reads and local backup export are possible. Do not try to work around it.",
  GATEWAY_REJECTED: "The gateway rejected the authentication attempt. Call mijia_begin_session again and let the user re-enter the passcode.",
  HANDSHAKE_TIMEOUT: "Confirm the gateway is online and reachable, then start a new session with mijia_begin_session.",
  INVALID_TARGET: "Provide a plain http(s) base URL without credentials, query, or fragment.",
  TARGET_NOT_LAN: "Only private, loopback, or link-local gateway addresses are accepted.",
  TARGET_UNREACHABLE: "Verify the gateway address is reachable from this machine, then call mijia_probe again.",
  TARGET_REDIRECTED: "Use the gateway's direct base URL; redirects are rejected.",
  DNS_REBINDING_DETECTED: "The hostname now resolves differently. Re-run mijia_probe and begin a new session.",
  INVALID_PLAN: "Plan tokens are one-time and expire. Create a new plan with mijia_plan_change.",
  STALE_BACKUP_RECEIPT: "Create the backup after the plan: call mijia_plan_change first, then mijia_create_backup.",
  INVALID_BACKUP_RECEIPT: "Create a fresh verified backup with mijia_create_backup and retry with its receipt.",
  BACKUP_COVERAGE_MISMATCH: "Create a new backup with mijia_create_backup so it covers the planned object.",
  CONFIRMATION_MISMATCH: "Ask the user to send the exact one-time phrase again; never fill it in on their behalf.",
  CONCURRENT_CHANGE: "The object changed in the meantime. Re-read it, then create a new plan and a new backup.",
  WRITE_IN_PROGRESS: "Another guarded write is running. Wait for it to finish, then retry.",
  INVALID_CHANGE: "Use the changeId returned by a successful mijia_apply_change in this session.",
  NO_CHANGE: "The planned payload equals the current state; there is nothing to apply.",
  OPERATION_NOT_ALLOWED: "Use one allowlisted operation with a complete payload; see the mijiaflow://guide/tool-workflows resource.",
  METHOD_NOT_ALLOWED: "This gateway method is not allowlisted; MijiaFlow intentionally has no generic RPC.",
  INVALID_BACKUP_PATH: "Use a plain fileName and an absolute outputDir, or omit outputDir to use the default backup directory.",
  BACKUP_NOT_FOUND: "The cloud backup list is eventually consistent. List backups again later; do not immediately create another cloud backup.",
  BACKUP_TIMEOUT: "The gateway backup operation timed out. Retry when the gateway is idle.",
  RPC_TIMEOUT: "Retry with a narrower read (a single id or fewer log pages), or re-create the session after a network change.",
};

function success(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function structured(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown): CallToolResult {
  const normalized = asMijiaFlowError(error);
  const hint = ERROR_HINTS[normalized.code];
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        error: normalized.code,
        message: normalized.message,
        ...(hint ? { hint } : {}),
        details: normalized.details,
      }, null, 2),
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

async function runStructured(action: () => Promise<object>): Promise<CallToolResult> {
  try {
    return structured(await action());
  } catch (error) {
    return failure(error);
  }
}

const compatibilityModeSchema = z.enum(["read-write", "read-only"])
  .describe("Capability mode granted for the detected version pair");

const baseUrlSchema = z.string().url()
  .describe("Gateway base URL, e.g. http://192.168.1.50/. Must resolve to a private, loopback, or link-local address.");

const probeOutputSchema = z.object({
  baseUrl: z.string().describe("Normalized gateway base URL"),
  websocketUrl: z.string().describe("Derived gateway WebSocket endpoint"),
  frontendVersion: z.string().nullable().describe("Detected frontend version (write support requires v1.6.1)"),
  protocolVersion: z.string().nullable().describe("Detected protocol header (write support requires 2.0.0)"),
  buildTag: z.string().nullable().describe("Gateway page build tag when present"),
  mode: compatibilityModeSchema,
  capabilities: z.array(z.string()).describe("Operations MijiaFlow allows in this mode"),
  writeDisabledReasons: z.array(z.string()).describe("Why write mode is disabled; empty when read-write"),
});

const sessionStatusOutputSchema = z.object({
  state: z.enum(["none", "awaiting-passcode", "authenticating", "ready", "failed"])
    .describe("none: no session; awaiting-passcode: user has not submitted the loopback page; ready: authenticated; failed: start over with mijia_begin_session"),
  sessionId: z.string().optional().describe("Opaque identifier of the current session"),
  baseUrl: z.string().optional().describe("Normalized gateway target bound to this session"),
  mode: compatibilityModeSchema.optional(),
  writeDisabledReasons: z.array(z.string()).optional(),
  pairingExpiresAt: z.string().optional().describe("Expiry of the unsubmitted pairing page (ISO 8601)"),
});

const beginSessionOutputSchema = z.object({
  pairingUrl: z.string().describe("One-time http://127.0.0.1 URL; the user enters the six-digit gateway passcode there"),
  workbenchUrl: z.string().describe("Same URL; after submission it stays open as a read-only workbench"),
  expiresAt: z.string().describe("Pairing page expiry (ISO 8601)"),
  sessionId: z.string(),
  baseUrl: z.string(),
  mode: compatibilityModeSchema,
  state: z.literal("awaiting-passcode"),
});

const workbenchOutputSchema = z.object({
  updatedAt: z.string().describe("Timestamp of the last snapshot change (ISO 8601)"),
  session: sessionStatusOutputSchema.describe("Redacted session state shown by the workbench"),
  operation: z.object({
    stage: z.enum(["session", "read", "plan", "backup", "apply", "verify", "rollback"]),
    state: z.enum(["running", "succeeded", "failed"]),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    summary: z.string().optional(),
    diff: z.array(z.object({
      path: z.string(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    })).optional().describe("Redacted diff entries; values are masked"),
    result: z.record(z.string(), z.unknown()).optional().describe("Redacted result summary"),
    errorCode: z.string().optional(),
  }).optional().describe("Most recent operation, when any"),
});

server.registerTool(
  "mijia_probe",
  {
    title: "Probe Mijia gateway",
    description: "Detect the LAN gateway frontend/protocol versions and read/write capability without pairing. Call this first; an unknown version pair keeps the session read-only.",
    inputSchema: z.object({ baseUrl: baseUrlSchema }).strict(),
    outputSchema: probeOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ({ baseUrl }) => runStructured(() => service.probe(baseUrl)),
);

server.registerTool(
  "mijia_begin_session",
  {
    title: "Begin Mijia session",
    description: "Open a passcode-authenticated in-memory gateway session. Returns a one-time http://127.0.0.1 pairing URL: show it to the user, who enters the six-digit gateway passcode there (never in chat or tool arguments). Then poll mijia_session_status until ready.",
    inputSchema: z.object({ baseUrl: baseUrlSchema }).strict(),
    outputSchema: beginSessionOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ({ baseUrl }) => runStructured(() => service.beginSession(baseUrl)),
);

server.registerTool(
  "mijia_end_session",
  {
    title: "End Mijia session",
    description: "Close the gateway connection and clear authentication, plans, receipts, and rollback state. Call when the work is complete.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ended: z.boolean().describe("Whether an active session existed and was ended") }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  () => runStructured(() => service.endSession()),
);

server.registerTool(
  "mijia_session_status",
  {
    title: "Check Mijia session status",
    description: "Report the current session state (none, awaiting-passcode, authenticating, ready, or failed) from in-memory state only; it never touches the gateway. Poll this after mijia_begin_session instead of probing with reads.",
    inputSchema: z.object({}).strict(),
    outputSchema: sessionStatusOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  () => runStructured(() => service.sessionStatus()),
);

server.registerTool(
  "mijia_workbench_status",
  {
    title: "Read Mijia workbench status",
    description: "Read the loopback workbench snapshot: session state plus the redacted progress of the most recent operation. Useful to mirror what the user sees on the workbench page.",
    inputSchema: z.object({}).strict(),
    outputSchema: workbenchOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  () => runStructured(() => service.workbenchStatus()),
);

server.registerTool(
  "mijia_read",
  {
    title: "Read Mijia resource",
    description: "Read one allowlisted gateway resource. Requires a ready session. Prefer summaries first, then a single automation by id (an id read returns the complete raw graph). Filters per resource are documented in the mijiaflow://guide/tool-workflows resource.",
    inputSchema: z.object({
      resource: z.enum(["automations", "devices", "variables", "logs", "backups"])
        .describe("automations: graph configs or complete graphs; devices: paired devices; variables: by scope; logs: raw log pages; backups: cloud backup records"),
      filters: z.record(z.string(), z.unknown()).default({})
        .describe("Resource-specific filters, e.g. {id}, {enabled}, {includeNodes} for automations; unknown keys are rejected"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ({ resource, filters }) => run(() => service.read(resource, filters)),
);

server.registerTool(
  "mijia_plan_change",
  {
    title: "Plan Mijia change",
    description: "Validate one allowlisted mutation and return a baseline-bound diff, a one-time planToken, and an exact confirmation phrase. Requires a ready, write-compatible session. Show the diff and phrase to the user, then create a backup before applying.",
    inputSchema: z.object({
      operation: z.string().min(1)
        .describe("One of: set_graph, delete_graph, set_graph_config, set_graph_enabled, create_variable, set_variable_value, set_variable_config, delete_variable"),
      payload: z.unknown()
        .describe("Complete closed-schema payload for the operation; see the mijiaflow://guide/tool-workflows resource. Graph imports need the full { id, nodes, cfg } object."),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ({ operation, payload }) => run(() => service.planChange(operation, payload)),
);

server.registerTool(
  "mijia_create_backup",
  {
    title: "Create verified Mijia backup",
    description: "Create, reopen, and verify a local backup; with cloud: true also create, poll, download, and verify a gateway cloud backup (write-compatible gateways only). Returns an opaque backupReceipt required by mijia_apply_change. Call after mijia_plan_change.",
    inputSchema: z.object({
      fileName: z.string().min(1).max(180)
        .describe("Plain portable filename without directories; '.bak' is appended when no extension is given"),
      outputDir: z.string().min(1).optional()
        .describe(`Absolute directory for the backup file; defaults to ${DEFAULT_BACKUP_DIR}`),
      cloud: z.boolean().default(false)
        .describe("Also create and verify a gateway cloud backup; only on the supported version pair and only when the user asked for it"),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  ({ fileName, outputDir, cloud }) => run(() => service.createBackup(fileName, outputDir, cloud)),
);

server.registerTool(
  "mijia_apply_change",
  {
    title: "Apply planned Mijia change",
    description: "Consume a plan and verified backup receipt, recheck the baseline, write, read back, and compensate on failure. The confirmation must be the exact one-time phrase typed by the user; never fill it in on their behalf.",
    inputSchema: z.object({
      planToken: z.string().min(1).describe("Opaque token returned by mijia_plan_change"),
      backupReceipt: z.string().min(1).describe("Opaque receipt returned by mijia_create_backup after the plan"),
      confirmation: z.string().min(1).describe("Exact one-time confirmation phrase, supplied by the user"),
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
    description: "Restore the object baseline retained by a successful mijia_apply_change and verify the restored state. Requires the changeId from that apply and the exact rollback phrase typed by the user.",
    inputSchema: z.object({
      changeId: z.string().min(1).describe("Change identifier returned by mijia_apply_change"),
      confirmation: z.string().min(1).describe("Exact one-time rollback phrase, supplied by the user"),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  ({ changeId, confirmation }) => run(() => service.rollback(changeId, confirmation)),
);

for (const guide of GUIDE_RESOURCES) {
  server.registerResource(
    guide.name,
    guide.uri,
    { title: guide.title, description: guide.description, mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide.text }],
    }),
  );
}

function promptText(text: string) {
  return {
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

server.registerPrompt(
  "mijia_audit",
  {
    title: "Audit Mijia automations (read-only)",
    description: "Inspect gateway automations, devices, variables, and logs without changing anything.",
    argsSchema: {
      baseUrl: z.string().describe("Gateway base URL, e.g. http://192.168.1.50/"),
    },
  },
  ({ baseUrl }) => promptText(
    `Audit the Mijia gateway at ${baseUrl} using the MijiaFlow tools without changing anything.

1. Call mijia_probe with the base URL and report the detected frontend version, protocol version, and capability mode. If the version pair is unknown, continue strictly read-only.
2. Call mijia_begin_session and give me the returned 127.0.0.1 pairing URL; I will enter the six-digit gateway passcode there. Never ask for the passcode in chat. Poll mijia_session_status until it reports ready.
3. Read the current state with mijia_read: automation summaries first, then devices, variables, and recent logs.
4. Report: total, enabled, and disabled automations; automations referencing missing or offline devices; variables that look unused or inconsistent; anything unusual in the logs. Do not modify anything and do not plan changes.
5. Call mijia_end_session when finished.`,
  ),
);

server.registerPrompt(
  "mijia_guarded_change",
  {
    title: "Guarded Mijia change",
    description: "Plan, back up, confirm, apply, and verify one allowlisted gateway change.",
    argsSchema: {
      baseUrl: z.string().describe("Gateway base URL, e.g. http://192.168.1.50/"),
      change: z.string().describe("The desired change, e.g. 'disable automation 12AB34' or 'set variable scene.mode to night'"),
    },
  },
  ({ baseUrl, change }) => promptText(
    `I want to change my Mijia gateway state safely: ${change}

Follow the guarded write transaction (read the mijiaflow://guide/write-transaction resource first):
1. Call mijia_probe with ${baseUrl} and confirm the gateway is write-compatible; stop and tell me if it is read-only.
2. Call mijia_begin_session; I will enter the passcode on the loopback page. Poll mijia_session_status until ready.
3. Read the affected object with mijia_read and summarize its current state.
4. Call mijia_plan_change with one allowlisted operation and show me the returned diff and the exact one-time confirmation phrase.
5. Create a verified backup with mijia_create_backup.
6. Wait for me to send the confirmation phrase exactly; do not type it for me.
7. Apply with mijia_apply_change, report the verified result, and keep the returned changeId and rollback phrase available in case I ask to roll back.`,
  ),
);

server.registerPrompt(
  "mijia_backup",
  {
    title: "Create verified Mijia backup",
    description: "Export a verified local backup, optionally also a verified gateway cloud backup.",
    argsSchema: {
      baseUrl: z.string().describe("Gateway base URL, e.g. http://192.168.1.50/"),
      cloud: z.string().optional().describe("Set to 'cloud' to also create a verified gateway cloud backup (write-compatible gateways only)"),
    },
  },
  ({ baseUrl, cloud }) => promptText(
    `Create a verified backup of my Mijia gateway at ${baseUrl}.

1. Call mijia_probe, then mijia_begin_session; I will enter the passcode on the loopback page. Poll mijia_session_status until ready.
2. Call mijia_create_backup with a descriptive fileName${cloud === "cloud"
      ? " and cloud: true (confirm first that the gateway is write-compatible)"
      : " (local only; do not set cloud: true unless I ask)"}.
3. Report the backup path, digests, and verification result. Keep the backupReceipt in case I want a guarded change in this session.
4. Call mijia_end_session unless I have more work.`,
  ),
);

const transport = new StdioServerTransport();

async function shutdown(): Promise<void> {
  await service.endSession();
  await server.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(transport);
