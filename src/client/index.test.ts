import type { StreamReadResult } from "@convex-dev/stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PersistentTextStreaming,
  type StreamId,
  type StreamWriter,
} from "./index.js";

const streamId = "stream" as StreamId;

type Call =
  | { kind: "claim" }
  | { kind: "append"; text: string; final: boolean }
  | { kind: "status"; status: string }
  | { kind: "read"; cursor: string | null; numItems: number };

function setup(claims: boolean[] = [true]) {
  const refs = {
    lib: {
      addChunk: {},
      claim: {},
      createStream: {},
      deleteStream: {},
      getStreamStatus: {},
      getStreamText: {},
      read: {},
      setStreamStatus: {},
    },
  };
  const calls: Call[] = [];
  const terminal: StreamReadResult<string, string> = {
    streamId: "core" as never,
    attempt: 0,
    startIndex: 0,
    nextIndex: 0,
    page: [],
    continueCursor: "done",
    caughtUp: true,
    status: "done",
  };
  const ctx = {
    runMutation: vi.fn(async (ref: object, args: Record<string, unknown>) => {
      if (ref === refs.lib.claim) {
        calls.push({ kind: "claim" });
        return { claimed: claims.shift() ?? false };
      }
      if (ref === refs.lib.addChunk) {
        calls.push({
          kind: "append",
          text: args.text as string,
          final: args.final as boolean,
        });
        return null;
      }
      if (ref === refs.lib.setStreamStatus) {
        calls.push({ kind: "status", status: args.status as string });
        return null;
      }
      throw new Error("Unexpected mutation.");
    }),
    runQuery: vi.fn(async (ref: object, args: Record<string, unknown>) => {
      if (ref !== refs.lib.read) throw new Error("Unexpected query.");
      calls.push({
        kind: "read",
        cursor: args.cursor as string | null,
        numItems: args.numItems as number,
      });
      return terminal;
    }),
  };
  return {
    calls,
    ctx,
    streaming: new PersistentTextStreaming(refs as never),
  };
}

function request(): Request {
  const url = new URL("https://example.com/stream");
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ streamId }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PersistentTextStreaming transport", () => {
  it("invokes only the winning writer", async () => {
    const { calls, ctx, streaming } = setup([true, false]);
    const writer = vi.fn<StreamWriter<never>>(
      async (_ctx, _request, _id, append) => {
        await append("winner");
      },
    );

    const winner = await streaming.stream(
      ctx as never,
      request(),
      streamId,
      writer,
    );
    const loser = await streaming.stream(
      ctx as never,
      request(),
      streamId,
      writer,
    );

    expect(loser.status).toBe(205);
    expect(await winner.text()).toBe("winner");
    expect(writer).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.kind === "claim")).toHaveLength(2);
    expect(calls).toContainEqual({
      kind: "append",
      text: "winner",
      final: true,
    });
  });

  it("reads one bounded page through an app-owned query", async () => {
    const { calls, ctx, streaming } = setup();

    const page = await streaming.readStream(ctx as never, streamId, {
      cursor: null,
      numItems: 16,
    });

    expect(page.status).toBe("done");
    expect(calls).toEqual([{ kind: "read", cursor: null, numItems: 16 }]);
  });

  it("flushes on cadence and completes durably before closing", async () => {
    vi.useFakeTimers();
    const { calls, ctx, streaming } = setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer: StreamWriter<never> = async (_ctx, _request, _id, append) => {
      await append("timed");
      await gate;
    };

    const response = await streaming.stream(
      ctx as never,
      request(),
      streamId,
      writer,
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(calls.some((call) => call.kind === "append")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toContainEqual({
      kind: "append",
      text: "timed",
      final: false,
    });

    release?.();
    expect(await response.text()).toBe("timed");
    expect(calls.at(-1)).toEqual({ kind: "status", status: "done" });
  });

  it("splits oversized input and serializes concurrent appends", async () => {
    const { calls, ctx, streaming } = setup();
    const first = "a".repeat(12 * 1024);
    const second = "🙂".repeat(2 * 1024);
    const writer: StreamWriter<never> = async (_ctx, _request, _id, append) => {
      await Promise.all([append(first), append(second)]);
    };

    const response = await streaming.stream(
      ctx as never,
      request(),
      streamId,
      writer,
    );
    expect(await response.text()).toBe(first + second);

    const appends = calls.filter(
      (call): call is Extract<Call, { kind: "append" }> =>
        call.kind === "append",
    );
    expect(appends.map((call) => call.text).join("")).toBe(first + second);
    expect(
      appends.every(
        (call) => new TextEncoder().encode(call.text).byteLength <= 16 * 1024,
      ),
    ).toBe(true);
    expect(appends.at(-1)?.final).toBe(true);
  });

  it("flushes pending text before recording producer failure", async () => {
    const { calls, ctx, streaming } = setup();
    const failure = new Error("producer failed");
    const writer: StreamWriter<never> = async (_ctx, _request, _id, append) => {
      await append("durable prefix");
      throw failure;
    };

    const response = await streaming.stream(
      ctx as never,
      request(),
      streamId,
      writer,
    );
    await expect(response.text()).rejects.toThrow("producer failed");
    expect(calls.slice(-2)).toEqual([
      { kind: "append", text: "durable prefix", final: false },
      { kind: "status", status: "error" },
    ]);
  });

  it("bounds an unread raw response without stopping durable completion", async () => {
    const { calls, ctx, streaming } = setup();
    let durableDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      durableDone = resolve;
    });
    ctx.runMutation.mockImplementation(
      async (ref: object, args: Record<string, unknown>) => {
        if (
          ref ===
          (streaming.component as never as { lib: { claim: object } }).lib.claim
        ) {
          calls.push({ kind: "claim" });
          return { claimed: true };
        }
        if ("text" in args) {
          calls.push({
            kind: "append",
            text: args.text as string,
            final: args.final as boolean,
          });
          return null;
        }
        calls.push({ kind: "status", status: args.status as string });
        if (args.status === "done") durableDone?.();
        return null;
      },
    );
    const text = "🙂".repeat(20 * 1024);
    const writer: StreamWriter<never> = async (_ctx, _request, _id, append) => {
      await append(text);
    };

    const response = await streaming.stream(
      ctx as never,
      request(),
      streamId,
      writer,
    );

    // Deliberately leave the raw body unread until durable persistence finishes.
    await done;
    const appends = calls.filter(
      (call): call is Extract<Call, { kind: "append" }> =>
        call.kind === "append",
    );
    expect(appends.map((call) => call.text).join("")).toBe(text);
    expect(
      appends.every(
        (call) => new TextEncoder().encode(call.text).byteLength <= 16 * 1024,
      ),
    ).toBe(true);
    expect(calls.at(-1)).toEqual({ kind: "status", status: "done" });
    await expect(response.text()).rejects.toThrow(
      "Raw stream consumer fell behind durable replay.",
    );
  });

  it("continues persistence after the raw consumer disconnects", async () => {
    const { calls, ctx, streaming } = setup();
    let release: (() => void) | undefined;
    let persisted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    ctx.runMutation.mockImplementation(
      async (ref: object, args: Record<string, unknown>) => {
        if (
          ref ===
          (streaming.component as never as { lib: { claim: object } }).lib.claim
        ) {
          calls.push({ kind: "claim" });
          return { claimed: true };
        }
        if ("text" in args) {
          calls.push({
            kind: "append",
            text: args.text as string,
            final: args.final as boolean,
          });
          if (args.final === true) persisted?.();
          return null;
        }
        calls.push({ kind: "status", status: args.status as string });
        return null;
      },
    );
    const writer: StreamWriter<never> = async (_ctx, _request, _id, append) => {
      await append("first.");
      await gate;
      await append("second");
    };

    const response = await streaming.stream(
      ctx as never,
      request(),
      streamId,
      writer,
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    release?.();
    await done;

    expect(calls.filter((call) => call.kind === "append")).toEqual([
      { kind: "append", text: "first.", final: false },
      { kind: "append", text: "second", final: true },
    ]);
  });
});
