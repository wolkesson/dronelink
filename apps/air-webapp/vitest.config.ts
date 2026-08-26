import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // Vitest auto-hides 100%-covered files from the text report when it
      // detects an AI agent environment (std-env isAgent). Force them to
      // stay visible so `vitest run --coverage` always shows every file.
      reporter: [["text", { skipFull: false }], "html", "clover", "json"],
    },
  },
});
