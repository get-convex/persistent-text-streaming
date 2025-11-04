# Convex Component: Persistent Text Streaming

[![npm version](https://badge.fury.io/js/@convex-dev%2Fpersistent-text-streaming.svg)](https://badge.fury.io/js/@convex-dev%2Fpersistent-text-streaming)

<!-- START: Include on https://convex.dev/components -->

This Convex component enables persistent text streaming. It provides a React
hook for streaming text from HTTP actions while simultaneously storing the data
in the database. This persistence allows the text to be accessed after the
stream ends or by other users.

The most common use case is for AI chat applications. The example app (found in
the `example` directory) is a just such a simple chat app that demonstrates use
of the component.

Here's what you'll end up with! The left browser window is streaming the chat
body to the client, and the right browser window is subscribed to the chat body
via a database query. The message is only updated in the database on sentence
boundaries, whereas the HTTP stream sends tokens as they come:

![example-animation](./anim.gif)

## Pre-requisite: Convex

You'll need an existing Convex project to use the component. Convex is a hosted
backend platform, including a database, serverless functions, and a ton more you
can learn about [here](https://docs.convex.dev/get-started).

Run `npm create convex` or follow any of the
[quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

See [`example/`](./example/convex/) for a working demo.

1. Install the Persistent Text Streaming component:

```bash
npm install @convex-dev/persistent-text-streaming
```

2. Create a [`convex.config.ts`](./example/convex/convex.config.ts) file in your
   app's `convex/` folder and install the component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import persistentTextStreaming from "@convex-dev/persistent-text-streaming/convex.config";

const app = defineApp();
app.use(persistentTextStreaming);
export default app;
```

## Usage

Here's a simple example of how to use the component:

In `convex/chat.ts`:

```ts
const persistentTextStreaming = new PersistentTextStreaming(
  components.persistentTextStreaming,
);

// Create a stream using the component and store the id in the database with
// our chat message.
export const createChat = mutation({
  args: {
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const streamId = await persistentTextStreaming.createStream(ctx);
    const chatId = await ctx.db.insert("chats", {
      title: "...",
      prompt: args.prompt,
      stream: streamId,
    });
    return chatId;
  },
});

// Create a query that returns the chat body.
export const getChatBody = query({
  args: {
    streamId: StreamIdValidator,
  },
  handler: async (ctx, args) => {
    return await persistentTextStreaming.getStreamBody(
      ctx,
      args.streamId as StreamId,
    );
  },
});

// Create an HTTP action that generates chunks of the chat body
// and uses the component to stream them to the client and save them to the database.
export const streamChat = httpAction(async (ctx, request) => {
  const body = (await request.json()) as { streamId: string };
  const generateChat = async (ctx, request, streamId, chunkAppender) => {
    await chunkAppender("Hi there!");
    await chunkAppender("How are you?");
    await chunkAppender("Pretend I'm an AI or something!");
  };

  const response = await persistentTextStreaming.stream(
    ctx,
    request,
    body.streamId as StreamId,
    generateChat,
  );

  // Set CORS headers appropriately.
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Vary", "Origin");
  return response;
});
```

You need to expose this HTTP endpoint in your backend, so in `convex/http.ts`:

```ts
http.route({
  path: "/chat-stream",
  method: "POST",
  handler: streamChat,
});
```

Finally, in your app, you can now create chats and them subscribe to them via
stream and/or database query as optimal:

```ts
// chat-input.tsx, maybe?
const createChat = useMutation(api.chat.createChat);
const formSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  const chatId = await createChat({
    prompt: inputValue,
  });
};

// chat-message.tsx, maybe?
import { useStream } from "@convex-dev/persistent-text-streaming/react";

// ...

// In our component:
const { text, status } = useStream(
  api.chat.getChatBody, // The query to call for the full stream body
  new URL(`${convexSiteUrl}/chat-stream`), // The HTTP endpoint for streaming
  driven, // True if this browser session created this chat and should generate the stream
  chat.streamId as StreamId, // The streamId from the chat database record
);
```

## Design Philosophy

This component balances HTTP streaming with database persistence to try to
maximize the benefits of both. To understand why this balance is beneficial,
let's examine each approach in isolation.

- **HTTP streaming only**: If your app _only_ uses HTTP streaming, then the
  original browser that made the request will have a great, high-performance
  streaming experience. But if that HTTP connection is lost, if the browser
  window is reloaded, if other users want to view the same chat, or this users
  wants to revisit the conversation later, it won't be possible. The
  conversation is only ephemeral because it was never stored on the server.

- **Database Persistence Only**: If your app _only_ uses database persistence,
  it's true that the conversation will be available for as long as you want.
  Additionally, Convex's subscriptions will ensure the chat message is updated
  as new text chunks are generated. However, there are a few downsides: one, the
  entire chat body needs to be resent every time it is changed, which is a lot
  redundant bandwidth to push into the database and over the websockets to all
  connected clients. Two, you'll need to make a difficult tradeoff between
  interactivity and efficiency. If you write every single small chunk to the
  database, this will get quite slow and expensive. But if you batch up the
  chunks into, say, paragraphs, then the user experience will feel laggy.

This component combines the best of both worlds. The original browser that makes
the request will still have a great, high-performance streaming experience. But
the chat body is also stored in the database, so it can be accessed by the
client even after the stream has finished, or by other users, etc.

## Background

This component is largely based on the Stack post
[AI Chat with HTTP Streaming](https://stack.convex.dev/ai-chat-with-http-streaming).

<!-- END: Include on https://convex.dev/components -->
