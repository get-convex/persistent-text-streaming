# Example App: AI Chat with Persistent Text Streaming

This is a simple AI-powered chat application built with React, Vite, and Convex. It serves as a practical demonstration of the **`@convex-dev/persistent-text-streaming`** component, showcasing how to achieve real-time, low-latency text streaming to the active user while simultaneously ensuring the conversation is durably persisted in the Convex database for reloads and other observers.

## Running the Example

### Prerequisites

*   Node.js (v18 or newer recommended)
*   npm (v10 or newer recommended)
*   A Convex account and project set up. If you don't have one, run `npm create convex`.

### 1. Install Dependencies

Navigate to this `example` directory and the root directory to install dependencies:

```bash
# From the root of the repository
npm install

# Navigate into the example directory
cd example
npm install
```

### 2. Configure OpenAI API Key

This chat app uses OpenAI's API to generate responses. You'll need to set your `OPENAI_API_KEY` as an environment variable in your Convex deployment:

1.  Obtain an API key from [OpenAI](https://platform.openai.com/api-keys).
2.  In your terminal (while in the `example` directory or the project root), run:
    ```bash
    npx convex env set OPENAI_API_KEY <your-openai-api-key>
    ```
    Replace `<your-openai-api-key>` with your actual key.

### 3. Run the Development Servers

You'll need two terminal sessions: one for the Convex backend and one for the Vite frontend.

**Terminal 1: Convex Backend**
(From the `example` directory)
```bash
npm run dev:backend
# This runs: convex dev --live-component-sources --typecheck-components
```
This command starts the Convex local development backend. The flags ensure it picks up the component source code correctly for live development.

**Terminal 2: Vite Frontend**
(From the `example` directory)
```bash
npm run dev:frontend
# This runs: vite
```
This starts the React frontend development server. Your browser should automatically open to the chat application. If not, navigate to the URL shown in the terminal (usually `http://localhost:5173`).

You should now be able to interact with the chat application!

## How `@convex-dev/persistent-text-streaming` is Used

This example app leverages the component in several key areas, both on the backend (Convex functions) and frontend (React components).

### A. Backend Setup (Convex Functions)

#### 1. Component Registration (`convex/convex.config.ts`)

First, the component is registered with the Convex app. This makes its backend functions available to our application.

```typescript
// example/convex/convex.config.ts
import { defineApp } from "convex/server";
import persistentTextStreaming from "@convex-dev/persistent-text-streaming/convex.config";

const app = defineApp();
// The `use` method registers the component's schema and functions
// under the 'persistentTextStreaming' namespace.
app.use(persistentTextStreaming);

export default app;
```
After this, the component's API can be accessed via `components.persistentTextStreaming` in other Convex functions.

#### 2. Database Schema (`convex/schema.ts`)

The application defines a `userMessages` table to store user prompts and link them to the AI's streamed response.

```typescript
// example/convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
// StreamIdValidator ensures the ID format is correct for the component.
import { StreamIdValidator } from "@convex-dev/persistent-text-streaming";
import { v } from "convex/values";

export default defineSchema({
  userMessages: defineTable({
    prompt: v.string(),
    // This field stores the unique ID for the AI's response stream,
    // managed by the persistent-text-streaming component.
    responseStreamId: StreamIdValidator,
  }).index("by_stream", ["responseStreamId"]), // Optional index
});
```
The component itself internally manages its own `streams` and `chunks` tables; you don't define those in your application's schema.

#### 3. Initializing the Component Client (`convex/streaming.ts`)

A client instance for the `PersistentTextStreaming` component is created to interact with its API.

```typescript
// example/convex/streaming.ts
import {
  PersistentTextStreaming,
  StreamId,
  StreamIdValidator,
} from "@convex-dev/persistent-text-streaming";
// `components` is auto-generated, providing access to mounted component APIs.
import { components } from "./_generated/api";
import { query } from "./_generated/server";

// Initialize the component client, pointing to its registered API namespace.
export const streamingComponent = new PersistentTextStreaming(
  components.persistentTextStreaming
);

// Query to retrieve the fully assembled text and status of a persisted stream.
// This is used by non-driving clients or as a fallback by the `useStream` hook.
export const getStreamBody = query({
  args: {
    streamId: StreamIdValidator,
  },
  handler: async (ctx, args) => {
    return await streamingComponent.getStreamBody(
      ctx,
      args.streamId as StreamId // Cast to the strong StreamId type
    );
  },
});
```

#### 4. Creating a Stream on New User Message (`convex/messages.ts -> sendMessage`)

When a user sends a new prompt, the `sendMessage` mutation is called. It prepares for the AI's streamed response by creating a new stream ID.

```typescript
// example/convex/messages.ts
import { query, mutation, internalQuery } from "./_generated/server";
import { StreamId } from "@convex-dev/persistent-text-streaming";
import { v } from "convex/values";
import { streamingComponent } from "./streaming"; // Our initialized component client
// ... other imports

export const sendMessage = mutation({
  args: {
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    // 1. Create a new stream ID using the component. This prepares the backend
    //    to receive and persist chunks for this specific response.
    const responseStreamId = await streamingComponent.createStream(ctx);

    // 2. Insert the user's message into our `userMessages` table,
    //    linking it to the newly created `responseStreamId`.
    const chatId = await ctx.db.insert("userMessages", {
      prompt: args.prompt,
      responseStreamId, // This ID will be used by the frontend to fetch the stream.
    });

    // Note: The actual AI generation and streaming to this `responseStreamId`
    // is typically triggered by an HTTP action, called by the frontend.
    return chatId; // Returns the ID of the `userMessages` document.
  },
});
```

#### 5. Streaming AI Response via HTTP Action (`convex/chat.ts -> streamChat`)

The core of the streaming logic resides in an HTTP action. The frontend (specifically the `useStream` hook for the "driving" client) calls this endpoint to initiate the AI response generation and receive it as an HTTP stream.

```typescript
// example/convex/chat.ts
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { StreamId } from "@convex-dev/persistent-text-streaming";
import { OpenAI } from "openai";
import { streamingComponent } from "./streaming";

const openai = new OpenAI(); // Requires OPENAI_API_KEY in Convex env vars

export const streamChat = httpAction(async (ctx, request) => {
  // The frontend sends the `streamId` (obtained from the `userMessages` document)
  // to identify which stream this AI response belongs to.
  const body = (await request.json()) as {
    streamId: string;
  };

  // `streamingComponent.stream()` is the central method. It:
  // - Takes care of setting up the HTTP streaming response to the client.
  // - Provides an `append` function to its callback.
  // - Persists appended text to the database.
  const response = await streamingComponent.stream(
    ctx, // ActionCtx, can be used to run queries/mutations if needed
    request, // The original HTTP request object
    body.streamId as StreamId, // The specific stream to write to
    // This async callback is where the AI response is generated and "appended":
    async (_actionCtx, _httpRequest, _sId, append) => {
      const history = await ctx.runQuery(internal.messages.getHistory); // For context

      const stream = await openai.chat.completions.create({
        model: "gpt-4.1-mini", // Or your preferred model
        messages: [
          { role: "system", content: "You are a helpful assistant..." },
          ...history,
        ],
        stream: true,
      });

      // As OpenAI (or any source) streams chunks of text:
      for await (const part of stream) {
        const content = part.choices[0]?.delta?.content || "";
        // Calling `append(content)` does two things:
        // 1. Sends `content` immediately over the HTTP stream to the "driving" client.
        // 2. Buffers `content` and schedules it for persistence in the database
        //    (typically flushed at sentence boundaries or when the stream ends).
        await append(content);
      }
    }
  );

  // Set CORS headers for the HTTP response.
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Vary", "Origin");

  return response;
});
```

#### 6. Routing the HTTP Action (`convex/http.ts`)

The `streamChat` HTTP action needs to be mapped to a public URL.

```typescript
// example/convex/http.ts
import { httpRouter } from "convex/server";
import { streamChat } from "./chat"; // Our HTTP action
import { httpAction } from "./_generated/server"; // For basic HTTP actions

const http = httpRouter();

// Route for initiating the chat stream. The frontend will POST to this path.
http.route({
  path: "/chat-stream",
  method: "POST",
  handler: streamChat,
});

// Standard CORS OPTIONS handler for the /chat-stream path.
http.route({
  path: "/chat-stream",
  method: "OPTIONS",
  handler: httpAction(async (_, request) => {
    // ... (Full CORS header logic as in the example file) ...
    return new Response(null, { /* ... CORS headers ... */ });
  }),
});

export default http;
```

#### 7. Retrieving Persisted Stream Content (`convex/streaming.ts -> getStreamBody`)

The `getStreamBody` query (defined earlier in `convex/streaming.ts`) allows any client (especially non-driving ones or after a reload) to fetch the complete, persisted text of a stream. The `useStream` hook on the frontend uses this as its source of truth when not directly driving the HTTP stream.

```typescript
// example/convex/streaming.ts (relevant part)
export const getStreamBody = query({
  args: { streamId: StreamIdValidator },
  handler: async (ctx, args) => {
    // `streamingComponent.getStreamBody` reconstructs the full text
    // from the internally managed 'chunks' table for the given streamId.
    return await streamingComponent.getStreamBody(ctx, args.streamId as StreamId);
  },
});
```
The `convex/messages.ts -> getHistory` internal query also demonstrates using `streamingComponent.getStreamBody` to fetch AI responses for building conversation context.

### B. Frontend Implementation (React Components)

#### 1. Triggering Message Sending & Managing "Driven" State (`src/components/ChatWindow.tsx`)

When the user submits a prompt, `ChatWindow.tsx` calls the `sendMessage` mutation and keeps track of which messages this client session "drives" (i.e., initiated the stream for).

```typescript
// example/src/components/ChatWindow.tsx (simplified logic)
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import React, { useState } from "react";
// ... ServerMessage import

export default function ChatWindow() {
  const [inputValue, setInputValue] = useState("");
  // `drivenIds` stores the `_id` of `userMessages` documents for which
  // this client session initiated the AI response stream.
  const [drivenIds, setDrivenIds] = useState<Set<string>>(new Set());
  const messages = useQuery(api.messages.listMessages);
  const sendMessageMutation = useMutation(api.messages.sendMessage);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // ... (input validation) ...
    const userMessageDocId = await sendMessageMutation({ prompt: inputValue });
    setInputValue("");

    // Add the ID of the new userMessage document to `drivenIds`.
    // This signals that the `ServerMessage` component for this AI response
    // should be "driven" by this client.
    setDrivenIds((prev) => new Set(prev).add(userMessageDocId));
    // ... (setIsStreaming(true) for UI feedback)
  };

  // In the render method, when mapping through `messages`:
  // <ServerMessage
  //   message={message} // The Doc<"userMessages">
  //   isDriven={drivenIds.has(message._id)} // Pass the "driven" status
  //   // ... other props
  // />
  // ...
}
```

#### 2. Displaying the Streamed Response with `useStream` (`src/components/ServerMessage.tsx`)

This component is responsible for rendering the AI's response. It uses the `useStream` hook from `@convex-dev/persistent-text-streaming/react`.

```typescript
// example/src/components/ServerMessage.tsx
import { getConvexSiteUrl } from "@/lib/utils"; // Helper for HTTP endpoint URL
import { StreamId } from "@convex-dev/persistent-text-streaming";
import { useStream } from "@convex-dev/persistent-text-streaming/react"; // The hook!
import { api } from "../../convex/_generated/api";
import { Doc } from "../../convex/_generated/dataModel";
import { useMemo, useEffect } from "react";
import Markdown from "react-markdown";

export function ServerMessage({
  message, // The Doc<"userMessages"> from the database
  isDriven, // Boolean: true if this client session initiated this AI stream
  stopStreaming, // Callback for UI state
  scrollToBottom, // Callback for UI state
}: {
  message: Doc<"userMessages">;
  isDriven: boolean;
  stopStreaming: () => void;
  scrollToBottom: () => void;
}) {
  // Construct the full URL to the HTTP streaming endpoint (`/chat-stream`)
  const streamEndpointUrl = useMemo(() => {
    try {
      return new URL(`${getConvexSiteUrl()}/chat-stream`);
    } catch (e) { /* ... error handling ... */ return null; }
  }, []);

  // The `useStream` hook manages fetching and displaying the stream.
  const { text, status } = useStream(
    api.streaming.getStreamBody,    // 1. Convex query for persisted data (used if !isDriven or as fallback)
    streamEndpointUrl!,             // 2. URL of your HTTP streaming action (e.g., convex/chat.ts -> streamChat)
    isDriven,                       // 3. Critical flag: if true, hook POSTs to streamUrl to drive the HTTP stream.
                                    //    If false, relies on the query and Convex subscriptions.
    message.responseStreamId as StreamId // 4. The ID of the stream to display.
  );

  // ... (useEffect hooks for UI updates like scrolling and stopping streaming indicator) ...

  return (
    <div className="md-answer">
      <Markdown>{text || (status === "pending" && isDriven ? "AI is thinking..." : "")}</Markdown>
      {/* ... (display error/timeout based on `status`) ... */}
    </div>
  );
}
```
The `getConvexSiteUrl()` helper in `src/lib/utils.ts` is used to correctly determine the base URL for the HTTP endpoint, accounting for local development (port + 1) versus cloud deployments (`.site` TLD).

### C. Viewing Component Data in Convex Dashboard

You can inspect the data managed by the `@convex-dev/persistent-text-streaming` component directly in your Convex Dashboard:

1.  Click on your Convex project in the [Convex Dashboard](https://dashboard.convex.dev) and go to the "Data" section.
2.  Use the table component selector and to switch from the `app` to `persistentTextStreaming`.

You'll find two tables:
* **`streams`**: Records for each stream, tracking its overall status (e.g., `pending`, `streaming`, `done`, `error`, `timeout`).
* **`chunks`**: The actual text content, broken into pieces and linked to a `streamId`.

The `streamingComponent.getStreamBody()` function (and thus `api.streaming.getStreamBody`) reads from these tables to reconstruct the full message.

## Key Takeaways from this Example

*   **Dual Path for Optimal UX:** The "driving" client gets ultra-low latency via HTTP streaming, while persisted data allows reloads and observation by other clients efficiently.
*   **Simplified Complexity:** The component handles the intricacies of managing both the HTTP stream and database persistence.
*   **Clear Separation of Concerns:** Your application logic focuses on when to create streams and how to generate content, while the component handles the streaming mechanics.
*   **Leverages Convex Strengths:** Uses Convex mutations for transactional stream creation, HTTP actions for direct streaming, queries for data retrieval, and Convex's reactivity for updating non-driving clients.
