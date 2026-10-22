import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
