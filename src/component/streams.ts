import { defineStream } from "@convex-dev/stream/server";
import { v } from "convex/values";

export const textStreams = defineStream("textStreams", {
  event: v.string(),
  eventFields: {},
});
