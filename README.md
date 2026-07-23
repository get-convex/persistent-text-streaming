# Convex Component: Persistent Text Streaming

[![npm version](https://badge.fury.io/js/@convex-dev%2Fpersistent-text-streaming.svg)](https://badge.fury.io/js/@convex-dev%2Fpersistent-text-streaming)

<!-- START: Include on https://convex.dev/components -->

Persistent Text Streaming sends generated text to one browser with low latency,
stores it in Convex, and lets other browsers follow the durable stream. It is
designed for AI chat, but it works with any text producer.

The component uses two paths behind the existing API:

- The driving browser receives raw text over HTTP as the producer emits it.
- Everyone else -- followers, reloads, and recovery -- subscribes to bounded
  append-only pages over the normal Convex websocket. No HTTP request, and no
  resending the whole body on every append.

An atomic claim allows only one request to run the producer. A duplicate driving
request receives the existing `205` response and reads durably instead.

![example-animation](./anim.gif)

## Prerequisite

Add this component to an existing [Convex](https://convex.dev) project. You can
create one with `npm create convex` or follow a
[Convex quickstart](https://docs.convex.dev/home).

## Installation

Install the package:

```bash
npm install @convex-dev/persistent-text-streaming
```

This release requires Convex 1.39 or newer.

Register the component in `convex/convex.config.ts`:

```ts
import persistentTextStreaming from "@convex-dev/persistent-text-streaming/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(persistentTextStreaming);
export default app;
```

See [`example/`](./example/) for a complete app.

## Backend setup

Create one client for the component:

```ts
// convex/streaming.ts
import {
  PersistentTextStreaming,
  StreamId,
  StreamIdValidator,
} from "@convex-dev/persistent-text-streaming";
import { streamQueryArgsValidator } from "@convex-dev/stream";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

export const streaming = new PersistentTextStreaming(
  components.persistentTextStreaming,
);

// The full-body query remains part of the public API for history and server
// logic. The React hook uses it only when `readStream` is not provided.
export const getStreamBody = query({
  args: { streamId: StreamIdValidator },
  handler: async (ctx, { streamId }) =>
    streaming.getStreamBody(ctx, streamId as StreamId),
});

// Followers and recovery subscribe here. Authorize the caller exactly as you
// do for getStreamBody -- this query returns persisted assistant text.
export const readStream = query({
  args: { streamId: StreamIdValidator, streamArgs: streamQueryArgsValidator },
  handler: async (ctx, { streamId, streamArgs }) =>
    streaming.readStream(ctx, streamId as StreamId, streamArgs),
});
```

Create a stream and store its opaque ID in an app-owned record:

```ts
export const createChat = mutation({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    const streamId = await streaming.createStream(ctx);
    return ctx.db.insert("chats", { prompt, streamId });
  },
});
```

Create the HTTP action that produces text:

```ts
export const streamChat = httpAction(async (ctx, request) => {
  const { streamId } = (await request.json()) as { streamId: string };

  // Required in production: authenticate the caller and verify that this
  // stream belongs to a record the caller may read or generate. Do this before
  // calling stream(). The component cannot infer your app's ownership rules.

  const response = await streaming.stream(
    ctx,
    request,
    streamId as StreamId,
    async (_ctx, _request, _streamId, append) => {
      await append("Hi there! ");
      await append("How are you?");
    },
  );

  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Vary", "Origin");
  return response;
});
```

`stream()` keeps the same signature:

```ts
stream(ctx, request, streamId, writer): Promise<Response>
```

Only the driving browser calls this route, and only to generate text. It is not
a read endpoint.

## HTTP route and CORS

Register POST and OPTIONS routes:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { streamChat } from "./chat";

const http = httpRouter();

http.route({ path: "/chat-stream", method: "POST", handler: streamChat });

http.route({
  path: "/chat-stream",
  method: "OPTIONS",
  handler: httpAction(
    async () =>
      new Response(null, {
        headers: new Headers({
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, Digest, Authorization",
          "Access-Control-Max-Age": "86400",
        }),
      }),
  ),
});

export default http;
```

Add every custom request header to `Access-Control-Allow-Headers`. Only the
driving browser reaches this route; followers never leave the websocket, so no
additional CORS configuration is required to read a stream.

For production, replace `*` with your frontend origin. CORS controls browser
access; it does not authenticate or authorize a request.

## React

```ts
import { useStream } from "@convex-dev/persistent-text-streaming/react";

const { text, status } = useStream(
  api.streaming.getStreamBody,
  new URL(`${convexSiteUrl}/chat-stream`),
  driven,
  chat.streamId as StreamId,
  {
    readStream: api.streaming.readStream,
    authToken,
    headers: { "X-Workspace": workspaceId },
  },
);
```

Its signature is:

```ts
useStream(
  getPersistentBody,
  streamUrl,
  driven,
  streamId,
  opts?,
): StreamBody
```

- `getPersistentBody` returns the whole body in one query. It is the read path
  when `opts.readStream` is absent.
- `driven` tells this browser to try the producer path. The atomic server claim,
  not this boolean, decides which request may generate text.
- `opts.readStream` is the app-owned query described above. Provide it to read
  bounded pages instead of the whole body on every append.
- `opts.authToken` sends `Authorization: Bearer <token>` on the drive request.
- `opts.headers` sends additional app headers on the drive request.

A token that rotates mid-stream does not restart the transport or clear the text
already on screen.

## Security

Both entry points return or generate assistant text, and both need your own
authorization:

- The HTTP action can invoke an LLM or another costly producer.
- `readStream` returns persisted assistant text.

Authenticate the request, resolve the app record that stores `streamId`, and
verify the caller may access it. Never treat `driven` or possession of a
`StreamId` as authorization. The atomic claim prevents duplicate producers; it
is not an authorization check.

`readStream` is an ordinary Convex query, so the check belongs in its handler
alongside the one you already have in `getStreamBody`.

## Performance and recovery

The driving response sends raw text immediately. Persistence runs through a
single ordered queue and flushes at sentence punctuation, after about 100 ms, or
at 16 KiB. Producer failures flush pending text before recording `error`.

Followers subscribe to append-only pages of at most 16 events rather than to the
complete growing string. A query invalidation therefore reads and sends only the
delta, where the previous release re-read every chunk and re-sent the whole body
on every append. The React client publishes visible text at a fixed cadence of
about 50 ms rather than once per model token.

If the raw drive connection fails, the driving browser switches to the same
durable read as every other client. The replay restarts at the beginning of the
stream but does not rewind what is already on screen: the raw text is a prefix
of the durable text, so it stays visible until the replay passes it.

`getStreamBody()` still returns the complete stored text and status in one
Convex query for history, server logic, and compatibility. It is therefore
subject to Convex transaction and value limits and is not suitable for unbounded
output. Prefer `readStream` for live text.

## Storage upgrades

Upgrading requires no data migration and no API signature changes. Apps should
add the `readStream` query and pass it to `useStream`; without it the hook keeps
the previous full-body read behavior.

- New streams store ordered events and lifecycle state through
  `@convex-dev/stream`.
- Existing `StreamId` values remain valid.
- Streams created by older releases keep their legacy chunk rows and remain
  readable, writable, followable, and deletable.
- In-flight legacy producers can finish while new clients follow their output.

The component selects the storage path from the stable stream record. It does
not rewrite or discard existing assistant text.

## Public API

Every existing signature is unchanged; `readStream` and the matching `opts`
field are additive:

```ts
new PersistentTextStreaming(component, options?)
createStream(ctx): Promise<StreamId>
getStreamBody(ctx, streamId): Promise<StreamBody>
readStream(ctx, streamId, streamArgs): Promise<StreamReadResult<string, string>>
stream(ctx, request, streamId, writer): Promise<Response>
deleteStream(ctx, streamId): Promise<void>
useStream(getPersistentBody, streamUrl, driven, streamId, opts?): StreamBody
```

`StreamBody.status` is `pending`, `streaming`, `done`, `error`, or `timeout`.

## Background

This component builds on
[AI Chat with HTTP Streaming](https://stack.convex.dev/ai-chat-with-http-streaming).

<!-- END: Include on https://convex.dev/components -->
