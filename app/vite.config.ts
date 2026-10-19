import { defineConfig } from "vite";

// Tauri expects a fixed port and the frontend in ../dist relative to src-tauri.
export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { outDir: "../dist", emptyOutDir: true, target: "safari15" },
});
