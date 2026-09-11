import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";

const runId = `pts-occ:${Date.now()}:${randomUUID()}`;
const result = spawnSync(
  "npx",
  [
    "convex",
    "run",
    "occIntegration:run",
    JSON.stringify({ runId }),
    "--deployment",
    "dev",
    "--push",
    "--codegen",
    "disable",
    "--typecheck",
    "enable",
    "--typecheck-components",
  ],
  {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: process.env,
    timeout: 15 * 60 * 1000,
  },
);

if (result.error) {
  process.stderr.write(
    `Unable to complete the real-backend OCC test: ${result.error.message}\n`,
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stderr.write(result.stdout);
  process.exit(1);
}

if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stderr.write(result.stdout);
  process.stderr.write(
    "Real-backend OCC tests require a configured personal Convex dev deployment or a CONVEX_DEPLOY_KEY for one.\n",
  );
  process.exit(result.status ?? 1);
}

let summary;
try {
  summary = JSON.parse(result.stdout.trim());
} catch {
  process.stderr.write("Convex returned an unreadable OCC test summary.\n");
  process.stderr.write(result.stdout);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.passed !== true) process.exit(1);
