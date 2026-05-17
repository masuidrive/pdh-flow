import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@poly": resolve(here, "src/components/PolyFlow"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8765",
      "/assets/xterm.css": "http://localhost:8765",
      "/assets/xterm.js": "http://localhost:8765",
      "/assets/xterm-addon-fit.js": "http://localhost:8765",
      "/assets/xterm-addon-web-links.js": "http://localhost:8765",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "@react-three/fiber", "@react-three/drei"],
        },
      },
    },
  },
});
