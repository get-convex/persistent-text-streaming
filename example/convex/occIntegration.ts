import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { internalAction } from "./_generated/server";

const ROUNDS = 10;
const CONTENDERS = 8;

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };

function errorCode(error: unknown): string {
  if (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null
  ) {
    const code = (error.data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (typeof data === "object" && data !== null && "code" in data) {
      const code = (data as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  const match = /["']code["']\s*:\s*["']([^"']+)["']/.exec(String(error));
  return match?.[1] ?? "unknown";
}

async function settle<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

const countersValidator = v.object({ won: v.number(), rejected: v.number() });

// This action is invoked only by scripts/run-occ-integration.mjs. It exercises
// real backend transactions; convex-test cannot model concurrent OCC retries.
export const run = internalAction({
  args: { runId: v.string() },
  returns: v.object({
    passed: v.boolean(),
    rounds: v.number(),
    contenders: v.number(),
    claims: countersValidator,
    writers: countersValidator,
    deleteAppend: countersValidator,
    failures: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    if (!args.runId.startsWith("pts-occ:")) {
      throw new ConvexError({
        code: "invalidArgument",
        message: "runId must start with pts-occ:.",
      });
    }

    let claimsWon = 0;
    let claimsRejected = 0;
    let writersWon = 0;
    let writersRejected = 0;
    let deleteAppendWon = 0;
    let deleteAppendRejected = 0;
    const failures: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const streamId: string = await ctx.runMutation(
        components.persistentTextStreaming.lib.createStream,
        {},
      );
      const attempts = await Promise.all(
        Array.from({ length: CONTENDERS }, async (_, contender) => {
          const claim = await ctx.runMutation(
            components.persistentTextStreaming.lib.claim,
            { streamId },
          );
          if (!claim.claimed) {
            return { claimed: false, wrote: false, error: null };
          }
          try {
            await ctx.runMutation(
              components.persistentTextStreaming.lib.addChunk,
              {
                streamId,
                text: `${args.runId}:${round}:${contender}`,
                final: true,
              },
            );
            return { claimed: true, wrote: true, error: null };
          } catch (error) {
            return { claimed: true, wrote: false, error: errorCode(error) };
          }
        }),
      );
      const roundClaims = attempts.filter((attempt) => attempt.claimed).length;
      const roundWriters = attempts.filter((attempt) => attempt.wrote).length;
      claimsWon += roundClaims;
      claimsRejected += CONTENDERS - roundClaims;
      writersWon += roundWriters;
      writersRejected += CONTENDERS - roundWriters;

      if (roundClaims !== 1 || roundWriters !== 1) {
        failures.push(
          `claim round ${round}: claims=${roundClaims}, writers=${roundWriters}`,
        );
      }
      for (const attempt of attempts) {
        if (attempt.error !== null) {
          failures.push(
            `claim round ${round}: winning writer=${attempt.error}`,
          );
        }
      }

      const body: { text: string; status: string } = await ctx.runQuery(
        components.persistentTextStreaming.lib.getStreamText,
        { streamId },
      );
      if (body.status !== "done" || body.text.length === 0) {
        failures.push(
          `claim round ${round}: durable status=${body.status}, textLength=${body.text.length}`,
        );
      }
      await ctx.runMutation(
        components.persistentTextStreaming.lib.deleteStream,
        {
          streamId,
        },
      );

      const deleteStreamId: string = await ctx.runMutation(
        components.persistentTextStreaming.lib.createStream,
        {},
      );
      const initialClaim = await ctx.runMutation(
        components.persistentTextStreaming.lib.claim,
        { streamId: deleteStreamId },
      );
      if (!initialClaim.claimed) {
        failures.push(`delete/append round ${round}: setup claim lost`);
      }
      await ctx.runMutation(components.persistentTextStreaming.lib.addChunk, {
        streamId: deleteStreamId,
        text: "seed",
        final: false,
      });

      const [append, deletion] = await Promise.all([
        settle(() =>
          ctx.runMutation(components.persistentTextStreaming.lib.addChunk, {
            streamId: deleteStreamId,
            text: "tail",
            final: true,
          }),
        ),
        settle(() =>
          ctx.runMutation(components.persistentTextStreaming.lib.deleteStream, {
            streamId: deleteStreamId,
          }),
        ),
      ]);
      if (append.ok) deleteAppendWon += 1;
      else if (
        append.code === "streamNotFound" ||
        append.code === "streamDeleting"
      ) {
        deleteAppendRejected += 1;
      } else {
        failures.push(`delete/append round ${round}: append=${append.code}`);
      }
      if (!deletion.ok) {
        failures.push(`delete/append round ${round}: delete=${deletion.code}`);
      }
    }

    return {
      passed: failures.length === 0,
      rounds: ROUNDS,
      contenders: CONTENDERS,
      claims: { won: claimsWon, rejected: claimsRejected },
      writers: { won: writersWon, rejected: writersRejected },
      deleteAppend: { won: deleteAppendWon, rejected: deleteAppendRejected },
      failures,
    };
  },
});
