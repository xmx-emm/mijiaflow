import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["mcp/test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
