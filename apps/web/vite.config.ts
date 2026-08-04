import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
    exclude: [
      "tests/phase1.spec.ts",
      "tests/hierarchy.spec.ts",
      "node_modules/**",
      "dist/**",
    ],
  },
});
