<script lang="ts">
  import type { Doc } from "../../convex/_generated/dataModel";
  import type { Snippet } from "svelte";

  let {
    message,
    isUser,
    children,
  }: {
    message: Doc<"userMessages">;
    isUser: boolean;
    children: Snippet;
  } = $props();

  const formattedDate = $derived(
    new Date(message._creationTime).toLocaleDateString(),
  );
  const formattedTime = $derived(
    new Date(message._creationTime).toLocaleTimeString(),
  );
</script>

{#if isUser}
  <div class="flex items-center gap-4 my-4">
    <div class="flex-1 h-px bg-gray-200"></div>
    <div class="text-sm text-gray-500">
      {formattedDate}
      {formattedTime}
    </div>
    <div class="flex-1 h-px bg-gray-200"></div>
  </div>
{/if}

<div class="flex gap-4 {isUser ? 'justify-end' : 'justify-start'}">
  <div class="flex gap-4 max-w-[95%] md:max-w-[85%] {isUser && 'flex-row-reverse'}">
    <div
      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full {isUser
        ? 'bg-blue-600 text-white'
        : 'bg-gray-300 text-gray-700'} font-medium text-sm"
    >
      {isUser ? "U" : "AI"}
    </div>

    <div
      class="rounded-lg px-5 py-4 text-base {isUser
        ? 'bg-blue-600 text-white'
        : 'bg-gray-100 border border-gray-200 text-gray-900'}"
    >
      {@render children()}
    </div>
  </div>
</div>

