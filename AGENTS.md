# Project Agent Instructions

- For architecture, cross-module, MCP, build/deployment, handoff, or explicitly requested context work, read `PROJECT_CONTEXT.md` before source. For a self-contained local, read-only, or documentation-only task, read only the relevant files and use the context when it affects scope. Verify claims against current files.
- Use it to select the smallest relevant implementation scope.
- Verify important claims against the current source files; the summary is navigational context, not authority.
- Refresh `PROJECT_CONTEXT.md` whenever durable architecture, workflows, dependencies, build behavior, constraints, or risks change.
- Rebuild `mcp/dist/server.js` (`npm run build`) whenever `mcp/src` or an embedded `docs/*.md` guide changes; the committed bundle is the published executable. Documentation or unrelated source changes do not require this rebuild.
- Keep the project client-neutral: no vendor-specific plugin layers, and no MCP client names in page text, tool descriptions, or error messages.
- For code, MCP, or build changes, close the affected change with `npm run verify` (typecheck, build, test) before committing. For documentation-only changes, check the diff and links/format instead; run the full verify only when the published bundle or behavior is affected.
