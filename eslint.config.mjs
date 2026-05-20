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
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message:
            "Use Temporal (temporal-polyfill) instead of Date. Exception: new Date(epochMs).toUTCString() for RFC 822 formatting.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            "Use Temporal (temporal-polyfill) instead of new Date(). Exception: new Date(epochMs).toUTCString() for RFC 822 formatting.",
        },
      ],
    },
  },
);
