import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // テストから D1 にスキーマを当てるため、マイグレーションを provide で渡す
  const migrations = await readD1Migrations(
    resolve(import.meta.dirname, "../migrations"),
  );
  return {
    test: {
      name: "feed",
      include: ["**/*.test.ts"],
      provide: { migrations },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
      }),
    ],
  };
});
