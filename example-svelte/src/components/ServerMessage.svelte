<script lang="ts">
  import { getConvexSiteUrl } from "$lib/utils";
  import type { StreamId } from "@convex-dev/persistent-text-streaming";
  import { useStream } from "@convex-dev/persistent-text-streaming/svelte";
  import { api } from "../../convex/_generated/api";
  import type { Doc } from "../../convex/_generated/dataModel";
  import { marked } from "marked";

  let {
    message,
    isDriven,
    stopStreaming,
    scrollToBottom,
  }: {
    message: Doc<"userMessages">;
    isDriven: boolean;
    stopStreaming: () => void;
    scrollToBottom: () => void;
  } = $props();

  const stream = useStream(
    api.streaming.getStreamBody,
    new URL(`${getConvexSiteUrl()}/chat-stream`),
    () => isDriven,
    () => message.responseStreamId as StreamId,
  );

  const isCurrentlyStreaming = $derived(
    isDriven && (stream.status === "pending" || stream.status === "streaming"),
  );

  // Stop streaming when done
  $effect(() => {
    if (!isDriven) return;
    if (isCurrentlyStreaming) return;
    stopStreaming();
  });

  // Scroll to bottom when text updates
  $effect(() => {
    if (!stream.text) return;
    scrollToBottom();
  });

  // Parse markdown
  const htmlContent = $derived(
    stream.text ? marked.parse(stream.text) : "<p>Thinking...</p>",
  );
</script>

<div class="md-answer prose prose-sm max-w-none">
  {#await htmlContent then html}
    {@html html}
  {/await}
  {#if stream.status === "error"}
    <div class="text-red-500 mt-2">Error loading response</div>
  {/if}
</div>

