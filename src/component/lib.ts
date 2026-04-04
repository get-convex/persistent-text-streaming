import { v } from "convex/values";
import { internal } from "./_generated/api.js";
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
    if (stream.status === "pending") {
      await ctx.db.patch(args.streamId, {
        status: "streaming",
      });
    } else if (stream.status !== "streaming") {
      throw new Error("Stream is not streaming; did it timeout?");
    }
    await ctx.db.insert("chunks", {
      streamId: args.streamId,
      text: args.text,
    });
    if (args.final) {
      await ctx.db.patch(args.streamId, {
        status: "done",
      });
    }
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

const EXPIRATION_TIME = 20 * 60 * 1000; // 20 minutes in milliseconds
const BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 64;

// Delete a stream and all its chunks.
// Kicks off async recursive deletion that processes chunks in batches.
export const deleteStream = mutation({
  args: {
    streamId: v.id("streams"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get(args.streamId);
    if (!stream) {
      return;
    }
    await ctx.scheduler.runAfter(0, internal.lib._deleteStreamPage, {
      streamId: args.streamId,
    });
  },
});

// Internal: delete a page of chunks for a stream, then re-schedule if more remain.
export const _deleteStreamPage = internalMutation({
  args: {
    streamId: v.id("streams"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("chunks")
      .withIndex("byStream", (q) => q.eq("streamId", args.streamId))
      .take(DELETE_BATCH_SIZE);

    await Promise.all(chunks.map((chunk) => ctx.db.delete(chunk._id)));

    if (chunks.length < DELETE_BATCH_SIZE) {
      // All chunks deleted, now delete the stream itself.
      const stream = await ctx.db.get(args.streamId);
      if (stream) {
        await ctx.db.delete(args.streamId);
      }
    } else {
      // More chunks remain, schedule another page.
      await ctx.scheduler.runAfter(0, internal.lib._deleteStreamPage, {
        streamId: args.streamId,
      });
    }
  },
});

// If the last chunk of a stream was added more than 20 minutes ago,
// set the stream to timeout. The action feeding it has to be dead.
export const cleanupExpiredStreams = internalMutation({
  args: {},
  handler: async (ctx) => {
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
      if (now - stream._creationTime > EXPIRATION_TIME) {
        console.log("Cleaning up expired stream", stream._id);
        await ctx.db.patch(stream._id, {
          status: "timeout",
        });
      }
    }
  },
});
