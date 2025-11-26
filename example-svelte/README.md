# Svelte Example - Persistent Text Streaming

This is a Svelte 5 example demonstrating the `@convex-dev/persistent-text-streaming` component with Svelte bindings.

## Setup

1. Make sure you have the Convex backend running (shared with the React example):

```bash
cd ../example
npx convex dev
```

2. Install dependencies and run the Svelte example:

```bash
bun install
bun run dev
```

## Features

- Real-time chat interface with AI responses
- HTTP streaming for immediate token display
- Convex sync as persistent fallback for page reloads
- Svelte 5 runes for reactivity

## Key Files

- `src/App.svelte` - Main app component with Convex setup
- `src/components/ChatWindow.svelte` - Chat interface
- `src/components/MessageItem.svelte` - Individual message display
- `src/components/ServerMessage.svelte` - Server response with streaming using `useStream`

## Usage

The `useStream` hook from `@convex-dev/persistent-text-streaming/svelte` provides:

```svelte
<script lang="ts">
  import { useStream } from "@convex-dev/persistent-text-streaming/svelte";

  let { isDriven, streamId } = $props();

  const stream = useStream(
    api.streaming.getStreamBody,  // Query function reference
    new URL("/api/stream"),        // HTTP streaming endpoint
    () => isDriven,                // Getter for whether this client drives the stream
    () => streamId,                // Getter for stream ID
  );

  // Reactive properties
  // stream.text - Current text content
  // stream.status - "pending" | "streaming" | "done" | "error"
</script>
```

Note: The `getDriven` and `getStreamId` parameters are getter functions (not values) to enable Svelte's reactivity system to track changes.

