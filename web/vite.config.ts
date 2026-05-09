import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
  },
});
