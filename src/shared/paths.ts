// Where the plugin keeps its state and how it reaches the agents' shell command. The worker and the `agent-team` command
// derive the same socket and data folder from the plugin folder, so they find each other without configuration.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** A short stable id for a plugin folder: a dev folder and an installed copy keep separate state. */
export function rootKey(pluginRoot: string): string {
  return createHash("sha256").update(pluginRoot).digest("hex").slice(0, 12);
}

/** The Unix socket the worker serves `agent-team` on; short, since socket paths are capped near 104 bytes. */
export function socketPath(pluginRoot: string): string {
  return `/tmp/orca-ensemble-${rootKey(pluginRoot)}.sock`;
}

/** The plugin's state: sessions, runs, the agents' instruction files. */
export function dataDir(pluginRoot: string): string {
  return join(homedir(), ".orca-ensemble", rootKey(pluginRoot));
}

/** Environment the plugin gives every agent Orca launches, so `agent-team` works in its shell. */
export const ENV = {
  socket: "AGENT_TEAM_SOCKET",
  bin: "AGENT_TEAM_BIN",
  node: "AGENT_TEAM_NODE",
} as const;
