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
      "tests/sequential.spec.ts",
      "tests/register3.spec.ts",
      "tests/bus-wiring.spec.ts",
      "tests/bus-teaching-example.spec.ts",
      "tests/chronogram.spec.ts",
      "tests/memory-lab.spec.ts",
      "tests/counter3.spec.ts",
      "tests/node-context-menu.spec.ts",
      "node_modules/**",
      "dist/**",
    ],
  },
});
