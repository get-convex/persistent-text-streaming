<script lang="ts">
  import { useQuery, useConvexClient } from "convex-svelte";
  import { SvelteSet } from "svelte/reactivity";
  import MessageItem from "./MessageItem.svelte";
  import ServerMessage from "./ServerMessage.svelte";
  import { api } from "../../../example/convex/_generated/api";
  import type { Id } from "../../../example/convex/_generated/dataModel";

  const client = useConvexClient();
  const messages = useQuery(api.messages.listMessages, () => ({}));

  // Messages this session sent, so only their streams are driven over HTTP.
  const drivenIds = new SvelteSet<string>();
  let isStreaming = $state(false);
  let inputValue = $state("");
  let messagesEndRef = $state<HTMLDivElement | null>(null);
  let inputRef = $state<HTMLInputElement | null>(null);

  function focusInput() {
    inputRef?.focus();
  }

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    messagesEndRef?.scrollIntoView({ behavior });
  }

  // Scroll to bottom when window resizes
  $effect(() => {
    function handleResize() {
      scrollToBottom();
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const prompt = inputValue;
    inputValue = "";

    const chatId: Id<"userMessages"> = await client.mutation(
      api.messages.sendMessage,
      { prompt },
    );

    drivenIds.add(chatId);
    isStreaming = true;
  }

  async function clearAllMessages() {
    await client.mutation(api.messages.clearMessages, {});
    inputValue = "";
    isStreaming = false;
    focusInput();
  }

  function stopStreaming() {
    isStreaming = false;
    focusInput();
  }
</script>

<div class="flex-1 flex flex-col h-full bg-white">
  <div class="flex-1 overflow-y-auto py-6 px-4 md:px-8 lg:px-12">
    <div class="w-full max-w-5xl mx-auto space-y-6">
      {#if messages.isLoading}
        <div class="text-center text-gray-500">Loading messages...</div>
      {:else if messages.error}
        <div class="text-center text-red-500">
          Error loading messages: {messages.error.message}
        </div>
      {:else if messages.data && messages.data.length === 0}
        <div class="text-center text-gray-500">
          No messages yet. Start the conversation!
        </div>
      {:else if messages.data}
        {#each messages.data as message (message._id)}
          <MessageItem {message} isUser={true}>
            {message.prompt}
          </MessageItem>
          <MessageItem {message} isUser={false}>
            <ServerMessage
              {message}
              isDriven={drivenIds.has(message._id)}
              {stopStreaming}
              {scrollToBottom}
            />
          </MessageItem>
        {/each}
      {/if}
      <div bind:this={messagesEndRef}></div>
    </div>
  </div>

  <div class="border-t border-gray-200 py-6 px-4 md:px-8 lg:px-12">
    <form onsubmit={handleSubmit} class="w-full max-w-5xl mx-auto">
      <div class="flex items-center gap-3">
        <input
          bind:this={inputRef}
          bind:value={inputValue}
          placeholder="Type your message..."
          disabled={isStreaming}
          class="flex-1 p-4 border border-gray-300 rounded-lg focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none text-base text-black"
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || isStreaming}
          class="px-8 py-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:text-gray-200 font-medium"
        >
          Send
        </button>
        <button
          type="button"
          disabled={!messages.data || messages.data.length < 2 || isStreaming}
          onclick={clearAllMessages}
          class="px-8 py-4 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:text-gray-200 font-medium"
        >
          Clear Chat
        </button>
      </div>
      {#if isStreaming}
        <div class="text-xs text-gray-500 mt-2">AI is responding...</div>
      {/if}
    </form>
  </div>
</div>

