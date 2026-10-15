// @vitest-environment happy-dom
// Effects only run in client builds, which a DOM environment selects.
import { flushSync } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StreamBody, StreamId } from "../client/index.js";
import { useStream } from "./index.svelte.js";

// Stands in for the Convex subscription: a subscribed stream id returns the
// body stored for it, and "skip" returns nothing. The map is reactive, so a
// later write reaches the hook like a subscription update. The factory only
// reads `persisted` when a test runs, after this module has initialized it.
const persisted = new SvelteMap<string, StreamBody>();
vi.mock("convex-svelte", () => ({
  useQuery: (
    _query: unknown,
    getArgs: () => { streamId: string } | "skip",
  ) => ({
    get data() {
      const args = getArgs();
      return args === "skip" ? undefined : persisted.get(args.streamId);
    },
  }),
}));

const query = {} as Parameters<typeof useStream>[0];
const url = new URL("https://example.convex.site/chat-stream");

type FetchInit = {
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
};
type Options = { authToken: string; headers: Record<string, string> };
const fetchMock = vi.fn<(url: URL, init: FetchInit) => Promise<Response>>();

function controlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { response: new Response(body), controller };
}

function render(
  initial: { driven: boolean; streamId?: string },
  getOpts?: Parameters<typeof useStream>[4],
) {
  const props = $state(initial);
  let stream!: Readonly<StreamBody>;
  const destroy = $effect.root(() => {
    stream = useStream(
      query,
      url,
      () => props.driven,
      () => props.streamId as StreamId | undefined,
      getOpts,
    );
  });
  flushSync();
  return { props, stream, destroy };
}

const requestedIds = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).streamId);

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  persisted.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useStream (svelte)", () => {
  test("decodes characters split across chunks", async () => {
    const { response, controller } = controlledResponse();
    fetchMock.mockResolvedValue(response);
    const { stream, destroy } = render({ driven: true, streamId: "a" });

    const bytes = new TextEncoder().encode("héllo 👋");
    // Split inside "é" (2 bytes) and inside the emoji (4 bytes).
    controller.enqueue(bytes.slice(0, 2));
    controller.enqueue(bytes.slice(2, 9));
    controller.enqueue(bytes.slice(9));
    controller.close();

    await vi.waitFor(() => expect(stream.status).toBe("done"));
    expect(stream.text).toBe("héllo 👋");
    destroy();
  });

  test("a new streamId resets the text and starts a new request", async () => {
    const first = controlledResponse();
    const second = controlledResponse();
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    const { props, stream, destroy } = render({ driven: true, streamId: "a" });

    first.controller.enqueue(new TextEncoder().encode("first"));
    await vi.waitFor(() => expect(stream.text).toBe("first"));

    props.streamId = "b";
    flushSync();
    expect(stream).toMatchObject({ text: "", status: "pending" });
    expect(requestedIds()).toEqual(["a", "b"]);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);

    second.controller.enqueue(new TextEncoder().encode("second"));
    second.controller.close();
    await vi.waitFor(() => expect(stream.status).toBe("done"));
    expect(stream.text).toBe("second");
    destroy();
  });

  test("an undefined streamId shows empty text and pending", async () => {
    const { response, controller } = controlledResponse();
    fetchMock.mockResolvedValue(response);
    const { props, stream, destroy } = render({ driven: true, streamId: "a" });

    controller.enqueue(new TextEncoder().encode("done text"));
    controller.close();
    await vi.waitFor(() => expect(stream.status).toBe("done"));

    props.streamId = undefined;
    flushSync();
    expect(stream).toMatchObject({ text: "", status: "pending" });
    destroy();
  });

  test("does not restart when the getter re-runs with the same streamId", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const message = $state({ current: { streamId: "a" } });
    const destroy = $effect.root(() => {
      useStream(
        query,
        url,
        () => true,
        () => message.current.streamId as StreamId,
      );
    });
    flushSync();

    message.current = { streamId: "a" };
    flushSync();

    expect(requestedIds()).toEqual(["a"]);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    destroy();
  });

  test("teardown aborts the request without reporting an error", async () => {
    // Like the real fetch, reject once the request is aborted.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { stream, destroy } = render({ driven: true, streamId: "a" });

    destroy();

    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stream.status).toBe("pending");
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("a response settling after a switch does not leak into the next stream", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 205 }))
      .mockReturnValueOnce(new Promise(() => {}));
    const { props, stream, destroy } = render({ driven: true, streamId: "a" });

    // Switch before the first response's continuation runs.
    props.streamId = "b";
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stream.status).toBe("pending");
    destroy();
  });

  test("a rejected fetch falls back to the persisted body", async () => {
    persisted.set("a", { text: "partial", status: "streaming" });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { stream, destroy } = render({ driven: true, streamId: "a" });

    await vi.waitFor(() => expect(stream.text).toBe("partial"));
    persisted.set("a", { text: "partial and more", status: "done" });
    expect(stream).toMatchObject({ text: "partial and more", status: "done" });
    destroy();
  });

  test("resuming a stream before its first chunk persists does not POST again", async () => {
    // Like the real fetch, reject once the request is aborted.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    persisted.set("a", { text: "", status: "pending" });
    const { props, stream, destroy } = render({ driven: true, streamId: "a" });

    props.driven = false;
    flushSync();
    props.driven = true;
    flushSync();
    persisted.set("a", { text: "first chunk", status: "streaming" });

    expect(requestedIds()).toEqual(["a"]);
    expect(stream).toMatchObject({ text: "first chunk", status: "streaming" });

    // A new stream still streams over HTTP, and its request stays open.
    const b = controlledResponse();
    fetchMock.mockResolvedValueOnce(b.response);
    props.streamId = "b";
    flushSync();
    expect(requestedIds()).toEqual(["a", "b"]);
    expect(stream).toMatchObject({ text: "", status: "pending" });

    b.controller.enqueue(new TextEncoder().encode("from http"));
    await vi.waitFor(() =>
      expect(stream).toMatchObject({ text: "from http", status: "streaming" }),
    );
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
    destroy();
  });

  test.each([
    ["the token", (o: Options) => (o.authToken = "new")],
    ["a header", (o: Options) => (o.headers["X-Trace"] = "new")],
  ])("changing %s does not restart the request", (_name, change) => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const options = $state<Options>({
      authToken: "old",
      headers: { "X-Trace": "old" },
    });
    const { destroy } = render({ driven: true, streamId: "a" }, () => options);

    change(options);
    flushSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer old",
      "X-Trace": "old",
    });
    destroy();
  });

  test.each([205, 500])(
    "a %i response falls back to the persisted body",
    async (status) => {
      persisted.set("a", { text: "from the database", status: "done" });
      fetchMock.mockResolvedValue(new Response(null, { status }));
      const { stream, destroy } = render({ driven: true, streamId: "a" });

      await vi.waitFor(() => expect(stream.text).toBe("from the database"));
      destroy();
    },
  );
});
