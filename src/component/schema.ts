import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";

import { textStreams } from "./streams.js";

export const streamStatusValidator = v.union(
  v.literal("pending"),
  v.literal("streaming"),
  v.literal("done"),
  v.literal("error"),
  v.literal("timeout"),
);
export type StreamStatus = Infer<typeof streamStatusValidator>;

export default defineSchema({
  streams: defineTable({
    status: streamStatusValidator,
    // Optional producer-election marker. It is separate from lifecycle so a
    // claimed stream remains pending until its first durable append.
    claimedAt: v.optional(v.number()),
    // Absent on legacy rows. New rows retain the public ID while delegating
    // ordered persistence and lifecycle coordination to `textStreams`.
    coreId: v.optional(v.id("textStreams")),
  }).index("byStatus", ["status"]),
  chunks: defineTable({
    streamId: v.id("streams"),
    text: v.string(),
  }).index("byStream", ["streamId"]),
  ...textStreams.tables(),
});
