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
      "**/node_modules/**",
      "extractors/**",
      "schemas/**",
      ".remember/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
  // three.js is only ever allowed in packages/viz.
  {
    files: [
      "packages/core/**/*.ts",
      "packages/analyzer/**/*.ts",
      "packages/city/**/*.ts",
      "packages/cli/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["three", "three/*"], message: "Three.js is confined to packages/viz." },
          ],
        },
      ],
    },
  },
);
