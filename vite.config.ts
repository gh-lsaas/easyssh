import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tauri watches Rust sources; Vite must not watch Cargo build artifacts.
      ignored: ["**/src-tauri/**"],
    },
  },
});
