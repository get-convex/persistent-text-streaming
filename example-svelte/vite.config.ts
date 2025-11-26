import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  envDir: "../",
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      "$lib": "/src/lib",
    },
  },
});

