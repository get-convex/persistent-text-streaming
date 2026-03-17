import {
  PersistentTextStreaming,
  StreamId,
  StreamIdValidator,
} from "@convex-dev/persistent-text-streaming";
import { components } from "./_generated/api";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const streamingComponent = new PersistentTextStreaming(
  components.persistentTextStreaming,
);

export const getStreamBody = query({
  args: {
    streamId: StreamIdValidator,
    listItems: v.optional(v.boolean()),
  },
  handler: async (ctx, { streamId, listItems }) => {
    return await streamingComponent.getStreamBody(
      ctx,
      streamId as StreamId,
      listItems,
    );
  },
});
