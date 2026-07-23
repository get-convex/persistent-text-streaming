import {
  streamReadResultValidator,
  type StreamReadResult,
} from "@convex-dev/stream";
import { paginator } from "convex-helpers/server/pagination";
import {
  ConvexError,
  convexToJson,
  jsonToConvex,
  v,
  type GenericId,
} from "convex/values";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import schema, { streamStatusValidator, type StreamStatus } from "./schema.js";
import { textStreams } from "./streams.js";

const EXPIRATION_TIME = 20 * 60 * 1000;
const BATCH_SIZE = 100;
const DELETE_BATCH_SIZE = 64;
const MAX_READ_ITEMS = 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_SEGMENT_JSON_BYTES = 256 * 1024;
const LEGACY_CURSOR_PREFIX = "p1:";
const encoder = new TextEncoder();

type ReadCtx = QueryCtx | MutationCtx;

type TextReadResult = StreamReadResult<string, string>;
type LegacyCursor = {
  streamId: Id<"streams">;
  nextIndex: number;
  lastIndexKey: string | null;
  offset: number;
};
type TextReadBase = {
  streamId: GenericId<string>;
  attempt: number;
  startIndex: number;
  nextIndex: number;
  page: Array<{ attempt: number; seq: number; event: string }>;
  continueCursor: string;
  caughtUp: boolean;
};

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function readCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_READ_ITEMS) {
    fail(
      "limitExceeded",
      `numItems must be an integer from 1 through ${MAX_READ_ITEMS}.`,
    );
  }
  return value;
}

function encodeLegacyCursor(cursor: LegacyCursor): string {
  return `${LEGACY_CURSOR_PREFIX}${encodeURIComponent(
    JSON.stringify(convexToJson(cursor)),
  )}`;
}

function validLegacyIndexKey(cursor: string, streamId: Id<"streams">): boolean {
  try {
    const key = jsonToConvex(JSON.parse(cursor));
    return (
      Array.isArray(key) &&
      key.length === 3 &&
      key[0] === streamId &&
      typeof key[1] === "number" &&
      Number.isFinite(key[1]) &&
      typeof key[2] === "string"
    );
  } catch {
    return false;
  }
}

function decodeLegacyCursor(
  cursor: string | null,
  streamId: Id<"streams">,
): LegacyCursor {
  if (cursor === null) {
    return { streamId, nextIndex: 0, lastIndexKey: null, offset: 0 };
  }
  if (!cursor.startsWith(LEGACY_CURSOR_PREFIX)) {
    fail("invalidCursor", "Malformed stream cursor.");
  }

  try {
    const decoded = jsonToConvex(
      JSON.parse(decodeURIComponent(cursor.slice(LEGACY_CURSOR_PREFIX.length))),
    );
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      Object.keys(decoded).length !== 4 ||
      !("streamId" in decoded) ||
      !("nextIndex" in decoded) ||
      !("lastIndexKey" in decoded) ||
      !("offset" in decoded) ||
      decoded.streamId !== streamId ||
      !Number.isSafeInteger(decoded.nextIndex) ||
      (decoded.nextIndex as number) < 0 ||
      !Number.isSafeInteger(decoded.offset) ||
      (decoded.offset as number) < 0 ||
      (decoded.lastIndexKey !== null &&
        (typeof decoded.lastIndexKey !== "string" ||
          !validLegacyIndexKey(decoded.lastIndexKey, streamId)))
    ) {
      fail("invalidCursor", "Malformed stream cursor.");
    }
    return decoded as LegacyCursor;
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    fail("invalidCursor", "Malformed stream cursor.");
  }
}

function legacyIndexKey(streamId: Id<"streams">, chunk: Doc<"chunks">): string {
  return JSON.stringify(
    convexToJson([streamId, chunk._creationTime, chunk._id]),
  );
}

function isCodePointBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function floorCodePointBoundary(text: string, offset: number): number {
  return isCodePointBoundary(text, offset) ? offset : offset - 1;
}

function nextCodePointBoundary(text: string, offset: number): number {
  const first = text.charCodeAt(offset);
  return first >= 0xd800 &&
    first <= 0xdbff &&
    offset + 1 < text.length &&
    text.charCodeAt(offset + 1) >= 0xdc00 &&
    text.charCodeAt(offset + 1) <= 0xdfff
    ? offset + 2
    : offset + 1;
}

function serializedStringBytes(value: string): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function legacySegment(
  text: string,
  offset: number,
): { event: string; nextOffset: number } {
  if (offset > text.length || !isCodePointBoundary(text, offset)) {
    fail("invalidCursor", "Malformed stream cursor.");
  }
  if (offset === text.length) return { event: "", nextOffset: offset };

  let low = offset;
  let high = text.length;
  let best = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = floorCodePointBoundary(text, middle);
    if (end <= offset) {
      low = middle + 1;
      continue;
    }
    if (
      serializedStringBytes(text.slice(offset, end)) <=
      MAX_LEGACY_SEGMENT_JSON_BYTES
    ) {
      best = end;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (best === offset) best = nextCodePointBoundary(text, offset);
  return { event: text.slice(offset, best), nextOffset: best };
}

function withLifecycle(
  base: TextReadBase,
  stream: Doc<"streams">,
): TextReadResult {
  if (stream.status === "error" || stream.status === "timeout") {
    return {
      ...base,
      status: "failed",
      error: {
        code: stream.status,
        message:
          stream.status === "timeout"
            ? "Stream generation timed out."
            : "Stream generation failed.",
      },
    };
  }
  return { ...base, status: stream.status };
}

async function readLegacy(
  ctx: QueryCtx,
  stream: Doc<"streams">,
  cursor: string | null,
): Promise<TextReadResult> {
  const decoded = decodeLegacyCursor(cursor, stream._id);
  const result = await paginator(ctx.db, schema)
    .query("chunks")
    .withIndex("byStream", (q) => q.eq("streamId", stream._id))
    .paginate({
      cursor: decoded.lastIndexKey,
      // Legacy chunks do not carry Stream-native sequence cursors. Returning
      // one conservatively sized virtual event keeps every SSE frame
      // indivisible, so serveHttpStream never synthesizes an incompatible s1
      // cursor for this adapter.
      numItems: 1,
      maximumRowsRead: 1,
      maximumBytesRead: MAX_READ_BYTES,
    });

  const chunk = result.page.at(0);
  if (chunk === undefined && decoded.offset !== 0) {
    fail("invalidCursor", "Malformed stream cursor.");
  }
  const segment = chunk ? legacySegment(chunk.text, decoded.offset) : null;
  const fullyConsumed =
    chunk !== undefined && segment?.nextOffset === chunk.text.length;
  const nextIndex = decoded.nextIndex + (segment === null ? 0 : 1);
  const lastIndexKey = fullyConsumed
    ? legacyIndexKey(stream._id, chunk)
    : decoded.lastIndexKey;
  const offset = fullyConsumed ? 0 : (segment?.nextOffset ?? decoded.offset);

  return withLifecycle(
    {
      streamId: stream._id,
      attempt: 0,
      startIndex: decoded.nextIndex,
      nextIndex,
      page: segment
        ? [{ attempt: 0, seq: decoded.nextIndex, event: segment.event }]
        : [],
      continueCursor: encodeLegacyCursor({
        streamId: stream._id,
        nextIndex,
        lastIndexKey,
        offset,
      }),
      caughtUp:
        segment === null ? result.isDone : fullyConsumed && result.isDone,
    },
    stream,
  );
}

async function requireStream(
  ctx: ReadCtx,
  streamId: Id<"streams">,
): Promise<Doc<"streams">> {
  const stream = await ctx.db.get("streams", streamId);
  if (stream === null) fail("streamNotFound", "Stream not found.");
  return stream;
}

function publicStatus(
  core: NonNullable<Awaited<ReturnType<typeof textStreams.get>>>,
): StreamStatus {
  if (core.status === "failed") {
    return core.error.code === "timeout" ? "timeout" : "error";
  }
  if (core.status === "canceled" || core.status === "deleting") return "error";
  return core.status;
}

async function legacyText(
  ctx: QueryCtx,
  streamId: Id<"streams">,
): Promise<string> {
  const chunks = await ctx.db
    .query("chunks")
    .withIndex("byStream", (q) => q.eq("streamId", streamId))
    .collect();
  return chunks.map((chunk) => chunk.text).join("");
}

async function currentText(ctx: QueryCtx, coreId: Id<"textStreams">) {
  const core = await textStreams.get(ctx, { streamId: coreId });
  if (core === null || core.status === "deleting") {
    fail("streamNotFound", "Stream not found.");
  }

  const events = await ctx.db
    .query("textStreamsEvents")
    .withIndex("by_streamId_and_attempt_and_seq", (q) =>
      q.eq("streamId", coreId).eq("attempt", core.attempt),
    )
    .collect();

  return {
    text: events.map((event) => event.event).join(""),
    status: publicStatus(core),
  };
}

// Create the Stream-backed core and stable public handle atomically. Existing
// applications continue storing an Id<"streams"> regardless of the engine.
export const createStream = mutation({
  args: {},
  returns: v.id("streams"),
  handler: async (ctx) => {
    const core = await textStreams.create(ctx);
    return ctx.db.insert("streams", {
      status: "pending",
      coreId: core.streamId,
    });
  },
});

// Atomically elect exactly one producer without changing the stable stream ID.
// Followers only call `read`; they never claim production as a side effect.
export const claim = mutation({
  args: { streamId: v.id("streams") },
  returns: v.object({ claimed: v.boolean() }),
  handler: async (ctx, args) => {
    const stream = await requireStream(ctx, args.streamId);
    if (stream.status !== "pending" || stream.claimedAt !== undefined) {
      return { claimed: false };
    }

    if (stream.coreId !== undefined) {
      const core = await textStreams.get(ctx, { streamId: stream.coreId });
      if (core === null || core.status === "deleting") {
        fail("streamNotFound", "Stream not found.");
      }
      if (core.status !== "pending") return { claimed: false };
    }

    await ctx.db.patch("streams", args.streamId, { claimedAt: Date.now() });
    return { claimed: true };
  },
});

// Canonical bounded follower read. Current rows delegate ordering and cursor
// validation to Stream; legacy chunks use a facade-ID-bound compatibility
// cursor and expose the same append-only envelope.
export const read = query({
  args: {
    streamId: v.id("streams"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: streamReadResultValidator(v.string()),
  handler: async (ctx, args): Promise<TextReadResult> => {
    const stream = await requireStream(ctx, args.streamId);
    const numItems = readCount(args.numItems);

    if (stream.coreId === undefined) {
      return readLegacy(ctx, stream, args.cursor);
    }

    // Stream is the lifecycle authority for current rows. The facade status is
    // only a compatibility/discovery mirror; notably, claim may mark it
    // streaming before the first durable append moves the core from pending.
    return textStreams.read(ctx, {
      streamId: stream.coreId,
      cursor: args.cursor,
      numItems,
    });
  },
});

// Add a persisted text chunk. Rows created before the Stream-backed engine keep
// their original behavior; every newly created row appends through Stream.
export const addChunk = mutation({
  args: {
    streamId: v.id("streams"),
    text: v.string(),
    final: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await requireStream(ctx, args.streamId);

    if (stream.coreId !== undefined) {
      const result = await textStreams.append(ctx, {
        streamId: stream.coreId,
        event: args.text,
        ...(args.final ? { complete: true as const } : {}),
      });
      if (stream.status !== result.status) {
        await ctx.db.patch("streams", args.streamId, { status: result.status });
      }
      return null;
    }

    if (stream.status === "pending") {
      await ctx.db.patch("streams", args.streamId, { status: "streaming" });
    } else if (stream.status !== "streaming") {
      throw new Error("Stream is not streaming; did it timeout?");
    }
    await ctx.db.insert("chunks", {
      streamId: args.streamId,
      text: args.text,
    });
    if (args.final) {
      await ctx.db.patch("streams", args.streamId, { status: "done" });
    }
    return null;
  },
});

// Set a terminal stream status. The client wrapper uses this to record producer
// errors, while the timeout job uses the same path for Stream-backed rows.
export const setStreamStatus = mutation({
  args: {
    streamId: v.id("streams"),
    status: streamStatusValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await requireStream(ctx, args.streamId);
    if (stream.status !== "pending" && stream.status !== "streaming") {
      console.log(
        "Stream is already finalized; ignoring status change",
        stream,
      );
      return null;
    }

    if (stream.coreId !== undefined) {
      if (args.status === "done") {
        await textStreams.complete(ctx, { streamId: stream.coreId });
      } else if (args.status === "error" || args.status === "timeout") {
        await textStreams.fail(ctx, {
          streamId: stream.coreId,
          error: {
            code: args.status,
            message:
              args.status === "timeout"
                ? "Stream generation timed out."
                : "Stream generation failed.",
          },
        });
      } else {
        const core = await textStreams.get(ctx, { streamId: stream.coreId });
        if (core === null || core.status !== args.status) {
          throw new Error(
            `Cannot set a Stream-backed stream to ${args.status}.`,
          );
        }
      }
    }

    await ctx.db.patch("streams", args.streamId, { status: args.status });
    return null;
  },
});

export const getStreamStatus = query({
  args: { streamId: v.id("streams") },
  returns: streamStatusValidator,
  handler: async (ctx, args) => {
    const stream = await ctx.db.get("streams", args.streamId);
    return stream?.status ?? "error";
  },
});

// Preserve the existing full-body API. Legacy rows join `chunks`; current rows
// join the active attempt's ordered Stream events.
export const getStreamText = query({
  args: { streamId: v.id("streams") },
  returns: v.object({
    text: v.string(),
    status: streamStatusValidator,
  }),
  handler: async (ctx, args) => {
    const stream = await requireStream(ctx, args.streamId);
    if (stream.coreId !== undefined) return currentText(ctx, stream.coreId);
    return {
      text:
        stream.status === "pending" ? "" : await legacyText(ctx, args.streamId),
      status: stream.status,
    };
  },
});

// Delete the stable handle immediately, matching the legacy contract. Stream
// drains its event rows in bounded, self-scheduling transactions.
export const deleteStream = mutation({
  args: { streamId: v.id("streams") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await requireStream(ctx, args.streamId);
    if (stream.coreId !== undefined) {
      await textStreams.delete(
        ctx,
        { streamId: stream.coreId },
        { run: internal.lib.run },
      );
    } else {
      await ctx.scheduler.runAfter(0, internal.lib._deleteChunksPage, {
        streamId: args.streamId,
        cursor: null,
      });
    }
    await ctx.db.delete("streams", args.streamId);
    return null;
  },
});

// Legacy deletion continuation. New streams use the Stream runner below.
export const _deleteChunksPage = internalMutation({
  args: {
    streamId: v.id("streams"),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await paginator(ctx.db, schema)
      .query("chunks")
      .withIndex("byStream", (q) => q.eq("streamId", args.streamId))
      .paginate({ cursor: args.cursor, numItems: DELETE_BATCH_SIZE });

    await Promise.all(
      result.page.map((chunk) => ctx.db.delete("chunks", chunk._id)),
    );

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.lib._deleteChunksPage, {
        streamId: args.streamId,
        cursor: result.continueCursor,
      });
    }
    return null;
  },
});

// Self-scheduling maintenance boundary for Stream-backed deletion.
export const run = internalMutation({
  args: textStreams.args.run,
  returns: textStreams.returns.run,
  handler: async (ctx, args): Promise<{ isDone: boolean }> =>
    textStreams.run(ctx, args, { run: internal.lib.run }),
});

// Preserve the existing 20-minute timeout behavior for both engines. Timeout
// retains text; it is a failed lifecycle, not Stream expiration/deletion.
export const cleanupExpiredStreams = internalMutation({
  args: {},
  returns: v.null(),
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
      if (now - stream._creationTime <= EXPIRATION_TIME) continue;
      console.log("Timing out expired stream", stream._id);
      if (stream.coreId !== undefined) {
        await textStreams.fail(ctx, {
          streamId: stream.coreId,
          error: { code: "timeout", message: "Stream generation timed out." },
        });
      }
      await ctx.db.patch("streams", stream._id, { status: "timeout" });
    }
    return null;
  },
});
