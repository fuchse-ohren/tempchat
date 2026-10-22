import { defineConfig } from "vite";

/** Service Worker 用ビルド（単一ESMファイル dist/client/sw.js を生成） */
export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: false,
    target: "es2022",
    rollupOptions: {
      input: "src/sw/sw.ts",
      output: {
        entryFileNames: "sw.js",
        format: "es",
        inlineDynamicImports: true,
      },
    },
  },
});
