/// Svelte helpers for persistent text streaming.
import type { StreamStatus } from "../component/schema.js";
import { useQuery } from "convex-svelte";
import { untrack } from "svelte";
import type { StreamBody, StreamId } from "../client/index.js";
import type { FunctionReference } from "convex/server";

/**
 * Svelte 5 version of the React `useStream` hook. Call it while a component
 * initializes. Reactive inputs are getters so Svelte can track them.
 *
 * @param getPersistentBody - A query function reference that returns the body
 * of a stream using the component's `getStreamBody` method.
 * @param streamUrl - The URL of the http action that will kick off the stream
 * generation and stream the result back to the client using the component's
 * `stream` method.
 * @param getDriven - Returns whether this particular session is driving the
 * stream. Return true if this is the client session that first created the
 * stream using the component's `createStream` method. If you're simply
 * reloading an existing stream, return false.
 * @param getStreamId - Returns the ID of the stream. While it returns
 * undefined, the text is empty and the status is `pending`.
 * @param getOpts - Returns request options. They are read when a stream
 * starts, so a changed auth token applies to the next stream without
 * aborting the current one.
 * @returns A reactive object with the `text` and `status` of the stream.
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
  getOpts?: () => {
    // If provided, this will be passed as the Authorization header.
    authToken?: string | null;
    // If provided, these will be passed as additional headers.
    headers?: Record<string, string>;
  },
): Readonly<StreamBody> {
  let streamBody = $state("");
  let streamEnded = $state<boolean | null>(null);
  // Set when this session drives a stream it already requested once.
  let resumed = $state(false);

  // Every stream ID this hook has POSTed. Aborting a request does not stop
  // the backend writer, so a second POST for the same ID could start a
  // second writer on the same stream. Holds one entry per stream seen.
  const attempted = new Set<StreamId>();

  // Deriveds only notify dependents when their value changes, so the effect
  // below never re-runs because a getter re-ran with the same id.
  const driven = $derived(getDriven());
  const streamId = $derived(getStreamId());

  const usePersistence = $derived(
    // Something is wrong with the stream, so we need to use the database value.
    streamEnded === false ||
      // The HTTP stream for this ID was already used, so only the database
      // has the full text.
      resumed ||
      // If we're not driving the stream, we must use the database value.
      !driven,
  );

  const persistentBody = useQuery(getPersistentBody, () =>
    usePersistence && streamId ? { streamId } : "skip",
  );

  // Effects only run in the browser, so SSR never sends the request.
  $effect(() => {
    if (!driven || !streamId) {
      return;
    }

    // Reset state from any previous stream.
    streamBody = "";
    streamEnded = null;
    // Branch on a local, not on `resumed`: reading the state here would make
    // the effect re-run, and abort the new stream, when it resets to false.
    const isResume = attempted.has(streamId);
    resumed = isResume;
    if (isResume) {
      return;
    }
    attempted.add(streamId);

    const controller = new AbortController();
    // Read every option untracked: a changed token or header applies to the
    // next stream and must not abort the current one.
    const headers = untrack(() => {
      const opts = getOpts?.();
      return {
        "Content-Type": "application/json",
        ...opts?.headers,
        ...(opts?.authToken
          ? { Authorization: `Bearer ${opts.authToken}` }
          : {}),
      };
    });

    void (async () => {
      try {
        const response = await fetch(streamUrl, {
          method: "POST",
          body: JSON.stringify({ streamId }),
          headers,
          signal: controller.signal,
        });
        // A response that settled just before teardown must not write into
        // the state of the next stream.
        if (controller.signal.aborted) return;

        if (response.status === 205) {
          console.error("Stream already finished", response);
          streamEnded = false;
          return;
        }
        if (!response.ok) {
          console.error("Failed to reach streaming endpoint", response);
          streamEnded = false;
          return;
        }
        if (!response.body) {
          console.error("No body in response", response);
          streamEnded = false;
          return;
        }

        const reader = response.body.getReader();
        // One decoder per stream keeps multi-byte characters intact when they
        // are split across chunks.
        const decoder = new TextDecoder();

        for (;;) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) return;
          const text = decoder.decode(value, { stream: !done });
          if (text) {
            streamBody += text;
          }
          if (done) {
            streamEnded = true;
            return;
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          console.error("Error reading stream", e);
          streamEnded = false;
        }
      }
    })();

    return () => {
      controller.abort();
    };
  });

  const body = $derived.by((): StreamBody => {
    // The effect keeps the last stream's state, so hide it until a new ID.
    if (!streamId) {
      return { text: "", status: "pending" };
    }
    if (persistentBody.data) {
      return persistentBody.data;
    }
    let status: StreamStatus;
    if (streamEnded === null) {
      status = streamBody.length > 0 ? "streaming" : "pending";
    } else {
      status = streamEnded ? "done" : "error";
    }
    return { text: streamBody, status };
  });

  return {
    get text() {
      return body.text;
    },
    get status() {
      return body.status;
    },
  };
}
