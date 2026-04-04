import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { streamStatusValidator } from "./schema.js";

// Create a new stream with zero chunks.
export const createStream = mutation({
  args: {},
  handler: async (ctx) => {
    const streamId = await ctx.db.insert("streams", {
      status: "pending",
    });
    return streamId;
  },
});

// Add a chunk to a stream.
// If final is true, set the stream to done.
// Can only be done on streams which are pending or streaming.
export const addChunk = mutation({
  args: {
    streamId: v.id("streams"),
    text: v.string(),
    final: v.boolean(),
  },
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      throw new Error("Stream not found");
    }
    const patch: Record<string, unknown> = {
      lastActivityTime: Date.now(),
    };
    if (stream.status === "pending") {
      patch.status = "streaming";
    } else if (stream.status !== "streaming") {
      throw new Error("Stream is not streaming; did it timeout?");
    }
    if (args.final) {
      patch.status = "done";
    }
    await ctx.db.patch(args.streamId, patch);
    await ctx.db.insert("chunks", {
      streamId: args.streamId,
      text: args.text,
    });
  },
});

// Set the status of a stream.
// Can only be done on streams which are pending or streaming.
export const setStreamStatus = mutation({
  args: {
    streamId: v.id("streams"),
    status: v.union(
      v.literal("pending"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("error"),
      v.literal("timeout"),
    ),
  },
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      throw new Error("Stream not found");
    }
    if (stream.status !== "pending" && stream.status !== "streaming") {
      console.log(
        "Stream is already finalized; ignoring status change",
        stream,
      );
      return;
    }
    await ctx.db.patch(args.streamId, {
      status: args.status,
    });
  },
});

// Get the status of a stream.
export const getStreamStatus = query({
  args: {
    streamId: v.id("streams"),
  },
  returns: streamStatusValidator,
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    return stream?.status ?? "error";
  },
});

// Get the full text of a stream.
// Involves concatenating all the chunks.
export const getStreamText = query({
  args: {
    streamId: v.id("streams"),
  },
  returns: v.object({
    text: v.string(),
    status: streamStatusValidator,
  }),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      throw new Error("Stream not found");
    }
    let text = "";
    if (stream.status !== "pending") {
      const chunks = await ctx.db
        .query("chunks")
        .withIndex("byStream", (q) => q.eq("streamId", args.streamId))
        .collect();
      text = chunks.map((chunk) => chunk.text).join("");
    }
    return {
      text,
      status: stream.status,
    };
  },
});

// Configure stream expiration behavior.
// expirationMs: number of milliseconds of inactivity before a stream is
// timed out. Set to null to disable expiration entirely.
export const configure = mutation({
  args: {
    expirationMs: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("streamConfig").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        expirationMs: args.expirationMs,
      });
    } else {
      await ctx.db.insert("streamConfig", {
        expirationMs: args.expirationMs,
      });
    }
  },
});

const DEFAULT_EXPIRATION_TIME = 20 * 60 * 1000; // 20 minutes in milliseconds
const BATCH_SIZE = 100;

// Clean up streams that have been inactive longer than the configured
// expiration. Uses lastActivityTime (falling back to _creationTime for
// streams created before this field existed). Skipped entirely when
// expiration is configured as null.
export const cleanupExpiredStreams = internalMutation({
  args: {},
  handler: async (ctx) => {
    const config = await ctx.db.query("streamConfig").first();
    const expirationMs = config?.expirationMs;

    if (expirationMs === null) return;

    const effectiveExpiration =
      typeof expirationMs === "number" ? expirationMs : DEFAULT_EXPIRATION_TIME;

    const now = Date.now();
    const pendingStreams = await ctx.db
      .query("streams")
      .withIndex("byStatus", (q) => q.eq("status", "pending"))
      .take(BATCH_SIZE);
    const streamingStreams = await ctx.db
      .query("streams")
      .withIndex("byStatus", (q) => q.eq("status", "streaming"))
      .take(BATCH_SIZE);

    for (const stream of [...pendingStreams, ...streamingStreams]) {
      const lastActive =
        (stream as any).lastActivityTime ?? stream._creationTime;
      if (now - lastActive > effectiveExpiration) {
        console.log("Cleaning up expired stream", stream._id);
        await ctx.db.patch(stream._id, {
          status: "timeout",
        });
      }
    }
  },
});
