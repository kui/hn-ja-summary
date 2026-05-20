import { defineConfig, includeIgnoreFile } from "eslint/config";
import tseslint from "typescript-eslint";
import { resolve } from "node:path";

export default defineConfig(
  includeIgnoreFile(resolve(import.meta.dirname, ".gitignore")),
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
