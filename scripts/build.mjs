import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "mcp/dist/server.js";

await rm(`${outfile}.map`, { force: true });

await build({
  entryPoints: ["mcp/src/server.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __mijiaCreateRequire } from "node:module";',
      "const require = __mijiaCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/^[\t ]+$/gm, ""), "utf8");
await chmod(outfile, 0o755);
