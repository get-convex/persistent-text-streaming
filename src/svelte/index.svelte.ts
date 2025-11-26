/// Svelte helpers for persistent text streaming.

import type { StreamStatus } from "../component/schema.js";
import { useQuery } from "convex-svelte";
import type { StreamBody, StreamId } from "../client/index.js";
import type { FunctionReference } from "convex/server";

/**
 * Svelte 5 rune-based hook for persistent text streaming.
 *
 * @param getPersistentBody - A query function reference that returns the body
 * of a stream using the component's `getStreamBody` method.
 * @param streamUrl - The URL of the http action that will kick off the stream
 * generation and stream the result back to the client using the component's
 * `stream` method.
 * @param getDriven - A getter function returning whether this particular session
 * is driving the stream. Return true if this is the client session that first
 * created the stream using the component's `createStream` method. If you're
 * simply reloading an existing stream, return false.
 * @param getStreamId - A getter function returning the ID of the stream. If this
 * returns undefined, the return value will be an empty string for the stream
 * body and the status will be `pending`.
 * @returns A reactive object with `text` and `status` properties.
 */
export function useStream(
  getPersistentBody: FunctionReference<
    "query",
    "public",
    { streamId: string },
    StreamBody
  >,
  streamUrl: URL,
  getDriven: () => boolean,
  getStreamId: () => StreamId | undefined,
  opts?: {
    // If provided, this will be passed as the Authorization header.
    authToken?: string | null;
    // If provided, these will be passed as additional headers.
    headers?: Record<string, string>;
  },
): { readonly text: string; readonly status: StreamStatus } {
  // Svelte 5 runes for state management
  let streamEnded = $state<boolean | null>(null);
  let streamBody = $state("");
  let streamStarted = $state(false);

  // Determine if we should use persistence (database) vs HTTP streaming
  const usePersistence = $derived(
    // Something is wrong with the stream, so we need to use the database value.
    streamEnded === false ||
    // If we're not driving the stream, we must use the database value.
    !getDriven()
  );

  // Query the persistent body from Convex when needed
  const persistentBodyQuery = useQuery(
    getPersistentBody,
    () => {
      const streamId = getStreamId();
      return usePersistence && streamId ? { streamId } : "skip";
    },
  );

  // Kick off HTTP streaming when driven and streamId is available
  $effect(() => {
    const driven = getDriven();
    const streamId = getStreamId();

    if (driven && streamId && !streamStarted) {
      // Mark as started immediately to prevent double-execution
      streamStarted = true;

      // Kick off HTTP action
      void (async () => {
        const success = await startStreaming(
          streamUrl,
          streamId,
          (text) => {
            streamBody += text;
          },
          {
            ...opts?.headers,
            ...(opts?.authToken
              ? { Authorization: `Bearer ${opts.authToken}` }
              : {}),
          },
        );
        streamEnded = success;
      })();
    }
  });

  // Compute the final body based on persistence or streaming state
  const body = $derived.by((): StreamBody => {
    const persistentBody = persistentBodyQuery.data;

    if (persistentBody) {
      return persistentBody;
    }

    let status: StreamStatus;
    if (streamEnded === null) {
      status = streamBody.length > 0 ? "streaming" : "pending";
    } else {
      status = streamEnded ? "done" : "error";
    }

    return {
      text: streamBody,
      status: status as StreamStatus,
    };
  });

  // Return reactive getters
  return {
    get text() {
      return body.text;
    },
    get status() {
      return body.status;
    },
  };
}

/**
 * Internal helper for starting a stream.
 *
 * @param url - The URL of the http action that will kick off the stream
 * generation and stream the result back to the client using the component's
 * `stream` method.
 * @param streamId - The ID of the stream.
 * @param onUpdate - A function that updates the stream body.
 * @returns A promise that resolves to a boolean indicating whether the stream
 * was started successfully. It can fail if the http action is not found, or
 * CORS fails, or an exception is raised, or the stream is already running
 * or finished, etc.
 */
async function startStreaming(
  url: URL,
  streamId: StreamId,
  onUpdate: (text: string) => void,
  headers: Record<string, string>,
) {
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify({
      streamId: streamId,
    }),
    headers: { "Content-Type": "application/json", ...headers },
  });
  // Adapted from https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams
  if (response.status === 205) {
    console.error("Stream already finished", response);
    return false;
  }
  if (!response.ok) {
    console.error("Failed to reach streaming endpoint", response);
    return false;
  }
  if (!response.body) {
    console.error("No body in response", response);
    return false;
  }
  const reader = response.body.getReader();
  while (true) {
    try {
      const { done, value } = await reader.read();
      if (done) {
        onUpdate(new TextDecoder().decode(value));
        return true;
      }
      onUpdate(new TextDecoder().decode(value));
    } catch (e) {
      console.error("Error reading stream", e);
      return false;
    }
  }
}
