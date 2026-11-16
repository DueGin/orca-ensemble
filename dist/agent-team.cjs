"use strict";

// src/cli/agent-team.ts
var import_node_fs = require("node:fs");
var import_node_net = require("node:net");
var import_node_path = require("node:path");

// src/shared/paths.ts
var import_node_crypto = require("node:crypto");
function rootKey(pluginRoot2) {
  return (0, import_node_crypto.createHash)("sha256").update(pluginRoot2).digest("hex").slice(0, 12);
}
function socketPath(pluginRoot2) {
  return `/tmp/orca-agent-team-${rootKey(pluginRoot2)}.sock`;
}

// src/cli/agent-team.ts
function pluginRoot() {
  const here = (0, import_node_path.dirname)((0, import_node_fs.realpathSync)(process.argv[1] ?? __filename));
  return (0, import_node_fs.realpathSync)((0, import_node_path.join)(here, ".."));
}
function readStdin(waitMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    let timer = setTimeout(() => finish(), waitMs);
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      process.stdin.pause();
      resolve(text);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, 2e3);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const rest = args.slice(1);
  let input = {};
  const parse = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return command === "help" ? { command: trimmed } : { text: trimmed, message: trimmed, result: trimmed };
    }
  };
  if (rest.length && rest[0] !== "-") input = parse(rest.join(" "));
  else input = parse(await readStdin(rest[0] === "-" ? 3e4 : 400));
  const request = {
    command,
    input,
    terminalId: process.env.ORCA_TERMINAL_HANDLE ?? null,
    workspaceId: process.env.ORCA_WORKSPACE_ID ?? process.env.ORCA_WORKTREE_ID ?? null,
    userDataPath: process.env.ORCA_USER_DATA_PATH ?? null,
    cwd: process.cwd()
  };
  const path = process.env.AGENT_TEAM_SOCKET || socketPath(pluginRoot());
  const safe = /* @__PURE__ */ new Set(["help", "status", "wait", "board", "read"]);
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await send(path, request);
    if (outcome.kind === "reply") {
      (outcome.isError ? process.stderr : process.stdout).write(outcome.text.endsWith("\n") ? outcome.text : `${outcome.text}
`);
      return outcome.isError ? 1 : 0;
    }
    const retry = safe.has(command) && attempt < 8;
    if (outcome.kind === "dropped" && retry) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (outcome.kind === "unreachable" && retry && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2e3));
      continue;
    }
    if (outcome.kind === "dropped") {
      process.stderr.write(`agent-team: the plugin restarted while running "${command}". It may or may not have been done: run \`agent-team status\` to check before trying again.
`);
      return 3;
    }
    process.stderr.write("agent-team: the Agent Team plugin is not running in Orca (enable it in Settings \u2192 Plugins), so the team can't be reached.\n");
    return 2;
  }
}
function send(path, request) {
  return new Promise((resolve) => {
    const socket = (0, import_node_net.connect)(path);
    let reply = "";
    let connected = false;
    socket.setEncoding("utf8");
    socket.setTimeout(62e4, () => {
      socket.destroy();
      resolve({ kind: "dropped" });
    });
    socket.on("connect", () => {
      connected = true;
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk) => reply += chunk);
    socket.on("close", () => {
      try {
        const response = JSON.parse(reply);
        resolve({ kind: "reply", text: response.text, isError: response.isError });
      } catch {
        resolve(connected ? { kind: "dropped" } : { kind: "unreachable" });
      }
    });
    socket.on("error", () => void 0);
  });
}
void main().then((code) => process.exit(code));
