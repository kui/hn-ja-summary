import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // テストの D1 は空で始まるので、本番と同じマイグレーションを setup で当てる
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "../migrations"),
  );
  return {
    test: {
      name: "backend",
      include: ["**/*.test.ts"],
      setupFiles: ["./test-setup.ts"],
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
  };
});
