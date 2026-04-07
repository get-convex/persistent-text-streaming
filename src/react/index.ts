"use client";

/// React helpers for persistent text streaming.
import type { StreamStatus } from "../component/schema.js";
import { useQuery } from "convex/react";
import type { StreamBody, StreamId } from "../client/index.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FunctionReference } from "convex/server";

/**
 * React hook for persistent text streaming.
 *
 * @param getPersistentBody - A query function reference that returns the body
 * of a stream using the component's `getStreamBody` method.
 * @param streamUrl - The URL of the http action that will kick off the stream
 * generation and stream the result back to the client using the component's
 * `stream` method.
 * @param driven - Whether this particular session is driving the stream. Set this
 * to true if this is the client session that first created the stream using the
 * component's `createStream` method. If you're simply reloading an existing
 * stream, set this to false.
 * @param streamId - The ID of the stream. If this is not provided, the return
 * value will be an empty string for the stream body and the status will be
 * `pending`.
 * @returns The body and status of the stream.
 */
export function useStream(
  getPersistentBody: FunctionReference<
    "query",
    "public",
    { streamId: string },
    StreamBody
  >,
  streamUrl: URL,
  driven: boolean,
  streamId: StreamId | undefined,
  opts?: {
    // If provided, this will be passed as the Authorization header.
    authToken?: string | null;
    // If provided, these will be passed as additional headers.
    headers?: Record<string, string>;
  },
) {
  const [streamBody, setStreamBody] = useState<string>("");
  const [streamEnded, setStreamEnded] = useState<boolean | null>(null);

  // Track the active streamId to handle multiple streams and serve as a
  // Strict Mode guard (prevents double-firing when the same streamId is seen).
  const activeStreamRef = useRef<StreamId | undefined>(undefined);

  const usePersistence = useMemo(() => {
    // Something is wrong with the stream, so we need to use the database value.
    if (streamEnded === false) {
      return true;
    }
    // If we're not driving the stream, we must use the database value.
    if (!driven) {
      return true;
    }
    // Otherwise, we'll try to drive the stream and use the HTTP response.
    return false;
  }, [driven, streamEnded]);

  const persistentBody = useQuery(
    getPersistentBody,
    usePersistence && streamId ? { streamId } : "skip",
  );

  useEffect(() => {
    if (!driven || !streamId) {
      return;
    }

    // Strict Mode guard: don't restart streaming for the same streamId
    if (streamId === activeStreamRef.current) {
      return;
    }

    // New stream: reset state and track the new streamId
    activeStreamRef.current = streamId;
    setStreamBody("");
    setStreamEnded(null);

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(streamUrl, {
          method: "POST",
          body: JSON.stringify({ streamId }),
          headers: {
            "Content-Type": "application/json",
            ...opts?.headers,
            ...(opts?.authToken
              ? { Authorization: `Bearer ${opts.authToken}` }
              : {}),
          },
          signal: controller.signal,
        });

        if (response.status === 205) {
          console.error("Stream already finished", response);
          setStreamEnded(false);
          return;
        }
        if (!response.ok) {
          console.error("Failed to reach streaming endpoint", response);
          setStreamEnded(false);
          return;
        }
        if (!response.body) {
          console.error("No body in response", response);
          setStreamEnded(false);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        for (;;) {
          const { done, value } = await reader.read();
          const text = decoder.decode(value, { stream: !done });
          if (text) {
            setStreamBody((prev) => prev + text);
          }
          if (done) {
            setStreamEnded(true);
            return;
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          console.error("Error reading stream", e);
          setStreamEnded(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [driven, streamId, streamUrl, opts?.authToken, opts?.headers]);

  const body = useMemo<StreamBody>(() => {
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
  }, [persistentBody, streamBody, streamEnded]);

  return body;
}

