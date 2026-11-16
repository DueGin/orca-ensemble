// The worker's view of Orca: the host API it was granted, plus Orca's own CLI for what the host API leaves out (typing
// into a terminal of a workspace that isn't focused, launching an agent with a model and effort). The CLI is the one
// Orca ships beside the worker's own executable, aimed at the same Orca profile.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/** The `orca` object Orca passes to the worker's activate(). Only what this plugin uses. */
export interface OrcaWorker {
  api: { major: number; minor: number };
  host: { call<T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<T>; has(method: string): boolean };
  commands: { register(id: string, handler: (args: unknown) => unknown): { dispose(): void } };
  events: { on(event: string, handler: (payload: any) => unknown): { dispose(): void } };
  hooks: { on(hook: string, handler: (event: any, next: (event: any) => unknown) => unknown): { dispose(): void } };
  panels: { handle(name: string, handler: (input: any, context: { panel?: string; signal?: AbortSignal }) => unknown): { dispose(): void }; post(name: string, data: unknown, options?: { panel?: string }): void };
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; onDidChange?(handler: (change: { key: string }) => void): { dispose(): void } };
  settings: { get(key: string): Promise<unknown> };
  log(message: string): void;
}

export type AgentState = "working" | "blocked" | "waiting" | "done";

export interface AgentRow {
  terminalId: string | null;
  title: string | null;
  agent: string | null;
  state: AgentState;
  stateStartedAt: number;
  sessionId?: string | null;
}

export interface WorkspaceRow {
  id: string;
  kind: "worktree" | "folder";
  name: string;
  project?: string | null;
  projectId?: string | null;
  path: string;
  branch: string | null;
  hostId: string | null;
}

/** The Orca profile folder Orca was started with: its --user-data-dir, else the platform default. */
function profileFromParent(): string | null {
  if (platform() === "win32") return null;
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8" });
    const match = args.match(/--user-data-dir=(\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function defaultProfile(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "orca");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "orca");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "orca");
}

/** The `orca` CLI Orca ships beside the worker's executable (macOS: Contents/Resources/bin/orca). */
function cliBeside(execPath: string): string | null {
  const marker = ".app/Contents/";
  const at = execPath.indexOf(marker);
  if (at >= 0) {
    const cli = join(execPath.slice(0, at + marker.length), "Resources", "bin", "orca");
    if (existsSync(cli)) return cli;
  }
  for (let dir = dirname(execPath), depth = 0; depth < 5; dir = dirname(dir), depth += 1) {
    for (const candidate of [join(dir, "resources", "bin", "orca"), join(dir, "bin", "orca")]) if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class OrcaAdapter {
  /** Agents by terminal id, kept from agent.status.changed and agents.list. */
  readonly agents = new Map<string, AgentRow & { workspaceId: string | null; workspaceListId?: string; at: number }>();
  private cli: string | null;
  private profile: string | null;

  constructor(readonly orca: OrcaWorker) {
    this.cli = cliBeside(process.execPath);
    this.profile = profileFromParent();
  }

  /** The profile an agent's shell reported; it wins over a guess. */
  learnProfile(userDataPath: string | null | undefined): void {
    if (userDataPath && userDataPath !== this.profile) this.profile = userDataPath;
  }

  get cliPath(): string | null {
    return this.cli;
  }

  /** Runs `orca <args> --json` against the plugin's Orca; resolves with its `result`. */
  runCli<T = any>(args: string[], timeoutMs = 60_000): Promise<T> {
    const cli = this.cli;
    if (!cli) return Promise.reject(new Error("The orca CLI was not found next to Orca."));
    const env: NodeJS.ProcessEnv = { HOME: homedir(), PATH: `${dirname(cli)}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: process.env.TMPDIR ?? "/tmp", ORCA_USER_DATA_PATH: this.profile ?? defaultProfile() };
    return new Promise((resolve, reject) => {
      execFile("/bin/bash", [cli, ...args, "--json"], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // Not JSON: fall through to the error below.
        }
        if (parsed?.ok) return resolve(parsed.result as T);
        const message = parsed?.error?.message ?? error?.message ?? (String(stdout).trim() || "orca CLI failed");
        reject(new Error(message));
      });
    });
  }

  // ----- Agents and terminals

  noteStatus(payload: { terminalId?: string; workspaceId: string | null; workspaceListId?: string; title?: string; state: AgentState; sessionId?: string; mainAgent?: { stateStartedAt: number } }): void {
    if (!payload.terminalId) return;
    const was = this.agents.get(payload.terminalId);
    this.agents.set(payload.terminalId, {
      terminalId: payload.terminalId,
      title: payload.title ?? was?.title ?? null,
      agent: was?.agent ?? null,
      state: payload.state,
      stateStartedAt: payload.mainAgent?.stateStartedAt ?? Date.now(),
      sessionId: payload.sessionId ?? was?.sessionId ?? null,
      workspaceId: payload.workspaceId,
      workspaceListId: payload.workspaceListId ?? was?.workspaceListId,
      at: Date.now(),
    });
  }

  /** Marks an agent working: it is running a command, so it is in a turn. */
  noteWorking(terminalId: string): void {
    const was = this.agents.get(terminalId);
    if (was) this.agents.set(terminalId, { ...was, state: "working", at: Date.now() });
  }

  stateOf(terminalId: string): AgentState | null {
    return this.agents.get(terminalId)?.state ?? null;
  }

  /** Idle: waiting for input. Unknown counts as not idle, so nothing is typed into an agent mid-turn. */
  isIdle(terminalId: string): boolean {
    const state = this.stateOf(terminalId);
    return state === "done" || state === "waiting";
  }

  /** Agents of a workspace. Before host API 1.10, agents.list knows only the focused workspace. */
  async listAgents(workspaceId?: string): Promise<AgentRow[]> {
    const scoped = workspaceId && (this.orca.api.major > 1 || this.orca.api.minor >= 10);
    try {
      const result = await this.orca.host.call<{ agents: AgentRow[] }>("agents.list", scoped ? { workspaceId } : {});
      if (scoped || !workspaceId) return result.agents;
      const focused = await this.focusedWorkspace().catch(() => null);
      const same = (a?: string | null, b?: string | null) => !!a && !!b && (a === b || a.endsWith(`::${b.split("::").pop()}`) || b.endsWith(`::${a.split("::").pop()}`));
      return focused?.workspaceId && same(focused.workspaceId, workspaceId) ? result.agents : [];
    } catch {
      return [];
    }
  }

  /**
   * An agent's state when no status event told it yet (the worker just started, or its workspace isn't focused):
   * idle when its terminal printed nothing for a while, else working. Cached for 10 s; null when the terminal is gone.
   */
  private probes = new Map<string, { at: number; state: AgentState | null }>();
  async probeState(terminalId: string): Promise<AgentState | null> {
    const known = this.agents.get(terminalId);
    if (known) return known.state;
    const cached = this.probes.get(terminalId);
    if (cached && Date.now() - cached.at < 10_000) return cached.state;
    let state: AgentState | null = null;
    try {
      const result = await this.runCli<{ terminal: { connected?: boolean; lastOutputAt?: number; agentIdentity?: string | null } }>(["terminal", "show", "--terminal", terminalId], 15_000);
      const quiet = Date.now() - (result.terminal.lastOutputAt ?? 0);
      state = result.terminal.connected === false ? null : quiet > 15_000 ? "done" : "working";
    } catch {
      state = null;
    }
    this.probes.set(terminalId, { at: Date.now(), state });
    return state;
  }

  async listWorkspaces(): Promise<WorkspaceRow[]> {
    const result = await this.orca.host.call<{ workspaces: WorkspaceRow[] }>("workspace.list", {});
    return result.workspaces;
  }

  async focusedWorkspace(): Promise<{ workspaceId?: string; branch: string; displayName: string; terminals: { id: string; title?: string }[] } | null> {
    return this.orca.host.call("workspace.readContext", {});
  }

  async readTerminal(terminalId: string, maxLines = 400): Promise<string[]> {
    try {
      const result = await this.orca.host.call<{ lines: string[] }>("terminal.read", { terminalId, maxLines });
      return result.lines;
    } catch {
      return [];
    }
  }

  /** Whether the terminal still runs; a closed one is gone for good. */
  async terminalAlive(terminalId: string): Promise<boolean> {
    try {
      const result = await this.runCli<{ terminal: { status: string } }>(["terminal", "show", "--terminal", terminalId], 15_000);
      return result.terminal.status !== "exited";
    } catch (error) {
      return !/not.found|unknown|no terminal|exited/i.test(String((error as Error).message));
    }
  }

  /** Types text into an agent and submits it, when it is idle; returns whether it went in. */
  async sendIfIdle(terminalId: string, text: string): Promise<boolean> {
    if (!this.isIdle(terminalId)) return false;
    return this.send(terminalId, text);
  }

  /** Types text into an agent's terminal and submits it, wherever the terminal is. */
  async send(terminalId: string, text: string): Promise<boolean> {
    try {
      const result = await this.runCli<{ send: { accepted: boolean } }>(["terminal", "send", "--terminal", terminalId, "--text", text, "--enter"], 30_000);
      if (result.send.accepted) this.noteWorking(terminalId);
      return result.send.accepted;
    } catch {
      // The host API reaches a terminal of the focused workspace without the CLI.
      try {
        const result = await this.orca.host.call<{ accepted: boolean }>("terminal.sendText", { terminalId, text, enter: true });
        if (result.accepted) this.noteWorking(terminalId);
        return result.accepted;
      } catch {
        return false;
      }
    }
  }

  /** Starts an agent CLI in a terminal of the workspace at `path`, with an optional model, effort and first prompt. */
  async launch(input: { path: string; agent: string; model?: string; effort?: string; prompt: string; focus?: boolean }): Promise<{ terminalId: string }> {
    const args = ["agent", "launch", "--agent", input.agent, "--worktree", `path:${input.path}`, "--surface", "terminal", "--prompt", input.prompt];
    if (input.model) args.push("--model", input.model);
    if (input.model && input.effort) args.push("--effort", input.effort);
    if (input.focus) args.push("--focus");
    const result = await this.runCli<{ outcome: { kind: string; handle?: string }; agentTerminalHandle?: string }>(args, 120_000);
    const terminalId = result.outcome?.handle ?? result.agentTerminalHandle;
    if (!terminalId) throw new Error(`Orca did not start ${input.agent} in a terminal.`);
    this.agents.set(terminalId, { terminalId, title: null, agent: input.agent, state: "working", stateStartedAt: Date.now(), workspaceId: null, at: Date.now() });
    return { terminalId };
  }

  /** Creates a worktree workspace in a project and starts the lead in it; returns the lead's terminal. */
  async createWorkspace(input: { projectPath: string; name: string; agent: string; model?: string; effort?: string; prompt: string; baseBranch?: string }): Promise<{ terminalId: string; workspaceId: string; path: string }> {
    const args = ["worktree", "create", "--repo", `path:${input.projectPath}`, "--name", input.name, "--agent", input.agent, "--surface", "terminal", "--prompt", input.prompt, "--activate"];
    if (input.model) args.push("--model", input.model);
    if (input.model && input.effort) args.push("--effort", input.effort);
    if (input.baseBranch) args.push("--base-branch", input.baseBranch);
    const result = await this.runCli<{ worktree: { id: string; path: string }; launch?: { outcome?: { handle?: string } }; agentTerminalHandle?: string }>(args, 180_000);
    const terminalId = result.launch?.outcome?.handle ?? result.agentTerminalHandle;
    if (!terminalId) throw new Error("Orca created the workspace but did not start the lead in a terminal.");
    return { terminalId, workspaceId: result.worktree.id, path: result.worktree.path };
  }

  async focusTerminal(terminalId: string): Promise<void> {
    await this.orca.host.call("terminal.focus", { terminalId }).catch(() => this.runCli(["terminal", "switch", "--terminal", terminalId]).catch(() => undefined));
  }

  async closeTerminal(terminalId: string): Promise<void> {
    await this.orca.host.call("terminal.close", { terminalId }).catch(() => this.runCli(["terminal", "close", "--terminal", terminalId]).catch(() => undefined));
  }

  async notify(title: string, body?: string): Promise<void> {
    await this.orca.host.call("notifications.show", { title, ...(body ? { body: body.slice(0, 1000) } : {}) }).catch(() => undefined);
  }

  async openFile(workspaceId: string, path: string): Promise<void> {
    await this.orca.host.call("editor.open", { workspaceId, path });
  }
}
