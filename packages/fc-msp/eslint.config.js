import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  js.configs.recommended,
  ...tsPlugin.configs["flat/recommended"],
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The codec runs on both the air (browser/WebView) and ground (Node) sides, so its
    // source must not reach for platform APIs; only the tests read fixtures from disk.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
    },
  },
];
