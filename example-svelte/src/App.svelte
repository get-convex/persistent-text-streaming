<script lang="ts">
  import { setupConvex } from "convex-svelte";
  import ChatWindow from "./components/ChatWindow.svelte";

  const convexUrl = import.meta.env.VITE_CONVEX_URL;
  setupConvex(convexUrl);
</script>

<main class="flex min-h-screen flex-col">
  <ChatWindow />
</main>

