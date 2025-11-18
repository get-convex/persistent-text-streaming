import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { StreamId } from "@convex-dev/persistent-text-streaming";
import { OpenAI } from "openai";
import { streamingComponent } from "./streaming";

const openai = new OpenAI();

export const streamChat = httpAction(async (ctx, request) => {
  const body = (await request.json()) as {
    streamId: string;
  };

  // Start streaming and persisting at the same time while
  // we immediately return a streaming response to the client
  const response = await streamingComponent.stream(
    ctx,
    request,
    body.streamId as StreamId,
    async (ctx, request, streamId, append) => {
      // Lets grab the history up to now so that the AI has some context
      const history = await ctx.runQuery(internal.messages.getHistory);

      // o4-mini works best with the Responses API for reasoning
      const response = await (openai as any).responses.create({
        model: "o4-mini",
        input: [
          {
            role: "system",
            content: `You are a helpful assistant that can answer questions and help with tasks.
          Please provide your response in markdown format.

          You are continuing a conversation. The conversation so far is found in the following JSON-formatted value:`,
          },
          ...history,
        ],
        reasoning: {
          effort: "medium",
          summary: "auto", // Get reasoning summary
        },
        stream: true,
      });

      let currentReasoning = "";
      let currentText = "";

      // Process the streaming response
      for await (const event of response) {

        // Handle reasoning summary chunks
        if (event.type === "response.reasoning_summary_text.delta") {
          currentReasoning += event.delta || "";
          await append({
            text: "",
            reasoning: event.delta || "",
          });
        }

        // Handle output text chunks
        if (event.type === "response.output_text.delta") {
          currentText += event.delta || "";
          await append({
            text: event.delta || "",
            reasoning: "",
          });
        }
      }
    },
  );

  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Vary", "Origin");

  return response;
});
