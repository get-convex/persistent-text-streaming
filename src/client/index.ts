import type {
  Expand,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { StreamQueryArgs, StreamReadResult } from "@convex-dev/stream";
import { v, type GenericId } from "convex/values";
import { api } from "../component/_generated/api.js";
import type { StreamStatus } from "../component/schema.js";

export type StreamId = string & { __isStreamId: true };
export const StreamIdValidator = v.string();
export type StreamBody = {
  text: string;
  status: StreamStatus;
};

export type ChunkAppender = (text: string) => Promise<void>;
export type StreamWriter<A extends GenericActionCtx<GenericDataModel>> = (
  ctx: A,
  request: Request,
  streamId: StreamId,
  chunkAppender: ChunkAppender,
) => Promise<void>;

const FLUSH_MS = 100;
const MAX_BATCH_BYTES = 16 * 1024;
const MAX_RAW_BUFFER_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function shouldFlush(text: string): boolean {
  return text.includes(".") || text.includes("!") || text.includes("?");
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let index = 0;
  let bytes = 0;

  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (bytes > 0 && bytes + size > MAX_BATCH_BYTES) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += character.length;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

type Sink = {
  write(text: string): void;
  close(): void;
  error(error: unknown): void;
};

class Batch {
  private parts: string[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue = Promise.resolve();
  private ended = false;

  constructor(
    private readonly appendChunk: (
      text: string,
      final: boolean,
    ) => Promise<void>,
    private readonly setStatus: (status: StreamStatus) => Promise<void>,
    private readonly sink: Sink,
  ) {}

  add(text: string): Promise<void> {
    if (this.ended)
      return Promise.reject(new Error("Stream is already finalized."));
    const next = this.queue.then(() => this.accept(text));
    this.queue = next;
    return next;
  }

  finish(): Promise<void> {
    if (this.ended) return this.queue;
    this.ended = true;
    this.stopTimer();
    const next = this.queue.then(async () => {
      this.stopTimer();
      if (this.parts.length === 0) {
        await this.setStatus("done");
      } else {
        await this.flush(true);
      }
    });
    this.queue = next;
    return next;
  }

  fail(): Promise<void> {
    this.ended = true;
    this.stopTimer();
    const prior = this.queue;
    const next = (async () => {
      try {
        await prior;
        this.stopTimer();
        await this.flush(false);
      } finally {
        await this.setStatus("error");
      }
    })();
    this.queue = next;
    return next;
  }

  private async accept(text: string): Promise<void> {
    if (text.length === 0) return;
    const chunks = splitText(text);
    for (const chunk of chunks) this.sink.write(chunk);

    for (const chunk of chunks) {
      const size = encoder.encode(chunk).byteLength;
      if (this.bytes > 0 && this.bytes + size > MAX_BATCH_BYTES) {
        await this.flush(false);
      }
      this.parts.push(chunk);
      this.bytes += size;
      if (this.bytes >= MAX_BATCH_BYTES) await this.flush(false);
    }

    if (shouldFlush(text)) await this.flush(false);
    else this.startTimer();
  }

  private async flush(final: boolean): Promise<void> {
    this.stopTimer();
    if (this.parts.length === 0) {
      if (final) await this.setStatus("done");
      return;
    }
    const text = this.parts.join("");
    this.parts = [];
    this.bytes = 0;
    await this.appendChunk(text, final);
  }

  private startTimer(): void {
    if (this.parts.length === 0 || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.queue.then(() => this.flush(false));
      this.queue = next;
      void next.catch(() => undefined);
    }, FLUSH_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

// TODO -- some sort of wrapper with easy ergonomics for working with LLMs?
export class PersistentTextStreaming {
  constructor(
    public component: UseApi<typeof api>,
    public options?: object,
  ) {}

  /**
   * Create a new stream. This will return a stream ID that can be used
   * in an HTTP action to stream data back out to the client while also
   * permanently persisting the final stream in the database.
   *
   * @param ctx - A convex context capable of running mutations.
   * @returns The ID of the new stream.
   * @example
   * ```ts
   * const streaming = new PersistentTextStreaming(api);
   * const streamId = await streaming.createStream(ctx);
   * await streaming.stream(ctx, request, streamId, async (ctx, req, id, append) => {
   *   await append("Hello ");
   *   await append("World!");
   * });
   * ```
   */

  async createStream(ctx: MutationCtx | ActionCtx): Promise<StreamId> {
    const id = await ctx.runMutation(this.component.lib.createStream);
    return id as StreamId;
  }

  /**
   * Get the body of a stream. This will return the full text of the stream
   * and the status of the stream.
   *
   * @param ctx - A convex context capable of running queries.
   * @param streamId - The ID of the stream to get the body of.
   * @returns The body of the stream and the status of the stream.
   * @example
   * ```ts
   * const streaming = new PersistentTextStreaming(api);
   * const { text, status } = await streaming.getStreamBody(ctx, streamId);
   * ```
   */
  async getStreamBody(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    streamId: StreamId,
  ): Promise<StreamBody> {
    const { text, status } = await ctx.runQuery(
      this.component.lib.getStreamText,
      { streamId },
    );
    return { text, status: status as StreamStatus };
  }

  /**
   * Inside an HTTP action, this will stream data back to the client while
   * also persisting the final stream in the database.
   *
   * @param ctx - A convex context capable of running actions.
   * @param request - The HTTP request object.
   * @param streamId - The ID of the stream.
   * @param streamWriter - A function that generates chunks and writes them
   * to the stream with the given `StreamWriter`.
   * @returns A promise that resolves to an HTTP response. You may need to adjust
   * the headers of this response for CORS, etc.
   * @example
   * ```ts
   * const streaming = new PersistentTextStreaming(api);
   * const streamId = await streaming.createStream(ctx);
   * const response = await streaming.stream(ctx, request, streamId, async (ctx, req, id, append) => {
   *   await append("Hello ");
   *   await append("World!");
   * });
   * ```
   */
  async stream<A extends GenericActionCtx<GenericDataModel>>(
    ctx: A,
    request: Request,
    streamId: StreamId,
    streamWriter: StreamWriter<A>,
  ): Promise<Response> {
    const { claimed } = await ctx.runMutation(this.component.lib.claim, {
      streamId,
    });
    if (!claimed) return new Response(null, { status: 205 });

    let connected = true;
    const readable = new ReadableStream<Uint8Array>(
      {
        start: async (controller) => {
          const sink: Sink = {
            write(text) {
              if (!connected) return;
              const chunk = encoder.encode(text);
              const capacity = controller.desiredSize;
              if (capacity === null || capacity < chunk.byteLength) {
                connected = false;
                try {
                  controller.error(
                    new Error(
                      "Raw stream consumer fell behind durable replay.",
                    ),
                  );
                } catch {
                  // The response consumer has already disconnected.
                }
                return;
              }
              try {
                controller.enqueue(chunk);
                if ((controller.desiredSize ?? 0) <= 0) {
                  connected = false;
                  controller.error(
                    new Error(
                      "Raw stream consumer fell behind durable replay.",
                    ),
                  );
                }
              } catch {
                connected = false;
              }
            },
            close() {
              if (!connected) return;
              connected = false;
              try {
                controller.close();
              } catch {
                // The response consumer has already disconnected.
              }
            },
            error(error) {
              if (!connected) return;
              connected = false;
              try {
                controller.error(error);
              } catch {
                // The response consumer has already disconnected.
              }
            },
          };
          const batch = new Batch(
            (text, final) => this.addChunk(ctx, streamId, text, final),
            (status) => this.setStreamStatus(ctx, streamId, status),
            sink,
          );

          try {
            await streamWriter(ctx, request, streamId, (text) =>
              batch.add(text),
            );
            await batch.finish();
            sink.close();
          } catch (error) {
            let failure = error;
            try {
              await batch.fail();
            } catch (persistenceError) {
              failure = persistenceError;
            }
            sink.error(failure);
          }
        },
        cancel() {
          connected = false;
        },
      },
      {
        highWaterMark: MAX_RAW_BUFFER_BYTES,
        size: (chunk) => chunk.byteLength,
      },
    );

    return new Response(readable, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  }

  /**
   * Read one bounded page of a stream's ordered text events.
   *
   * Expose this from an app-owned query so followers can subscribe over the
   * normal Convex websocket instead of re-reading the whole body on every
   * append. Authorize the caller in that query exactly as you would for
   * `getStreamBody`; this method performs no access control of its own.
   *
   * @param ctx - A convex context capable of running queries.
   * @param streamId - The ID of the stream to read.
   * @param streamArgs - The cursor and page size supplied by `useStream`.
   * @returns One forward-only page plus the stream's lifecycle.
   * @example
   * ```ts
   * export const readStream = query({
   *   args: { streamId: StreamIdValidator, streamArgs: streamQueryArgsValidator },
   *   handler: (ctx, { streamId, streamArgs }) =>
   *     streaming.readStream(ctx, streamId as StreamId, streamArgs),
   * });
   * ```
   */
  async readStream(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    streamId: StreamId,
    streamArgs: StreamQueryArgs,
  ): Promise<StreamReadResult<string, string>> {
    return (await ctx.runQuery(this.component.lib.read, {
      streamId,
      cursor: streamArgs.cursor,
      numItems: streamArgs.numItems,
    })) as StreamReadResult<string, string>;
  }

  /**
   * Delete a stream and all its chunks. Deletion happens asynchronously
   * in batches, so this returns immediately.
   *
   * @param ctx - A convex context capable of running mutations.
   * @param streamId - The ID of the stream to delete.
   */
  async deleteStream(
    ctx: MutationCtx | ActionCtx,
    streamId: StreamId,
  ): Promise<void> {
    await ctx.runMutation(this.component.lib.deleteStream, {
      streamId,
    });
  }

  // Internal helper -- add a chunk to the stream.
  private async addChunk(
    ctx: MutationCtx | ActionCtx,
    streamId: StreamId,
    text: string,
    final: boolean,
  ) {
    await ctx.runMutation(this.component.lib.addChunk, {
      streamId,
      text,
      final,
    });
  }

  // Internal helper -- set the status of a stream.
  private async setStreamStatus(
    ctx: MutationCtx | ActionCtx,
    streamId: StreamId,
    status: StreamStatus,
  ) {
    await ctx.runMutation(this.component.lib.setStreamStatus, {
      streamId,
      status,
    });
  }
}

/* Type utils follow */

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

export type OpaqueIds<T> = T extends GenericId<infer _T> | string
  ? string
  : T extends (infer U)[]
    ? OpaqueIds<U>[]
    : T extends ArrayBuffer
      ? ArrayBuffer
      : T extends object
        ? { [K in keyof T]: OpaqueIds<T[K]> }
        : T;

export type UseApi<API> = Expand<{
  [mod in keyof API]: API[mod] extends FunctionReference<
    infer FType,
    "public",
    infer FArgs,
    infer FReturnType,
    infer FComponentPath
  >
    ? FunctionReference<
        FType,
        "internal",
        OpaqueIds<FArgs>,
        OpaqueIds<FReturnType>,
        FComponentPath
      >
    : UseApi<API[mod]>;
}>;
