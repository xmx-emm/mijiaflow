# Project Agent Instructions

- Read `PROJECT_CONTEXT.md` before reading or searching source code.
- Use it to select the smallest relevant implementation scope.
- Verify important claims against the current source files; the summary is navigational context, not authority.
- Refresh `PROJECT_CONTEXT.md` whenever durable architecture, workflows, dependencies, build behavior, constraints, or risks change.
- Rebuild `mcp/dist/server.js` (`npm run build`) whenever `mcp/src` or an embedded `docs/*.md` guide changes; the committed bundle is the published executable.
- Keep the project client-neutral: no vendor-specific plugin layers, and no MCP client names in page text, tool descriptions, or error messages.
- Close every change with `npm run verify` (typecheck, build, test) before committing.
