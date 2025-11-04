import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run every minute
crons.interval(
  "cleanup expired streams",
  { minutes: 1 },
  internal.lib.cleanupExpiredStreams,
);

export default crons;
