"use strict";

// src/cli/agent-team.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_net = require("node:net");
var import_node_path = require("node:path");

// src/shared/agents.ts
var CHAT_AGENTS = /* @__PURE__ */ new Set(["claude", "codex", "omp", "grok", "cursor", "kimi", "copilot"]);
var CHAT_OFFERED = /* @__PURE__ */ new Set([...CHAT_AGENTS, "opencode"]);
var CHAT_HANDLE_PREFIX = "structured-agent-session-";
function callerHandle(env) {
  if (env.ORCA_TERMINAL_HANDLE) return env.ORCA_TERMINAL_HANDLE;
  if (env.ORCA_AGENT_SESSION_ID) return `${CHAT_HANDLE_PREFIX}${env.ORCA_AGENT_SESSION_ID}`;
  return null;
}

// src/shared/paths.ts
var import_node_crypto = require("node:crypto");
function rootKey(pluginRoot2) {
  return (0, import_node_crypto.createHash)("sha256").update(pluginRoot2).digest("hex").slice(0, 12);
}
function socketPath(pluginRoot2) {
  return `/tmp/orca-ensemble-${rootKey(pluginRoot2)}.sock`;
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
    // A terminal's handle, or the chat whose shell runs this (ORCA_AGENT_SESSION_ID names it).
    terminalId: callerHandle(process.env),
    workspaceId: process.env.ORCA_WORKSPACE_ID ?? process.env.ORCA_WORKTREE_ID ?? null,
    userDataPath: process.env.ORCA_USER_DATA_PATH ?? null,
    cwd: process.cwd(),
    // This command can run Orca's CLI for the plugin, as this agent (see runOrca).
    protocol: 2
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
    process.stderr.write("agent-team: the Ensemble plugin is not running in Orca (enable it in Settings \u2192 Plugins), so the team can't be reached.\n");
    return 2;
  }
}
function orcaCli() {
  if (process.env.ORCA_CLI_COMMAND && (0, import_node_fs.existsSync)(process.env.ORCA_CLI_COMMAND)) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_CLI_BIN_DIR && (0, import_node_fs.existsSync)((0, import_node_path.join)(process.env.ORCA_CLI_BIN_DIR, "orca"))) return (0, import_node_path.join)(process.env.ORCA_CLI_BIN_DIR, "orca");
  return "orca";
}
function runOrca(args, timeoutMs) {
  return new Promise((resolve) => {
    (0, import_node_child_process.execFile)(orcaCli(), [...args, "--json"], { env: process.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed = null;
      try {
        const text = String(stdout).trim();
        parsed = JSON.parse(text.startsWith("{") ? text : text.slice(text.lastIndexOf("\n{") + 1));
      } catch {
        parsed = null;
      }
      if (parsed?.ok) return resolve({ ok: true, result: parsed.result });
      resolve({ ok: false, error: parsed?.error?.message ?? (String(stderr).trim() || error?.message || "orca CLI failed"), code: parsed?.error?.code });
    });
  });
}
function send(path, request) {
  return new Promise((resolve) => {
    const socket = (0, import_node_net.connect)(path);
    let buffer = "";
    let reply = null;
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
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.kind === "exec" && typeof message.id === "number" && Array.isArray(message.args)) {
          const id = message.id;
          void runOrca(message.args, message.timeoutMs ?? 12e4).then((answer) => {
            if (!socket.destroyed) socket.write(JSON.stringify({ kind: "exec-result", id, ...answer }) + "\n");
          });
        } else if (typeof message.text === "string") {
          reply = { text: message.text, isError: message.isError === true };
        }
      }
    });
    socket.on("close", () => {
      if (!reply && buffer.trim()) {
        try {
          const last = JSON.parse(buffer);
          if (typeof last.text === "string") reply = { text: last.text, isError: last.isError === true };
        } catch {
        }
      }
      if (reply) resolve({ kind: "reply", text: reply.text, isError: reply.isError });
      else resolve(connected ? { kind: "dropped" } : { kind: "unreachable" });
    });
    socket.on("error", () => void 0);
  });
}
void main().then((code) => process.exit(code));
