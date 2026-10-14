<script lang="ts">
  import { getConvexSiteUrl, safeHref } from "@/lib/utils";
  import type { StreamId } from "@convex-dev/persistent-text-streaming";
  import { useStream } from "@convex-dev/persistent-text-streaming/svelte";
  import { api } from "../../../example/convex/_generated/api";
  import type { Doc } from "../../../example/convex/_generated/dataModel";
  import type { HTMLAnchorAttributes } from "svelte/elements";
  import Markdown from "svelte-exmarkdown";

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

  $effect(() => {
    if (!isDriven) return;
    if (isCurrentlyStreaming) return;
    stopStreaming();
  });

  $effect(() => {
    if (!stream.text) return;
    scrollToBottom();
  });
</script>

<div class="md-answer">
  <!-- Raw HTML in the model output renders as text, like react-markdown. -->
  <Markdown md={stream.text || "Thinking..."}>
    {#snippet a({ href, children, ...rest }: HTMLAnchorAttributes)}
      <a {...rest} href={href ? safeHref(href) : undefined}>
        {@render children?.()}
      </a>
    {/snippet}
  </Markdown>
  {#if stream.status === "error"}
    <div class="text-red-500 mt-2">Error loading response</div>
  {/if}
</div>
