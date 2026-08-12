import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { textStreams } from "./streams.js";

export const run = internalMutation({
  args: textStreams.args.run,
  returns: textStreams.returns.run,
  handler: async (ctx, args): Promise<{ isDone: boolean }> =>
    textStreams.run(ctx, args, { run: internal.streamMaintenance.run }),
});
