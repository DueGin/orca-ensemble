// `agent-team`: how the lead and members reach the plugin from their shell. It sends one request to the plugin's worker
// over its socket, prints the answer and exits non-zero on an error.
//   agent-team <command> '<json>'      agent-team <command> - <<'JSON' ... JSON      agent-team help [command]
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
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
    terminalId: process.env.ORCA_TERMINAL_HANDLE ?? null,
    workspaceId: process.env.ORCA_WORKSPACE_ID ?? process.env.ORCA_WORKTREE_ID ?? null,
    userDataPath: process.env.ORCA_USER_DATA_PATH ?? null,
    cwd: process.cwd(),
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
    process.stderr.write("agent-team: the Agent Team plugin is not running in Orca (enable it in Settings → Plugins), so the team can't be reached.\n");
    return 2;
  }
}

/** One request over the socket: the plugin's reply, the connection dropped before one, or no plugin listening. */
function send(path: string, request: unknown): Promise<{ kind: "reply"; text: string; isError: boolean } | { kind: "dropped" } | { kind: "unreachable" }> {
  return new Promise((resolve) => {
    const socket = connect(path);
    let reply = "";
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
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("close", () => {
      try {
        const response = JSON.parse(reply) as { text: string; isError: boolean };
        resolve({ kind: "reply", text: response.text, isError: response.isError });
      } catch {
        resolve(connected ? { kind: "dropped" } : { kind: "unreachable" });
      }
    });
    socket.on("error", () => undefined);
  });
}

void main().then((code) => process.exit(code));
