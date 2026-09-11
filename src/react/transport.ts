import type { StreamBody, StreamId } from "../client/index.js";
import type { StreamStatus } from "../component/schema.js";

export const VISIBLE_COMMIT_MS = 50;
const DRIVE_RETRY_BASE_MS = 100;
const DRIVE_RETRY_MAX_MS = 5_000;
// A drive request that keeps failing must eventually yield to the durable read
// path rather than polling the app's endpoint for the component's lifetime.
export const MAX_DRIVE_ATTEMPTS = 6;

type Timer = ReturnType<typeof setTimeout>;

export type TextTransportSink = {
  publish: (body: StreamBody) => void;
  /** The raw path cannot finish; the caller should read durably instead. */
  handoff: () => void;
  report?: (error: unknown) => void;
};

export type TextTransportConfig = {
  headers: HeadersInit;
  streamId: StreamId;
  url: string;
};

export type TextTransportDependencies = {
  fetch: typeof fetch;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type TextTransport = {
  close: () => void;
  closed: Promise<void>;
};

const defaultDependencies: TextTransportDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  setTimer: globalThis.setTimeout.bind(globalThis),
  clearTimer: globalThis.clearTimeout.bind(globalThis),
  sleep: (milliseconds, signal) => {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, milliseconds);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  },
};

export class CadencedText {
  private committed = "";
  private pending: string[] = [];
  private status: StreamStatus = "pending";
  private timer: Timer | null = null;
  private active = true;

  constructor(
    private readonly publish: (body: StreamBody) => void,
    private readonly setTimer: typeof setTimeout = setTimeout,
    private readonly clearTimer: typeof clearTimeout = clearTimeout,
  ) {}

  append(text: string): void {
    if (!this.active || text.length === 0) return;
    this.pending.push(text);
    if (this.status === "pending") this.status = "streaming";
    this.schedule();
  }

  setStatus(status: StreamStatus): void {
    if (!this.active) return;
    this.status = status;
    this.schedule();
  }

  flush(): void {
    if (!this.active) return;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.pending.length > 0) {
      this.committed += this.pending.join("");
      this.pending = [];
    }
    this.publish({ text: this.committed, status: this.status });
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = [];
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, VISIBLE_COMMIT_MS);
  }
}

function requestHeaders(headers: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("Content-Type", "application/json");
  return result;
}

function driveRetryDelay(attempt: number): number {
  return Math.min(
    DRIVE_RETRY_BASE_MS * 2 ** Math.min(attempt, 6),
    DRIVE_RETRY_MAX_MS,
  );
}

function retryableDriveStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Drive one stream over a plain POST and publish its raw body at a fixed
 * cadence.
 *
 * This is the low-latency path for the single browser that generates the text.
 * Every other outcome -- a lost claim, a mid-flight disconnect, or exhausted
 * retries -- hands off to the caller, which reads the same stream durably
 * through an app-owned Convex query.
 */
export function startTextTransport(
  config: TextTransportConfig,
  sink: TextTransportSink,
  dependencies: Partial<TextTransportDependencies> = {},
): TextTransport {
  const deps = { ...defaultDependencies, ...dependencies };
  const controller = new AbortController();
  const body = JSON.stringify({ streamId: config.streamId });
  const headers = requestHeaders(config.headers);
  let active = true;
  const raw = new CadencedText(sink.publish, deps.setTimer, deps.clearTimer);
  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    settleClosed();
  };
  const report = (error: unknown) => {
    if (!controller.signal.aborted) sink.report?.(error);
  };
  const handoff = () => {
    if (!active || controller.signal.aborted) return;
    raw.close();
    sink.handoff();
    settle();
  };
  const waitForRetry = async (attempt: number): Promise<boolean> => {
    await deps.sleep(driveRetryDelay(attempt), controller.signal);
    return active && !controller.signal.aborted;
  };

  const drive = async () => {
    for (
      let attempt = 0;
      active && !controller.signal.aborted && attempt < MAX_DRIVE_ATTEMPTS;
      attempt += 1
    ) {
      let receivedRawBytes = false;
      try {
        const response = await deps.fetch(config.url, {
          method: "POST",
          body,
          headers,
          signal: controller.signal,
        });
        // Another request already owns production, so nothing will arrive here.
        if (response.status === 205) {
          void response.body?.cancel().catch(() => undefined);
          handoff();
          return;
        }
        if (retryableDriveStatus(response.status)) {
          void response.body?.cancel().catch(() => undefined);
          if (!(await waitForRetry(attempt))) return;
          continue;
        }
        if (!response.ok || response.body === null) {
          void response.body?.cancel().catch(() => undefined);
          handoff();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (!chunk.done && chunk.value.byteLength > 0) {
              receivedRawBytes = true;
            }
            const text = chunk.done
              ? decoder.decode()
              : decoder.decode(chunk.value, { stream: true });
            if (text.length > 0) raw.append(text);
            if (chunk.done) {
              raw.setStatus("done");
              raw.flush();
              settle();
              return;
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        report(error);
        // Partial raw text is already on screen but its tail is unknown, so the
        // durable replay must supersede it rather than resume behind it.
        if (receivedRawBytes) {
          handoff();
          return;
        }
        if (!(await waitForRetry(attempt))) return;
      }
    }
    handoff();
  };

  void drive();

  return {
    close() {
      if (!active) return;
      active = false;
      controller.abort();
      raw.close();
      settle();
    },
    closed,
  };
}
