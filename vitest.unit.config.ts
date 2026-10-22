import { defineConfig } from "vitest/config";

/** node 環境の単体テスト（設計 §10-1） */
export default defineConfig({
  test: {
    name: "unit",
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
  },
});
