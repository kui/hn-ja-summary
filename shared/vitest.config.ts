import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// shared を使うのはすべて Worker なので、本番と同じ workerd 上で実行する。
// worker のエントリは持たないライブラリなので main は指定せず miniflare のみ設定する。
export default defineConfig({
  test: {
    name: "shared",
    include: ["**/*.test.ts"],
  },
  plugins: [
    cloudflareTest({
      miniflare: { compatibilityDate: "2026-05-18" },
    }),
  ],
});
