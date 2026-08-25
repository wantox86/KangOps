// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Fastify handlers are frequently `async` without an `await` (e.g. the /healthz
      // placeholder) -- that's a legitimate shape here, not a bug.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Config files themselves: not part of tsconfig.json's "include" (or not worth
    // type-aware linting), so they'd otherwise fail the "parserOptions.project" check above.
    ignores: ["dist/**", "drizzle/**", "node_modules/**", "eslint.config.js", "drizzle.config.ts", "vitest.config.ts"],
  },
);
