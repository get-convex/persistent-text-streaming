import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // Compiles runes in `*.svelte.ts` modules; other files are untouched.
  plugins: [svelte({ configFile: false })],
  // Only affects tests in a DOM environment, so Svelte loads its client
  // runtime there. Edge-runtime tests resolve with the SSR conditions.
  resolve: { conditions: ["browser"] },
  test: {
    environment: "edge-runtime",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
