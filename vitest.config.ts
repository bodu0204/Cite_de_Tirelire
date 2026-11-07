import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // 放置計算の一致を確かめるテスト（AT-027・AT-037・REC-01）は、1週間分の10分ティックを「1回で」と「1時間ごと」の
    // 2通りで進めるので、手元で4〜5秒、CI の小さい実行環境では6秒を超える。既定の5秒では途中で打ち切られる
    testTimeout: 30_000,
  },
});
