# Convex Component: Persistent Text Streaming

[![npm version](https://badge.fury.io/js/@convex-dev%2Fpersistent-text-streaming.svg)](https://badge.fury.io/js/@convex-dev%2Fpersistent-text-streaming)

<!-- START: Include on https://convex.dev/components -->

This Convex component is designed to solve a common, thorny challenge in building modern interactive applications: **how to deliver real-time, token-by-token text streaming to a user while also durably persisting that content for later access, reloads, or observation by others.**

It's particularly well-suited for applications generating text incrementally, such as:
*   AI-powered chat and content generation features.
*   Live data feeds and activity logs.
*   Progress indicators for long-running jobs.

## The Problem: Choosing Between Speed and Durability

When streaming text, developers often face a trade-off:

1.  **Pure HTTP Streaming:**
    *   **Pro:** Delivers the lowest latency to the active user, as text chunks arrive directly and immediately.
    *   **Con:** The data is ephemeral. A page refresh, lost connection, or the need for another user to view the content means the streamed information is gone because it was never stored.

2.  **Pure Database Persistence (for every chunk):**
    *   **Pro:** All data is durably stored in Convex and accessible. Convex's reactivity can update observers.
    *   **Con:** Writing every tiny text chunk (e.g., individual LLM tokens) to the database can be inefficient, leading to high write loads, increased network traffic for subscribers (as entire documents might be resent frequently), and potentially a less fluid UX if updates are batched too aggressively to compensate.

**This component eliminates that trade-off.**

## The Solution: Intelligent Dual-Path Streaming

`@convex-dev/persistent-text-streaming` provides a sophisticated "best of both worlds" approach:

*   **For the "Driving" Client (User initiating the stream):** Text is streamed token-by-token directly via an HTTP connection, ensuring a highly responsive and immediate experience.
*   **For Persistence & Other Clients:** Simultaneously, the component intelligently buffers the streamed text and writes it to the Convex database in optimized chunks (e.g., sentence by sentence). This ensures data durability and efficient updates for:
    *   The same user after a page reload.
    *   Other users observing the stream.
    *   Long-term archival and retrieval.

This dual-path mechanism delivers a superior user experience without compromising on data integrity or scalability.

**See It In Action:**
The active user (left) sees a word-by-word stream, while an observer (right) sees updates from the database, typically at sentence boundaries for efficiency.

![example-animation](./anim.gif)

## Key Features

*   **Low-Latency Streaming:** Provides an immediate, token-by-token experience for the active user.
*   **Durable Persistence:** Reliably stores the complete streamed text in your Convex database.
*   **Efficient Updates for Observers:** Optimizes database writes and leverages Convex's reactivity for non-driving clients.
*   **Seamless Experience:** Gracefully handles page reloads and concurrent viewers.
*   **Simplified Development:** Abstracts the complex logic of managing concurrent HTTP streaming and database persistence.
*   **Flexible:** Suitable for any text-generation source (LLMs, data processing, live logs, etc.).

## Pre-requisite: Convex

You'll need an existing Convex project to use the component.
Convex is a hosted backend platform, including a database, serverless functions,
and a ton more you can learn about [here](https://docs.convex.dev/get-started).

Run `npm create convex` or follow any of the [quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

1.  **Install the package** into your Convex project:
    ```bash
    npm install @convex-dev/persistent-text-streaming
    ```

2.  **Register the component** in your Convex backend (`convex/convex.config.ts`):
    ```typescript
    // convex/convex.config.ts
    import { defineApp } from "convex/server";
    import persistentTextStreaming from "@convex-dev/persistent-text-streaming/convex.config";
    
    const app = defineApp();
    // This makes the component's backend functions available under `components.persistentTextStreaming`
    app.use(persistentTextStreaming);
    
    export default app;
    ```

## Usage Overview

Integrating `@convex-dev/persistent-text-streaming` involves a backend setup to manage and serve the stream and a frontend (React) setup to consume and display it. Here's a high-level look at the core steps:

**On the Backend (Convex):**

1.  **Initialize Component Client:** Instantiate `PersistentTextStreaming` using `components.persistentTextStreaming` (from `_generated/api`).
2.  **Create Stream ID:** In a mutation, when an operation generating text begins (e.g., user sends a message, a task starts), call `streamingComponent.createStream(ctx)`. This returns a unique `StreamId`.
3.  **Store Stream ID:** Save this `StreamId` in your relevant application database document (e.g., alongside a user's message or a task record).
4.  **Implement HTTP Streaming Action:**
    *   Create a Convex HTTP action. The "driving" client will `POST` to this action, sending the `StreamId`.
    *   Inside this action, use `streamingComponent.stream(ctx, request, streamId, writerCallback)`.
    *   Your `writerCallback` (an async function you provide) generates/fetches text and calls the provided `append(textChunk)` function. `append` immediately sends the chunk over the HTTP response *and* queues it for optimized database persistence.
5.  **Query Persisted Data:** Create a Convex query using `streamingComponent.getStreamBody(ctx, streamId)` to retrieve the complete, persisted text and status for any given `StreamId`. This is used by non-driving clients or as a fallback.

**On the Frontend (React):**

1.  **Use the `useStream` Hook:** Import `useStream` from `@convex-dev/persistent-text-streaming/react`.
2.  **Provide Hook Parameters:**
    *   Your Convex query for fetching persisted data (step 5 above).
    *   The full URL to your HTTP streaming action (step 4 above).
    *   An `isDriven` boolean flag: `true` if this client session initiated the stream, `false` otherwise.
    *   The `StreamId` of the content to display.
3.  **Render Streamed Text:** The hook returns `{ text, status }`, automatically managing data fetching (via HTTP stream if `isDriven`, or via database query otherwise) and providing reactive updates.

**For a comprehensive, step-by-step guide with detailed code examples from a working AI chat application, please see our [Example App Implementation Guide](./example/README.md).** This guide walks through schema design, all necessary backend functions, and frontend React component integration.

## How It Works: The Dual-Path Mechanism

The power of this component lies in its intelligent handling of text streaming and persistence, primarily orchestrated by the `useStream` hook on the frontend based on the `isDriven` flag:

*   **When `isDriven` is `true` (e.g., the client that submitted an AI prompt):**
    1.  The `useStream` hook makes an HTTP `POST` request to your configured `streamUrl` (your HTTP streaming action), passing the `streamId`.
    2.  Your backend HTTP action, using `streamingComponent.stream()`, starts generating text and calls `append(chunk)`.
    3.  The `append` function *immediately* sends `chunk` over the HTTP response to this driving client.
    4.  Simultaneously, `append` buffers chunks and schedules optimized writes to the Convex database (e.g., at sentence boundaries).
    5.  The driving client experiences very low-latency, token-by-token updates directly from the HTTP stream.

*   **When `isDriven` is `false` (e.g., another user viewing the same chat, or the original user after a page reload):**
    1.  The `useStream` hook *does not* make an HTTP request to `streamUrl`.
    2.  Instead, it primarily relies on the Convex query you provided (e.g., `api.yourModule.getStreamBody`) to fetch the text.
    3.  As the backend (driven by the *other* client or its initial action) persists chunks to the database, Convex's reactivity system automatically updates the query results for these non-driving clients.
    4.  These observer clients see updates as they are committed to the database, typically in slightly larger, more efficient batches.

This mechanism ensures the initiating user gets the fastest possible experience, while all other viewers receive consistent, durable data efficiently.

## Viewing Component Data in the Convex Dashboard

This component manages its own data tables within your Convex project. You can inspect this data:

1.  Click on your Convex project in the [Convex Dashboard](https://dashboard.convex.dev) and go to the "Data" section.
2.  Use the table component selector and to switch from the `app` to `persistentTextStreaming`.

You'll find two tables:
* **`streams`**: Records for each stream, tracking its overall status (e.g., `pending`, `streaming`, `done`, `error`, `timeout`).
* **`chunks`**: The actual text content, broken into pieces and linked to a `streamId`.

## API Highlights

### Backend (`PersistentTextStreaming` class)

*   `new PersistentTextStreaming(components.persistentTextStreaming)`: Initializes the component client.
*   `async createStream(ctx: MutationCtx): Promise<StreamId>`: Creates a unique stream ID.
*   `async stream(ctx: ActionCtx, request: Request, streamId: StreamId, writerCallback)`: The core method for HTTP streaming and database persistence. The `writerCallback` (an async function you provide) receives an `append(text: string)` function to send text chunks.
*   `async getStreamBody(ctx: QueryCtx, streamId: StreamId): Promise<{ text: string; status: StreamStatus }>`: Retrieves the full persisted text and current status of a stream.

(Refer to the source code and the [Example App Implementation Guide](./example/README.md) for full-type signatures and advanced usage.)

### Frontend (`useStream` React Hook)

*   `useStream(getPersistentBodyQuery, streamUrl, isDriven, streamId)`:
    *   `getPersistentBodyQuery`: Convex query to fetch persisted stream data.
    *   `streamUrl`: Full URL to your HTTP streaming action.
    *   `isDriven`: Boolean, `true` if this client initiated/drives the stream.
    *   `streamId`: The ID of the stream to display.
    *   Returns: `{ text: string; status: StreamStatus }`. Manages data fetching based on `isDriven` and provides reactive updates.

## Background

This component's approach and design are largely based on the concepts discussed in the Convex Stack post: [AI Chat with HTTP Streaming](https://stack.convex.dev/ai-chat-with-http-streaming).

<!-- END: Include on https://convex.dev/components -->
