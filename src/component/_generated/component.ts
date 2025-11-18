/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      addChunk: FunctionReference<
        "mutation",
        "internal",
        { final: boolean; reasoning?: string; streamId: string; text: string },
        any,
        Name
      >;
      createStream: FunctionReference<"mutation", "internal", {}, any, Name>;
      getStreamStatus: FunctionReference<
        "query",
        "internal",
        { streamId: string },
        "pending" | "streaming" | "done" | "error" | "timeout",
        Name
      >;
      getStreamText: FunctionReference<
        "query",
        "internal",
        { streamId: string },
        {
          reasoning: string;
          status: "pending" | "streaming" | "done" | "error" | "timeout";
          text: string;
        },
        Name
      >;
      setStreamStatus: FunctionReference<
        "mutation",
        "internal",
        {
          status: "pending" | "streaming" | "done" | "error" | "timeout";
          streamId: string;
        },
        any,
        Name
      >;
    };
  };
