import { defineStream, type StreamHandle } from "@convex-dev/stream/server";
import { v } from "convex/values";

// New streams use the shared durable stream engine. The existing `streams`
// table remains the stable public handle, and its optional `coreId` points at
// one of these coordination rows.
const textEvent = v.string();

export const textStreams: StreamHandle<
  "textStreams",
  typeof textEvent,
  Record<never, never>
> = defineStream("textStreams", {
  event: textEvent,
  eventFields: {},
});
