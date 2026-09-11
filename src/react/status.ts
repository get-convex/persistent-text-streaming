import type {
  StreamError,
  StreamStatus as CoreStreamStatus,
} from "@convex-dev/stream";

import type { StreamStatus } from "../component/schema.js";

/**
 * Project a Stream lifecycle onto this component's published status union.
 *
 * `failed` carries the distinction between a producer error and the expiration
 * job's timeout; `canceled` has no public counterpart and reads as `error`.
 */
export function publicStatus(
  status: CoreStreamStatus | null,
  error?: StreamError,
): StreamStatus {
  if (status === null) return "pending";
  if (status === "failed") {
    return error?.code === "timeout" ? "timeout" : "error";
  }
  if (status === "canceled") return "error";
  return status;
}
