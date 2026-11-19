// `agent-team`: how the lead and members reach the plugin from their shell. It sends one request to the plugin's worker
// over its socket, prints the answer and exits non-zero on an error.
//   agent-team <command> '<json>'      agent-team <command> - <<'JSON' ... JSON      agent-team help [command]
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { callerHandle } from "../shared/agents";
import { socketPath } from "../shared/paths";

function pluginRoot(): string {
  const here = dirname(realpathSync(process.argv[1] ?? __filename));
  return realpathSync(join(here, ".."));
}

function readStdin(waitMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => finish(), waitMs);
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
      timer = setTimeout(finish, 2000);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const rest = args.slice(1);
  let input: unknown = {};
  const parse = (text: string): unknown => {
    const trimmed = text.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      // Plain words: a help topic, or text for the command.
      return command === "help" ? { command: trimmed } : { text: trimmed, message: trimmed, result: trimmed };
    }
  };
  if (rest.length && rest[0] !== "-") input = parse(rest.join(" "));
  else input = parse(await readStdin(rest[0] === "-" ? 30_000 : 400));
  const request = {
    command,
    input,
    // A terminal's handle, or the chat whose shell runs this (ORCA_AGENT_SESSION_ID names it).
    terminalId: callerHandle(process.env),
    workspaceId: process.env.ORCA_WORKSPACE_ID ?? process.env.ORCA_WORKTREE_ID ?? null,
    userDataPath: process.env.ORCA_USER_DATA_PATH ?? null,
    cwd: process.cwd(),
    // This command can run Orca's CLI for the plugin, as this agent (see runOrca).
    protocol: 2,
  };
  const path = process.env.AGENT_TEAM_SOCKET || socketPath(pluginRoot());
  // Reading commands are safe to send again when the plugin restarted under them (Orca reloads it on updates).
  const safe = new Set(["help", "status", "wait", "board", "read"]);
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await send(path, request);
    if (outcome.kind === "reply") {
      (outcome.isError ? process.stderr : process.stdout).write(outcome.text.endsWith("\n") ? outcome.text : `${outcome.text}\n`);
      return outcome.isError ? 1 : 0;
    }
    const retry = safe.has(command) && attempt < 8;
    if (outcome.kind === "dropped" && retry) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (outcome.kind === "unreachable" && retry && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (outcome.kind === "dropped") {
      process.stderr.write(`agent-team: the plugin restarted while running "${command}". It may or may not have been done: run \`agent-team status\` to check before trying again.\n`);
      return 3;
    }
    process.stderr.write("agent-team: the Ensemble plugin is not running in Orca (enable it in Settings → Plugins), so the team can't be reached.\n");
    return 2;
  }
}

/** Orca's CLI as this agent's shell finds it: the one Orca names, else the one beside it, else `orca` on the PATH. */
function orcaCli(): string {
  if (process.env.ORCA_CLI_COMMAND && existsSync(process.env.ORCA_CLI_COMMAND)) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_CLI_BIN_DIR && existsSync(join(process.env.ORCA_CLI_BIN_DIR, "orca"))) return join(process.env.ORCA_CLI_BIN_DIR, "orca");
  return "orca";
}

/**
 * Runs `orca <args> --json` for the plugin, in this shell with this agent's environment: Orca then knows this agent as
 * the one acting (a launch shows in its chat as a handoff; orchestration takes it as the sender).
 */
function runOrca(args: string[], timeoutMs: number): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }> {
  return new Promise((resolve) => {
    execFile(orcaCli(), [...args, "--json"], { env: process.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed: { ok?: boolean; result?: unknown; error?: { message?: string; code?: string } } | null = null;
      try {
        // Some commands print progress before the JSON: take the last JSON object.
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

/** One request over the socket: the plugin's reply, the connection dropped before one, or no plugin listening. */
function send(path: string, request: unknown): Promise<{ kind: "reply"; text: string; isError: boolean } | { kind: "dropped" } | { kind: "unreachable" }> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let buffer = "";
    let reply: { text: string; isError: boolean } | null = null;
    let connected = false;
    socket.setEncoding("utf8");
    socket.setTimeout(620_000, () => {
      socket.destroy();
      resolve({ kind: "dropped" });
    });
    socket.on("connect", () => {
      connected = true;
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message: { kind?: string; id?: number; args?: string[]; timeoutMs?: number; text?: string; isError?: boolean };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.kind === "exec" && typeof message.id === "number" && Array.isArray(message.args)) {
          const id = message.id;
          void runOrca(message.args, message.timeoutMs ?? 120_000).then((answer) => {
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
          const last = JSON.parse(buffer) as { text: string; isError: boolean };
          if (typeof last.text === "string") reply = { text: last.text, isError: last.isError === true };
        } catch {
          // Not a reply.
        }
      }
      if (reply) resolve({ kind: "reply", text: reply.text, isError: reply.isError });
      else resolve(connected ? { kind: "dropped" } : { kind: "unreachable" });
    });
    socket.on("error", () => undefined);
  });
}

void main().then((code) => process.exit(code));
