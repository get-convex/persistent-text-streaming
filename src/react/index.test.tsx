import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { FunctionReference } from "convex/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { StreamBody, StreamId } from "../client/index.js";
import type { StreamTextQuery } from "./index.js";
import type { TextTransportSink } from "./transport.js";

const mocks = vi.hoisted(() => ({
  startTextTransport: vi.fn(),
  useQuery: vi.fn(),
  useStreamQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({ useQuery: mocks.useQuery }));
vi.mock("@convex-dev/stream/react", () => ({
  useStream: mocks.useStreamQuery,
}));
vi.mock("./transport.js", () => ({
  startTextTransport: mocks.startTextTransport,
}));

import { useStream } from "./index.js";

const getPersistentBody = {} as FunctionReference<
  "query",
  "public",
  { streamId: string },
  StreamBody
>;
const readStream = {} as StreamTextQuery;
const streamId = "stream-1" as StreamId;
const streamUrl = new URL("https://example.com/chat");

type Session = {
  close: ReturnType<typeof vi.fn>;
  sink: TextTransportSink;
};

function snapshot(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    events: text.length === 0 ? [] : [{ attempt: 0, seq: 0, event: text }],
    status: "streaming",
    isDone: false,
    caughtUp: false,
    ...overrides,
  };
}

const emptySnapshot = snapshot("", { status: null });

let mounted: ReactTestRenderer | null = null;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  if (mounted !== null) {
    await act(async () => mounted?.unmount());
    mounted = null;
  }
  mocks.startTextTransport.mockReset();
  mocks.useQuery.mockReset();
  mocks.useStreamQuery.mockReset();
});

function trackTransports(sessions: Session[]) {
  mocks.startTextTransport.mockImplementation(
    (_config: unknown, sink: TextTransportSink) => {
      const close = vi.fn();
      sessions.push({ close, sink });
      return { close, closed: new Promise<void>(() => undefined) };
    },
  );
}

function probe(driven: boolean, opts?: Record<string, unknown>) {
  return function Probe() {
    const body = useStream(
      getPersistentBody,
      streamUrl,
      driven,
      streamId,
      opts as never,
    );
    return createElement("output", { "data-status": body.status }, body.text);
  };
}

describe("useStream mounted lifecycle", () => {
  it("fences StrictMode cleanup and keeps both queries skipped while driving", async () => {
    const sessions: Session[] = [];
    mocks.useQuery.mockReturnValue(undefined);
    mocks.useStreamQuery.mockReturnValue(emptySnapshot);
    trackTransports(sessions);

    await act(async () => {
      mounted = create(
        createElement(StrictMode, null, createElement(probe(true))),
      );
    });
    const renderer = mounted as ReactTestRenderer;

    expect(sessions).toHaveLength(2);
    const stale = sessions[0]!;
    const active = sessions[1]!;
    expect(stale.close).toHaveBeenCalledOnce();
    expect(active.close).not.toHaveBeenCalled();
    expect(mocks.useQuery.mock.calls.every(([, args]) => args === "skip")).toBe(
      true,
    );
    expect(
      mocks.useStreamQuery.mock.calls.every(([, args]) => args === "skip"),
    ).toBe(true);

    await act(async () => {
      stale.sink.publish({ text: "stale", status: "done" });
      stale.sink.handoff();
    });
    expect(renderer.toJSON()).toMatchObject({
      children: null,
      props: { "data-status": "pending" },
    });

    await act(async () => {
      active.sink.publish({ text: "live", status: "streaming" });
    });
    expect(renderer.toJSON()).toMatchObject({
      children: ["live"],
      props: { "data-status": "streaming" },
    });

    await act(async () => {
      stale.sink.publish({ text: "late stale", status: "done" });
    });
    expect(renderer.toJSON()).toMatchObject({
      children: ["live"],
      props: { "data-status": "streaming" },
    });

    await act(async () => renderer.unmount());
    mounted = null;
    expect(active.close).toHaveBeenCalledOnce();
  });

  it("reads a passive follower durably without any drive request", async () => {
    mocks.useQuery.mockReturnValue(undefined);
    mocks.useStreamQuery.mockReturnValue(
      snapshot("persisted", { status: "done", isDone: true }),
    );
    trackTransports([]);

    await act(async () => {
      mounted = create(createElement(probe(false, { readStream })));
    });

    expect(mocks.startTextTransport).not.toHaveBeenCalled();
    expect(mocks.useStreamQuery.mock.calls.at(-1)?.[1]).toEqual({ streamId });
    expect(mocks.useQuery.mock.calls.every(([, args]) => args === "skip")).toBe(
      true,
    );
    expect(mounted?.toJSON()).toMatchObject({
      children: ["persisted"],
      props: { "data-status": "done" },
    });
  });

  it("maps a failed durable lifecycle onto the published status", async () => {
    mocks.useQuery.mockReturnValue(undefined);
    mocks.useStreamQuery.mockReturnValue(
      snapshot("partial", {
        status: "failed",
        error: { code: "timeout", message: "Stream generation timed out." },
        isDone: true,
      }),
    );
    trackTransports([]);

    await act(async () => {
      mounted = create(createElement(probe(false, { readStream })));
    });

    expect(mounted?.toJSON()).toMatchObject({
      props: { "data-status": "timeout" },
    });
  });

  it("holds the raw prefix after handoff until the replay catches up", async () => {
    const sessions: Session[] = [];
    mocks.useQuery.mockReturnValue(undefined);
    mocks.useStreamQuery.mockReturnValue(emptySnapshot);
    trackTransports(sessions);

    const Probe = probe(true, { readStream });
    await act(async () => {
      mounted = create(createElement(Probe));
    });
    const renderer = mounted as ReactTestRenderer;
    const session = sessions[0]!;

    await act(async () => {
      session.sink.publish({ text: "raw-prefix", status: "streaming" });
      session.sink.handoff();
    });
    expect(renderer.toJSON()).toMatchObject({ children: ["raw-prefix"] });

    // A short replay page must not rewind the reader behind the raw prefix.
    mocks.useStreamQuery.mockReturnValue(snapshot("raw-"));
    await act(async () => renderer.update(createElement(Probe)));
    expect(renderer.toJSON()).toMatchObject({ children: ["raw-prefix"] });

    mocks.useStreamQuery.mockReturnValue(
      snapshot("raw-prefix and the durable tail", {
        status: "done",
        isDone: true,
      }),
    );
    await act(async () => renderer.update(createElement(Probe)));
    expect(renderer.toJSON()).toMatchObject({
      children: ["raw-prefix and the durable tail"],
      props: { "data-status": "done" },
    });
  });

  it("falls back to the full-body query when readStream is not provided", async () => {
    const sessions: Session[] = [];
    mocks.useQuery.mockReturnValue({ text: "whole body", status: "done" });
    mocks.useStreamQuery.mockReturnValue(emptySnapshot);
    trackTransports(sessions);

    const Probe = probe(true);
    await act(async () => {
      mounted = create(createElement(Probe));
    });
    const renderer = mounted as ReactTestRenderer;

    await act(async () => sessions[0]!.sink.handoff());

    expect(mocks.useQuery.mock.calls.at(-1)?.[1]).toEqual({ streamId });
    expect(
      mocks.useStreamQuery.mock.calls.every(([, args]) => args === "skip"),
    ).toBe(true);
    expect(renderer.toJSON()).toMatchObject({
      children: ["whole body"],
      props: { "data-status": "done" },
    });
  });
});
