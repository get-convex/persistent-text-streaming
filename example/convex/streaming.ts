import {
  PersistentTextStreaming,
  StreamId,
  StreamIdValidator,
} from "@convex-dev/persistent-text-streaming";
import { streamQueryArgsValidator } from "@convex-dev/stream";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

export const streamingComponent = new PersistentTextStreaming(
  components.persistentTextStreaming,
);

export const getStreamBody = query({
  args: {
    streamId: StreamIdValidator,
  },
  handler: async (ctx, args) => {
    return await streamingComponent.getStreamBody(
      ctx,
      args.streamId as StreamId,
    );
  },
});

// Followers and recovery subscribe here. This demo is public; a production app
// authorizes the caller against the record that owns the stream, exactly as it
// would for getStreamBody.
export const readStream = query({
  args: {
    streamId: StreamIdValidator,
    streamArgs: streamQueryArgsValidator,
  },
  handler: async (ctx, args) => {
    return await streamingComponent.readStream(
      ctx,
      args.streamId as StreamId,
      args.streamArgs,
    );
  },
});
