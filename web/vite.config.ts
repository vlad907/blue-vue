import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev:web` serves the panel with hot reload and forwards API calls
// to the control server on :3000; `npm run build` writes web/dist for it to serve.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
