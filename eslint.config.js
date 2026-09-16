import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.remember/` is a gitignored local-tooling scratch dir and `.claude/` holds
  // agent worktrees — checkouts of OTHER branches. Neither is repo source, and
  // linting a worktree makes `pnpm run lint` report on code that is not in this
  // branch at all.
  {
    ignores: [
      "**/dist/**",
      "**/dist-sea/**",
      "**/node_modules/**",
      "extractors/**",
      "schemas/**",
      ".remember/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Plain-JavaScript scripts (build steps, test fakes) run under Node: give
  // `no-undef` the runtime's globals, named here rather than pulled from the
  // `globals` package, which is not a dependency of this workspace.
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setImmediate: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Architectural boundary: core and analyzer must run in plain Node, no DOM.
  // three.js is only ever allowed in packages/viz; the model-provider SDK only
  // in packages/llm (everything else programs against its LlmClient).
  {
    files: [
      "packages/core/**/*.ts",
      "packages/analyzer/**/*.ts",
      "packages/city/**/*.ts",
      "packages/navigator/**/*.ts",
      "packages/insights/**/*.ts",
      "packages/cli/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["three", "three/*"], message: "Three.js is confined to packages/viz." },
            {
              group: ["@openrouter/sdk", "@openrouter/sdk/*"],
              message: "The provider SDK is confined to packages/llm; import @codegraph/llm.",
            },
          ],
        },
      ],
    },
  },
);
