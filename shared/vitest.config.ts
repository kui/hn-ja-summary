import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// shared は HTMLRewriter など Workers 組み込み API に依存するため workerd 上で実行する。
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
