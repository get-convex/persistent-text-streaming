"use client";

/// React helpers for persistent text streaming.
import { StreamStatus } from "../component/schema";
import { useQuery } from "convex/react";
import { StreamBody, StreamId } from "../client";
import { useEffect, useMemo, useRef, useState } from "react";
import { FunctionReference } from "convex/server";

if (typeof window === "undefined") {
  throw new Error("this is frontend code, but it's running somewhere else!");
}

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
  streamId?: StreamId
) {
  const [streamEnded, setStreamEnded] = useState(null as boolean | null);
  const streamStarted = useRef(false);

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
  }, [driven, streamId, streamEnded]);
//  console.log("usePersistence", usePersistence);
  const persistentBody = useQuery(
    getPersistentBody,
    usePersistence && streamId ? { streamId: streamId! } : "skip"
  );
  const [streamBody, setStreamBody] = useState<string>("");

  useEffect(() => {
    if (driven && streamId && !streamStarted.current) {
      // Kick off HTTP action.
      void (async () => {
        const success = await startStreaming(streamUrl, streamId, (text) => {
          setStreamBody((prev) => prev + text);
        });
        setStreamEnded(success);
      })();
      return () => {
        streamStarted.current = true;
      };
    }
  }, [driven, streamId, setStreamEnded, streamStarted]);

  const body = useMemo<StreamBody>(() => {
    // console.log(
    //   "body info p vs. s",
    //   persistentBody?.text?.length ?? 0,
    //   streamBody.length
    //);
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
  onUpdate: (text: string) => void
) {
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify({
      streamId: streamId,
    }),
    headers: { "Content-Type": "application/json" },
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
