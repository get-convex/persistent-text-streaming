import { query, mutation, internalQuery } from "./_generated/server";
import { StreamId } from "@convex-dev/persistent-text-streaming";
import { v } from "convex/values";
import { streamingComponent } from "./streaming";

export const listMessages = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("userMessages").collect();
  },
});

export const clearMessages = mutation({
  args: {},
  handler: async (ctx) => {
    const chats = await ctx.db.query("userMessages").collect();
    await Promise.all(chats.map((chat) => ctx.db.delete(chat._id)));
  },
});

export const sendMessage = mutation({
  args: {
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const responseStreamId = await streamingComponent.createStream(ctx);
    const chatId = await ctx.db.insert("userMessages", {
      prompt: args.prompt,
      responseStreamId,
    });
    return chatId;
  },
});

export const getHistory = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Grab all the user messages
    const allMessages = await ctx.db.query("userMessages").collect();

    // Lets join the user messages with the assistant messages
    const joinedResponses = await Promise.all(
      allMessages.map(async (userMessage) => {
        return {
          userMessage,
          responseMessage: await streamingComponent.getStreamBody(
            ctx,
            userMessage.responseStreamId as StreamId
          ),
        };
      })
    );

    return joinedResponses.flatMap((joined) => {
      const user = {
        role: "user" as const,
        content: joined.userMessage.prompt,
      };

      const assistant = {
        role: "assistant" as const,
        content: joined.responseMessage.text,
      };

      // If the assistant message is empty, its probably because we have not
      // started streaming yet so lets not include it in the history
      if (!assistant.content) return [user];

      return [user, assistant];
    });
  },
});
