import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["feed", "backend", "shared"],
  },
});
