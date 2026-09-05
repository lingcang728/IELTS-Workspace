/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: process.env.TAURI_ENV_DEBUG === "true",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
