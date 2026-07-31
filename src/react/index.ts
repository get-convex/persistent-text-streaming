"use client";

/// React helpers for persistent text streaming.
import type { StreamQueryArgs, StreamReadResult } from "@convex-dev/stream";
import { useStream as useStreamQuery } from "@convex-dev/stream/react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect, useMemo, useRef, useState } from "react";

import type { StreamBody, StreamId } from "../client/index.js";
import { publicStatus } from "./status.js";
import { startTextTransport } from "./transport.js";

const EMPTY_BODY: StreamBody = { text: "", status: "pending" };
// Page size for one durable read. Each page is a bounded delta, never the
// whole body, so this caps the work of a single query execution.
const READ_ITEMS = 16;

/**
 * An app-owned query that exposes `PersistentTextStreaming.readStream`.
 */
export type StreamTextQuery = FunctionReference<
  "query",
  "public",
  { streamId: string; streamArgs: StreamQueryArgs },
  StreamReadResult<string, string>
>;

function stableHeaders(
  authToken: string | null | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const value = new Headers(headers);
  if (authToken) value.set("Authorization", `Bearer ${authToken}`);
  return Object.fromEntries(value.entries());
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
  streamId: StreamId | undefined,
  opts?: {
    // If provided, this will be passed as the Authorization header.
    authToken?: string | null;
    // If provided, these will be passed as additional headers.
    headers?: Record<string, string>;
    // An app-owned query exposing `readStream`. When provided, followers and
    // recovery read bounded append-only pages over the normal Convex
    // subscription instead of re-reading the full body on every append.
    readStream?: StreamTextQuery;
  },
) {
  const url = streamUrl.toString();
  const transportKey = JSON.stringify({
    driven,
    streamId: streamId ?? null,
    url,
  });

  // Headers ride along with each request rather than keying the transport. An
  // auth token that rotates mid-stream must not tear down a live connection or
  // blank the text the reader is watching.
  const headersKey = JSON.stringify(
    stableHeaders(opts?.authToken, opts?.headers),
  );
  const headers = useMemo(
    () => JSON.parse(headersKey) as Record<string, string>,
    [headersKey],
  );
  const headersRef = useRef<Record<string, string>>({});
  useEffect(() => {
    headersRef.current = headers;
  }, [headers]);

  const [view, setView] = useState<{ body: StreamBody; key: string }>(() => ({
    body: EMPTY_BODY,
    key: transportKey,
  }));
  const [durableKey, setDurableKey] = useState<string | null>(null);
  const generationRef = useRef(0);

  // A passive client never drives, so it reads durably from the first render.
  const readDurably = !driven || durableKey === transportKey;
  const readStream = opts?.readStream;
  const canRead = readDurably && streamId !== undefined;

  // Rules of hooks require an unconditional call. When the app has not adopted
  // `readStream` the args are always "skip", so the placeholder is never run.
  const snapshot = useStreamQuery(
    (readStream ?? getPersistentBody) as unknown as StreamTextQuery,
    canRead && readStream !== undefined ? { streamId } : "skip",
    { numItems: READ_ITEMS, maxEvents: null, maxBytes: null },
  );

  // Compatibility path for apps that have not exposed `readStream`, and the
  // last resort when the durable read itself cannot resolve.
  const persistentBody = useQuery(
    getPersistentBody,
    canRead && readStream === undefined ? { streamId } : "skip",
  );

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!driven || !streamId) return;

    const isCurrent = () => generationRef.current === generation;
    const transport = startTextTransport(
      { headers: headersRef.current, streamId, url },
      {
        publish(body) {
          if (isCurrent()) setView({ body, key: transportKey });
        },
        handoff() {
          if (isCurrent()) setDurableKey(transportKey);
        },
        report(error) {
          if (isCurrent())
            console.error("Persistent text stream transport failed", error);
        },
      },
    );

    return () => {
      generationRef.current += 1;
      transport.close();
    };
  }, [driven, streamId, transportKey, url]);

  const durableText = useMemo(
    () => snapshot.events.map((event) => event.event).join(""),
    [snapshot.events],
  );

  return useMemo<StreamBody>(() => {
    const raw = view.key === transportKey ? view.body : EMPTY_BODY;
    if (!canRead) return raw;
    if (readStream === undefined) return persistentBody ?? raw;
    if (snapshot.status === null) return raw;

    // Durable replay restarts at zero and the raw text is a prefix of it, so
    // hold the raw prefix until the replay has caught up rather than rewinding
    // the reader to an empty message.
    const status = publicStatus(snapshot.status, snapshot.error);
    if (!snapshot.isDone && durableText.length < raw.text.length) return raw;
    return { text: durableText, status };
  }, [
    canRead,
    durableText,
    persistentBody,
    readStream,
    snapshot.error,
    snapshot.isDone,
    snapshot.status,
    transportKey,
    view,
  ]);
}
