import { afterEach, describe, expect, it, vi } from "vitest";

import type { StreamBody, StreamId } from "../client/index.js";
import {
  CadencedText,
  MAX_DRIVE_ATTEMPTS,
  startTextTransport,
  VISIBLE_COMMIT_MS,
} from "./transport.js";

const streamId = "stream-1" as StreamId;

function config(url = "https://example.com/chat") {
  return { headers: {}, streamId, url };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("text transport", () => {
  it("posts to the action URL unchanged", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 205 }));
    const transport = startTextTransport(
      config("https://example.com/chat?room=one"),
      { publish: vi.fn(), handoff: vi.fn() },
      { fetch: fetchMock as typeof fetch },
    );

    await transport.closed;
    expect(String((fetchMock.mock.calls[0] as unknown[])?.[0])).toBe(
      "https://example.com/chat?room=one",
    );
  });

  it("hands off a 205 drive response without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 205 }));
    const handoff = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const transport = startTextTransport(
      config(),
      { publish: vi.fn(), handoff },
      { fetch: fetchMock as typeof fetch, sleep },
    );

    await transport.closed;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries ambiguous drive failures with capped backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new TypeError("network unavailable again"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 205 }));
    const sleep = vi.fn(
      async (_milliseconds: number, _signal: AbortSignal) => undefined,
    );
    const handoff = vi.fn();
    const transport = startTextTransport(
      config(),
      { publish: vi.fn(), handoff, report: vi.fn() },
      { fetch: fetchMock as typeof fetch, sleep },
    );

    await transport.closed;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      100, 200, 400, 800, 1_600,
    ]);
    expect(handoff).toHaveBeenCalledOnce();
  });

  it("retries throttled and timed-out drive responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 408 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 205 }));
    const sleep = vi.fn(
      async (_milliseconds: number, _signal: AbortSignal) => undefined,
    );
    const transport = startTextTransport(
      config(),
      { publish: vi.fn(), handoff: vi.fn() },
      { fetch: fetchMock as typeof fetch, sleep },
    );

    await transport.closed;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      100, 200,
    ]);
  });

  it("stops retrying at the attempt cap and hands off", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    const sleep = vi.fn(async () => undefined);
    const handoff = vi.fn();
    const transport = startTextTransport(
      config(),
      { publish: vi.fn(), handoff, report: vi.fn() },
      { fetch: fetchMock as typeof fetch, sleep },
    );

    await transport.closed;
    expect(fetchMock).toHaveBeenCalledTimes(MAX_DRIVE_ATTEMPTS);
    expect(handoff).toHaveBeenCalledOnce();
  });

  it("hands off an ok drive response that is missing its body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const handoff = vi.fn();
    const transport = startTextTransport(
      config(),
      { publish: vi.fn(), handoff },
      { fetch: fetchMock as typeof fetch },
    );

    await transport.closed;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledOnce();
  });

  it("hands off a nonretryable drive rejection immediately", async () => {
    const handoff = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const transport = startTextTransport(
      config(),
      { publish: vi.fn(), handoff },
      {
        fetch: vi.fn(async () => new Response(null, { status: 401 })),
        sleep,
      },
    );

    await transport.closed;
    expect(handoff).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying when closed", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    let retrySignal: AbortSignal | undefined;
    const sleep = vi.fn(
      (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          retrySignal = signal;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const handoff = vi.fn();
    const transport = startTextTransport(
      config(),
      { publish: vi.fn(), handoff, report: vi.fn() },
      { fetch: fetchMock as typeof fetch, sleep },
    );

    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    transport.close();
    await transport.closed;
    await settle();
    expect(retrySignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("hands off after a mid-body disconnect instead of retrying", async () => {
    vi.useFakeTimers();
    let rejectRead!: (error: unknown) => void;
    let reads = 0;
    const rawResponse = {
      status: 200,
      ok: true,
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read() {
              reads += 1;
              if (reads === 1) {
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode("raw-prefix"),
                });
              }
              return new Promise((_, reject) => {
                rejectRead = reject;
              });
            },
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;
    const fetchMock = vi.fn(async () => rawResponse);
    const published: StreamBody[] = [];
    const handoff = vi.fn();
    startTextTransport(
      config(),
      {
        publish: (body) => published.push(body),
        handoff,
        report: vi.fn(),
      },
      {
        fetch: fetchMock as typeof fetch,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      },
    );

    await settle();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await vi.advanceTimersByTimeAsync(VISIBLE_COMMIT_MS);
    expect(published.at(-1)).toEqual({
      text: "raw-prefix",
      status: "streaming",
    });

    rejectRead(new Error("disconnected"));
    await settle();
    expect(handoff).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("publishes a completed raw body without handing off", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () => new Response("hello there", { status: 200 }),
    );
    const published: StreamBody[] = [];
    const handoff = vi.fn();
    const transport = startTextTransport(
      config(),
      { publish: (body) => published.push(body), handoff },
      {
        fetch: fetchMock as typeof fetch,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      },
    );

    await vi.advanceTimersByTimeAsync(VISIBLE_COMMIT_MS);
    await transport.closed;
    expect(published.at(-1)).toEqual({ text: "hello there", status: "done" });
    expect(handoff).not.toHaveBeenCalled();
  });

  it("sends auth, custom headers, and the POST body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 205 }));
    const transport = startTextTransport(
      {
        headers: {
          Authorization: "Bearer secret",
          "X-Workspace": "workspace",
        },
        streamId,
        url: "https://example.com/chat",
      },
      { publish: vi.fn(), handoff: vi.fn() },
      { fetch: fetchMock as typeof fetch },
    );

    await transport.closed;
    const init = (fetchMock.mock.calls[0] as unknown[])?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ streamId }));
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("X-Workspace")).toBe("workspace");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("coalesces token-frequency appends to the fixed visible cadence", async () => {
    vi.useFakeTimers();
    const published: StreamBody[] = [];
    const text = new CadencedText((body) => published.push(body));

    for (let index = 0; index < 100; index += 1) text.append("x");
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(VISIBLE_COMMIT_MS - 1);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(published).toEqual([{ text: "x".repeat(100), status: "streaming" }]);

    for (let index = 0; index < 50; index += 1) text.append("y");
    await vi.advanceTimersByTimeAsync(VISIBLE_COMMIT_MS);
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.text).toBe("x".repeat(100) + "y".repeat(50));
  });

  it("fences publish and handoff after close", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("late", { status: 200 }));
    const publish = vi.fn();
    const handoff = vi.fn();
    const transport = startTextTransport(
      config(),
      { publish, handoff },
      {
        fetch: fetchMock as typeof fetch,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      },
    );
    transport.close();

    await vi.advanceTimersByTimeAsync(VISIBLE_COMMIT_MS * 2);
    await settle();
    expect(publish).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });
});
