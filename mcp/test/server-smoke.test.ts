import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connect(): Promise<Client> {
  const client = new Client({ name: "mijiaflow-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/dist/server.js"],
    cwd: process.cwd(),
  });
  await client.connect(transport);
  return client;
}

describe("bundled stdio server", () => {
  it("serves instructions, tools, prompts, resources, and structured status", async () => {
    const client = await connect();
    try {
      expect(client.getServerVersion()?.name).toBe("mijiaflow");
      expect(client.getInstructions()).toContain("mijia_probe");

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "mijia_apply_change",
        "mijia_begin_session",
        "mijia_create_backup",
        "mijia_end_session",
        "mijia_plan_change",
        "mijia_probe",
        "mijia_read",
        "mijia_rollback",
        "mijia_session_status",
        "mijia_workbench_status",
      ]);
      const probeTool = tools.tools.find((tool) => tool.name === "mijia_probe");
      expect(probeTool?.outputSchema).toBeDefined();
      expect(probeTool?.description).toContain("read-only");

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
        "mijia_audit",
        "mijia_backup",
        "mijia_diagnose",
        "mijia_guarded_change",
        "mijia_layout_planning",
      ]);

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
        "mijiaflow://guide/browser-workflow",
        "mijiaflow://guide/layout-workflow",
        "mijiaflow://guide/log-diagnosis",
        "mijiaflow://guide/node-catalog",
        "mijiaflow://guide/security",
        "mijiaflow://guide/tool-workflows",
        "mijiaflow://guide/write-transaction",
      ]);

      const guide = await client.readResource({ uri: "mijiaflow://guide/write-transaction" });
      const guideContent = guide.contents[0];
      expect(guideContent?.mimeType).toBe("text/markdown");
      expect(guideContent && "text" in guideContent ? guideContent.text : "").toContain("mijia_plan_change");

      const status = await client.callTool({ name: "mijia_session_status", arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent).toEqual({ state: "none" });

      const ended = await client.callTool({ name: "mijia_end_session", arguments: {} });
      expect(ended.structuredContent).toEqual({ ended: false });

      const prompt = await client.getPrompt({
        name: "mijia_audit",
        arguments: { baseUrl: "http://192.168.10.1/" },
      });
      const first = prompt.messages[0];
      expect(first?.role).toBe("user");
      expect(first?.content.type).toBe("text");
      if (first?.content.type === "text") {
        expect(first.content.text).toContain("http://192.168.10.1/");
        expect(first.content.text).toContain("mijia_end_session");
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it("returns a hinted, redacted error for tools that need a session", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({ name: "mijia_read", arguments: { resource: "automations" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]!.text) as { error: string; hint?: string };
      expect(payload.error).toBe("SESSION_NOT_READY");
      expect(payload.hint).toContain("mijia_begin_session");
    } finally {
      await client.close();
    }
  }, 30_000);
});
