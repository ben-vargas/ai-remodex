#!/usr/bin/env node
// FILE: remodex.js
// Purpose: CLI surface for starting the local Remodex bridge, reopening the latest active thread, and tailing its rollout file.
// Layer: CLI binary
// Exports: none
// Depends on: ../src

const { startBridge, openLastActiveThread, watchThreadRollout } = require("../src");

const command = process.argv[2] || "up";
const usage = "Usage: remodex up [--local] | remodex resume | remodex watch [threadId]";

if (command === "up") {
  const flags = process.argv.slice(3);
  for (const flag of flags) {
    if (flag === "--local") {
      process.env.REMODEX_LOCAL = "true";
      continue;
    }

    console.error(`Unknown flag for remodex up: ${flag}`);
    console.error(usage);
    process.exit(1);
  }

  startBridge();
  return;
}

if (command === "resume") {
  try {
    const state = openLastActiveThread();
    console.log(
      `[remodex] Opened last active thread: ${state.threadId} (${state.source || "unknown"})`
    );
  } catch (error) {
    console.error(`[remodex] ${(error && error.message) || "Failed to reopen the last thread."}`);
    process.exit(1);
  }
  return;
}

if (command === "watch") {
  try {
    watchThreadRollout(process.argv[3] || "");
  } catch (error) {
    console.error(`[remodex] ${(error && error.message) || "Failed to watch the thread rollout."}`);
    process.exit(1);
  }
  return;
}

if (command !== "up") {
  console.error(`Unknown command: ${command}`);
  console.error(usage);
  process.exit(1);
}
