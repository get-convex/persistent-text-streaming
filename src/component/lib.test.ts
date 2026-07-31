/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamReadResult } from "@convex-dev/stream";

import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => vi.useRealTimers());

describe("persistent text streaming engines", () => {
  it("claims one producer atomically while passive reads remain side-effect free", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.mutation(api.lib.createStream, {});
    const coreId = await t.run(async (ctx) => {
      const stream = await ctx.db.get("streams", streamId);
      if (stream?.coreId === undefined) throw new Error("Missing Stream core.");
      return stream.coreId;
    });

    const passive = await t.query(api.lib.read, {
      streamId,
      cursor: null,
      numItems: 16,
    });
    expect(passive).toMatchObject({
      streamId: coreId,
      status: "pending",
      page: [],
      caughtUp: true,
    });
    await expect(t.query(api.lib.getStreamStatus, { streamId })).resolves.toBe(
      "pending",
    );

    const claims = await Promise.all([
      t.mutation(api.lib.claim, { streamId }),
      t.mutation(api.lib.claim, { streamId }),
    ]);
    expect(claims).toEqual(
      expect.arrayContaining([{ claimed: true }, { claimed: false }]),
    );
    expect(claims.filter(({ claimed }) => claimed)).toHaveLength(1);
    const claimedFacade = await t.run((ctx) => ctx.db.get("streams", streamId));
    expect(claimedFacade).toMatchObject({ status: "pending" });
    expect(claimedFacade?.claimedAt).toEqual(expect.any(Number));

    const claimed = await t.query(api.lib.read, {
      streamId,
      cursor: passive.continueCursor,
      numItems: 16,
    });
    expect(claimed).toMatchObject({ status: "pending", page: [] });

    await t.mutation(api.lib.addChunk, {
      streamId,
      text: "durable",
      final: false,
    });
    const appended = await t.query(api.lib.read, {
      streamId,
      cursor: claimed.continueCursor,
      numItems: 16,
    });
    expect(appended).toMatchObject({
      status: "streaming",
      page: [{ attempt: 0, seq: 0, event: "durable" }],
    });
  });

  it("claims legacy streams with the same one-winner semantics", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.run((ctx) =>
      ctx.db.insert("streams", { status: "pending" }),
    );

    await expect(t.mutation(api.lib.claim, { streamId })).resolves.toEqual({
      claimed: true,
    });
    await expect(t.mutation(api.lib.claim, { streamId })).resolves.toEqual({
      claimed: false,
    });
    await expect(t.query(api.lib.getStreamStatus, { streamId })).resolves.toBe(
      "pending",
    );
    const claimed = await t.run((ctx) => ctx.db.get("streams", streamId));
    expect(claimed?.claimedAt).toEqual(expect.any(Number));
  });

  it("creates a stable public handle backed by an ordered Stream core", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.mutation(api.lib.createStream, {});

    const created = await t.run((ctx) => ctx.db.get("streams", streamId));
    expect(created).toMatchObject({ status: "pending" });
    expect(created?.coreId).toBeDefined();

    await t.mutation(api.lib.addChunk, {
      streamId,
      text: "Hello ",
      final: false,
    });
    await t.mutation(api.lib.addChunk, {
      streamId,
      text: "world!",
      final: true,
    });

    await expect(t.query(api.lib.getStreamText, { streamId })).resolves.toEqual(
      {
        text: "Hello world!",
        status: "done",
      },
    );

    const rows = await t.run(async (ctx) => ({
      facade: await ctx.db.get("streams", streamId),
      events: await ctx.db.query("textStreamsEvents").collect(),
      legacyChunks: await ctx.db.query("chunks").collect(),
    }));
    expect(rows.facade).toMatchObject({ status: "done" });
    expect(rows.events.map(({ seq, event }) => ({ seq, event }))).toEqual([
      { seq: 0, event: "Hello " },
      { seq: 1, event: "world!" },
    ]);
    expect(rows.legacyChunks).toEqual([]);
  });

  it("reads current streams through bounded canonical Stream pages", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.mutation(api.lib.createStream, {});
    const coreId = await t.run(async (ctx) => {
      const stream = await ctx.db.get("streams", streamId);
      if (stream?.coreId === undefined) throw new Error("Missing Stream core.");
      return stream.coreId;
    });
    await t.mutation(api.lib.claim, { streamId });
    for (const [text, final] of [
      ["one", false],
      ["two", false],
      ["three", true],
    ] as const) {
      await t.mutation(api.lib.addChunk, { streamId, text, final });
    }

    const first = await t.query(api.lib.read, {
      streamId,
      cursor: null,
      numItems: 2,
    });
    expect(first).toEqual({
      streamId: coreId,
      attempt: 0,
      startIndex: 0,
      nextIndex: 2,
      page: [
        { attempt: 0, seq: 0, event: "one" },
        { attempt: 0, seq: 1, event: "two" },
      ],
      continueCursor: expect.stringMatching(/^s1:/),
      caughtUp: false,
      status: "done",
    });

    const second = await t.query(api.lib.read, {
      streamId,
      cursor: first.continueCursor,
      numItems: 2,
    });
    expect(second).toEqual({
      streamId: coreId,
      attempt: 0,
      startIndex: 2,
      nextIndex: 3,
      page: [{ attempt: 0, seq: 2, event: "three" }],
      continueCursor: expect.stringMatching(/^s1:/),
      caughtUp: true,
      status: "done",
    });

    const otherId = await t.mutation(api.lib.createStream, {});
    await expect(
      t.query(api.lib.read, {
        streamId: otherId,
        cursor: first.continueCursor,
        numItems: 2,
      }),
    ).rejects.toThrow(/different stream/);
    await expect(
      t.query(api.lib.read, {
        streamId,
        cursor: "not-a-cursor",
        numItems: 2,
      }),
    ).rejects.toThrow(/Malformed stream cursor/);
  });

  it("keeps existing rows readable and writable through the legacy chunks path", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("streams", { status: "pending" });
      await ctx.db.insert("chunks", { streamId: id, text: "Existing " });
      return id;
    });

    await t.mutation(api.lib.addChunk, {
      streamId,
      text: "response",
      final: true,
    });

    await expect(t.query(api.lib.getStreamText, { streamId })).resolves.toEqual(
      {
        text: "Existing response",
        status: "done",
      },
    );
    const cores = await t.run((ctx) => ctx.db.query("textStreams").collect());
    expect(cores).toEqual([]);
  });

  it("paginates legacy chunks canonically and includes appends between pages", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("streams", { status: "streaming" });
      for (const text of ["one", "two", "three"]) {
        await ctx.db.insert("chunks", { streamId: id, text });
      }
      return id;
    });

    const first = await t.query(api.lib.read, {
      streamId,
      cursor: null,
      numItems: 128,
    });
    expect(first).toEqual({
      streamId,
      attempt: 0,
      startIndex: 0,
      nextIndex: 1,
      page: [{ attempt: 0, seq: 0, event: "one" }],
      continueCursor: expect.stringMatching(/^p1:/),
      caughtUp: false,
      status: "streaming",
    });

    await t.mutation(api.lib.addChunk, {
      streamId,
      text: "four",
      final: true,
    });
    const second = await t.query(api.lib.read, {
      streamId,
      cursor: first.continueCursor,
      numItems: 128,
    });
    expect(second).toEqual({
      streamId,
      attempt: 0,
      startIndex: 1,
      nextIndex: 2,
      page: [{ attempt: 0, seq: 1, event: "two" }],
      continueCursor: expect.stringMatching(/^p1:/),
      caughtUp: false,
      status: "done",
    });

    const third = await t.query(api.lib.read, {
      streamId,
      cursor: second.continueCursor,
      numItems: 128,
    });
    expect(third.page).toEqual([{ attempt: 0, seq: 2, event: "three" }]);
    expect(third.caughtUp).toBe(false);

    const fourth = await t.query(api.lib.read, {
      streamId,
      cursor: third.continueCursor,
      numItems: 128,
    });
    expect(fourth.page).toEqual([{ attempt: 0, seq: 3, event: "four" }]);
    expect(fourth.caughtUp).toBe(false);

    const tail = await t.query(api.lib.read, {
      streamId,
      cursor: fourth.continueCursor,
      numItems: 128,
    });
    expect(tail).toMatchObject({
      startIndex: 4,
      nextIndex: 4,
      page: [],
      caughtUp: true,
      status: "done",
    });

    const otherId = await t.run((ctx) =>
      ctx.db.insert("streams", { status: "pending" }),
    );
    await expect(
      t.query(api.lib.read, {
        streamId: otherId,
        cursor: first.continueCursor,
        numItems: 2,
      }),
    ).rejects.toThrow(/Malformed stream cursor/);
    await expect(
      t.query(api.lib.read, {
        streamId,
        cursor: "p1:%7Bbad",
        numItems: 2,
      }),
    ).rejects.toThrow(/Malformed stream cursor/);
  });

  it("resumes a caught-up legacy streaming cursor after a later append", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("streams", { status: "streaming" });
      await ctx.db.insert("chunks", { streamId: id, text: "before" });
      return id;
    });

    const first = await t.query(api.lib.read, {
      streamId,
      cursor: null,
      numItems: 1024,
    });
    expect(first.page).toEqual([{ attempt: 0, seq: 0, event: "before" }]);
    expect(first.caughtUp).toBe(false);

    const tail = await t.query(api.lib.read, {
      streamId,
      cursor: first.continueCursor,
      numItems: 1024,
    });
    expect(tail).toMatchObject({
      startIndex: 1,
      nextIndex: 1,
      page: [],
      caughtUp: true,
      status: "streaming",
    });

    await t.mutation(api.lib.addChunk, {
      streamId,
      text: "after",
      final: false,
    });
    const resumed = await t.query(api.lib.read, {
      streamId,
      cursor: tail.continueCursor,
      numItems: 1024,
    });
    expect(resumed).toMatchObject({
      startIndex: 1,
      nextIndex: 2,
      page: [{ attempt: 0, seq: 1, event: "after" }],
      caughtUp: false,
      status: "streaming",
    });
  });

  it("virtually splits JSON-expanding legacy chunks below the SSE frame limit", async () => {
    const t = convexTest(schema, modules);
    const text = `${"\u0000".repeat(400_000)}🙂tail`;
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(1024 * 1024);
    expect(
      new TextEncoder().encode(JSON.stringify(text)).byteLength,
    ).toBeGreaterThan(2 * 1024 * 1024);

    const streamId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("streams", { status: "done" });
      await ctx.db.insert("chunks", { streamId: id, text });
      return id;
    });

    const pieces: string[] = [];
    let cursor: string | null = null;
    let caughtUp = false;
    for (let reads = 0; reads < 32 && !caughtUp; reads += 1) {
      const result: StreamReadResult<string, string> = await t.query(
        api.lib.read,
        {
          streamId,
          cursor,
          numItems: 1024,
        },
      );
      expect(result.page.length).toBeLessThanOrEqual(1);
      expect(
        new TextEncoder().encode(JSON.stringify(result)).byteLength,
      ).toBeLessThan(2 * 1024 * 1024);
      if (result.page[0]) {
        expect(
          new TextEncoder().encode(JSON.stringify(result.page[0])).byteLength,
        ).toBeLessThan(300 * 1024);
        pieces.push(result.page[0].event);
      }
      cursor = result.continueCursor;
      caughtUp = result.caughtUp;
    }

    expect(caughtUp).toBe(true);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(text);
  });

  it("maps legacy terminal statuses into canonical lifecycle results", async () => {
    const t = convexTest(schema, modules);
    for (const status of ["error", "timeout"] as const) {
      const streamId = await t.run((ctx) =>
        ctx.db.insert("streams", { status }),
      );
      const result = await t.query(api.lib.read, {
        streamId,
        cursor: null,
        numItems: 1,
      });
      expect(result).toMatchObject({
        streamId,
        status: "failed",
        error: { code: status },
        caughtUp: true,
      });
    }
  });

  it("rejects invalid read bounds on a live stream", async () => {
    const t = convexTest(schema, modules);
    const streamId = await t.mutation(api.lib.createStream, {});
    for (const numItems of [0, 1.5, 1025]) {
      await expect(
        t.query(api.lib.read, {
          streamId,
          cursor: null,
          numItems,
        }),
      ).rejects.toThrow(/numItems must be an integer/);
    }
  });

  it("rejects missing or deleting streams", async () => {
    const t = convexTest(schema, modules);
    const deletedId = await t.mutation(api.lib.createStream, {});
    await t.mutation(api.lib.deleteStream, { streamId: deletedId });
    await expect(
      t.query(api.lib.read, {
        streamId: deletedId,
        cursor: null,
        numItems: 1,
      }),
    ).rejects.toThrow(/Stream not found/);
    await expect(
      t.mutation(api.lib.claim, { streamId: deletedId }),
    ).rejects.toThrow(/Stream not found/);

    const deletingId = await t.mutation(api.lib.createStream, {});
    await t.run(async (ctx) => {
      const facade = await ctx.db.get("streams", deletingId);
      if (facade?.coreId === undefined) throw new Error("Missing Stream core.");
      const core = await ctx.db.get("textStreams", facade.coreId);
      if (core === null) throw new Error("Missing Stream core.");
      await ctx.db.replace("textStreams", core._id, {
        attempt: core.attempt,
        nextSeq: core.nextSeq,
        restarts: core.restarts,
        status: "deleting",
        deletingAt: Date.now(),
      });
    });
    await expect(
      t.query(api.lib.read, {
        streamId: deletingId,
        cursor: null,
        numItems: 1,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.lib.claim, { streamId: deletingId }),
    ).rejects.toThrow(/Stream not found/);
  });

  it("maps producer failures and timeouts onto the Stream lifecycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const t = convexTest(schema, modules);

    const failedId = await t.mutation(api.lib.createStream, {});
    await t.mutation(api.lib.setStreamStatus, {
      streamId: failedId,
      status: "error",
    });
    await expect(
      t.query(api.lib.getStreamText, { streamId: failedId }),
    ).resolves.toEqual({
      text: "",
      status: "error",
    });
    await expect(
      t.query(api.lib.read, {
        streamId: failedId,
        cursor: null,
        numItems: 8,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "error" },
      caughtUp: true,
    });
    await expect(
      t.mutation(api.lib.claim, { streamId: failedId }),
    ).resolves.toEqual({ claimed: false });

    const timedOutId = await t.mutation(api.lib.createStream, {});
    vi.setSystemTime(20 * 60 * 1000 + 1);
    await t.mutation(internal.lib.cleanupExpiredStreams, {});
    await expect(
      t.query(api.lib.getStreamText, { streamId: timedOutId }),
    ).resolves.toEqual({
      text: "",
      status: "timeout",
    });
    await expect(
      t.query(api.lib.read, {
        streamId: timedOutId,
        cursor: null,
        numItems: 8,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "timeout" },
      caughtUp: true,
    });

    const errors = await t.run(async (ctx) => {
      const failed = await ctx.db.get("streams", failedId);
      const timedOut = await ctx.db.get("streams", timedOutId);
      return Promise.all([
        failed?.coreId ? ctx.db.get("textStreams", failed.coreId) : null,
        timedOut?.coreId ? ctx.db.get("textStreams", timedOut.coreId) : null,
      ]);
    });
    expect(errors[0]).toMatchObject({
      status: "failed",
      error: { code: "error" },
    });
    expect(errors[1]).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
  });

  it("deletes current and legacy storage without changing the public API", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);

    const currentId = await t.mutation(api.lib.createStream, {});
    await t.run(async (ctx) => {
      const facade = await ctx.db.get("streams", currentId);
      if (facade?.coreId === undefined) throw new Error("Missing Stream core.");
      for (let seq = 0; seq < 513; seq += 1) {
        await ctx.db.insert("textStreamsEvents", {
          streamId: facade.coreId,
          attempt: 0,
          seq,
          event: `current-${seq}`,
        });
      }
      await ctx.db.patch("textStreams", facade.coreId, {
        status: "streaming",
        nextSeq: 513,
      });
    });
    await t.mutation(api.lib.deleteStream, { streamId: currentId });

    const legacyId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("streams", { status: "done" });
      await ctx.db.insert("chunks", { streamId: id, text: "legacy" });
      return id;
    });
    await t.mutation(api.lib.deleteStream, { streamId: legacyId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const remaining = await t.run(async (ctx) => ({
      facades: await ctx.db.query("streams").collect(),
      chunks: await ctx.db.query("chunks").collect(),
      cores: await ctx.db.query("textStreams").collect(),
      events: await ctx.db.query("textStreamsEvents").collect(),
    }));
    expect(remaining).toEqual({
      facades: [],
      chunks: [],
      cores: [],
      events: [],
    });
  });
});
