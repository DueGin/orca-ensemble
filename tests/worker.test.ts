import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { OrcaAdapter, type OrcaWorker } from "../src/worker/adapter";
import { handleShim, initCollaboration, onAgentStatus } from "../src/worker/collab";
import { LAUNCH_MARKER, onAgentLaunch, parseDirective, shellQuote, shellWords, type HookDeps } from "../src/worker/hooks";
import { Store, type LeadSession } from "../src/worker/store";
import { lastReplyFromScreen, typedAfter } from "../src/worker/transcripts";
import { checkTeam, type Team } from "../src/shared/team";

const worker: OrcaWorker = {
  api: { major: 1, minor: 9 },
  host: { call: async <T,>() => ({}) as T, has: () => true },
  commands: { register: () => ({ dispose() {} }) },
  events: { on: () => ({ dispose() {} }) },
  hooks: { on: () => ({ dispose() {} }) },
  panels: { handle: () => ({ dispose() {} }), post() {} },
  storage: { get: async () => null, set: async () => undefined },
  settings: { get: async () => null },
  log() {},
};

/** Orca without Orca: launches become terminal ids, sends are recorded, every agent is alive. */
class FakeOrca extends OrcaAdapter {
  launched: { terminalId: string; agent: string; model?: string; prompt: string }[] = [];
  sent: { terminalId: string; text: string }[] = [];
  private next = 1;
  constructor() {
    super(worker);
  }
  override async launch(input: { path: string; agent: string; model?: string; effort?: string; prompt: string }) {
    const terminalId = `term_m${this.next++}`;
    this.launched.push({ terminalId, agent: input.agent, model: input.model, prompt: input.prompt });
    this.agents.set(terminalId, { terminalId, title: null, agent: input.agent, state: "working", stateStartedAt: Date.now(), workspaceId: "w", at: Date.now() });
    return { terminalId };
  }
  override async send(terminalId: string, text: string) {
    this.sent.push({ terminalId, text });
    this.noteWorking(terminalId);
    return true;
  }
  override async listAgents() {
    return [...this.agents.values()];
  }
  override async terminalAlive() {
    return true;
  }
  override async readTerminal() {
    return [] as string[];
  }
  override async runCli<T>(): Promise<T> {
    return {} as T;
  }
  idle(terminalId: string) {
    const row = this.agents.get(terminalId)!;
    this.agents.set(terminalId, { ...row, state: "done", at: Date.now() });
  }
}

const team = (mode: Team["mode"]): Team => {
  const checked = checkTeam({
    version: 1,
    name: "notes",
    mode,
    lead: { agent: "claude", model: "haiku" },
    roles: [
      { name: "writer", agent: "claude", model: "haiku", folders: ["notes"], instructions: "Writes notes." },
      { name: "checker", agent: "codex", model: "gpt-5.5", folders: ["checks"], instructions: "Writes checks." },
    ],
  });
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  return checked.team;
};

let fake: FakeOrca;
let store: Store;
let root: string;

const lead = (mode: Team["mode"], language: "en" | "zh" = "en"): LeadSession => ({
  terminalId: "lead1",
  workspaceId: "w",
  path: root,
  projectId: null,
  projectName: "proj",
  source: { kind: "inline" },
  team: team(mode),
  language,
  mode: null,
  locked: null,
  roles: [],
  brief: null,
  agentSessionId: null,
  createdAt: new Date().toISOString(),
  endedAt: null,
});

const shim = (terminalId: string, command: string, input: unknown = {}) => handleShim({ command, input, terminalId, workspaceId: "w", userDataPath: null, cwd: root });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "oat-"));
  fake = new FakeOrca();
  store = new Store(join(root, ".data"));
  await store.load();
  initCollaboration(fake, store, async (session) => ({ team: session.team, source: "the test team" }));
});

describe("agent-team for terminals outside a team", () => {
  it("refuses, and says how to start a team", async () => {
    const reply = await shim("term_x", "status");
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("@team");
  });
});

describe("delegation through agent-team", () => {
  it("starts members on their own agents and models, takes their reports, and gives them to the lead", async () => {
    await store.setLead(lead("delegation"));
    const status = await shim("lead1", "status");
    expect(status.isError).toBe(false);
    expect(status.text).toContain("You are the lead of an agent team in Orca");
    expect((await shim("lead1", "status")).text).not.toContain("You are the lead of an agent team in Orca");

    const delegated = await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }, { role: "checker", task: "Write checks/a.check" }], title: "Docs" });
    expect(delegated.isError).toBe(false);
    expect(fake.launched.map((entry) => [entry.agent, entry.model])).toEqual([["claude", "haiku"], ["codex", "gpt-5.5"]]);
    // Each launch carries the marker the launch hook ties to its terminal; codex gets its standing instructions inline.
    expect(fake.launched.every((entry) => LAUNCH_MARKER.test(entry.prompt))).toBe(true);
    expect(fake.launched[1]!.prompt).toContain('You are the "checker" member');
    expect(store.members().map((member) => member.role).sort()).toEqual(["checker", "writer"]);

    const [writer, checker] = fake.launched.map((entry) => entry.terminalId) as [string, string];
    expect((await shim(writer, "report", { result: "Wrote notes/a.txt" })).isError).toBe(false);
    // Plain words, as the CLI sends them.
    expect((await shim(checker, "report", { text: "Wrote checks/a.check", message: "Wrote checks/a.check", result: "Wrote checks/a.check" })).isError).toBe(false);
    const run = store.leadRun("lead1", false)!;
    expect(run.members.map((member) => [member.title.split("#")[0], member.state, member.result])).toEqual([["writer", "done", "Wrote notes/a.txt"], ["checker", "done", "Wrote checks/a.check"]]);

    const waited = await shim("lead1", "wait", { timeoutSeconds: 5 });
    expect(waited.text).toContain("Every member has finished");
    expect(waited.text).toContain("Wrote checks/a.check");
    const flow = store.get(run.id)!.events.map((event) => `${event.component}:${event.action}`);
    expect(flow).toEqual(expect.arrayContaining(["split:split", "split:assign", "contexts:start", "reports:report", "reports:collect"]));
  });

  it("refuses delegation in a session set to none, and locks an auto session to its first run's mode", async () => {
    await store.setLead({ ...lead("none") });
    expect((await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "x" }] })).isError).toBe(true);
    await store.setLead({ ...lead("auto") });
    expect((await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "x" }] })).isError).toBe(false);
    expect(store.lead("lead1")!.locked).toBe("delegation");
  });

  it("explains a bad input with the command's fields", async () => {
    await store.setLead(lead("delegation"));
    const reply = await shim("lead1", "delegate", { tasks: [] });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("tasks");
    expect((await shim("lead1", "help", { command: "delegate" })).text).toContain("tasks: object[]");
    expect((await shim("lead1", "nope")).text).toContain("Unknown command");
  });

  it("answers in Chinese for a Chinese team", async () => {
    await store.setLead(lead("delegation", "zh"));
    const reply = await shim("lead1", "delegate", { tasks: [{ role: "nobody", task: "x" }] });
    expect(reply.text).toContain("未知角色");
  });
});

describe("team mode through agent-team", () => {
  it("needs a brief and the user's confirmation, then fills the board and starts the roles", async () => {
    await store.setLead(lead("team"));
    expect((await shim("lead1", "kickoff", { userConfirmation: "yes" })).text).toContain("No brief is recorded");
    const recorded = await shim("lead1", "brief", {
      brief: { title: "Todo", goal: "A todo list", requirements: ["three items"], acceptance: ["three lines"] },
      tasks: [{ title: "Write the list", role: "writer", files: ["notes/todo.txt"] }, { title: "Write the checks", role: "checker", after: [1] }],
    });
    expect(recorded.isError).toBe(false);
    // Confirmation that isn't the user's: refused.
    expect((await shim("lead1", "kickoff", { userConfirmation: "go ahead" })).isError).toBe(true);
    // The user pressed Confirm in the panel.
    await store.setPendingBrief("lead1", { ...store.pendingBrief("lead1")!, confirmedBy: "panel" });
    const started = await shim("lead1", "kickoff", { userConfirmation: "confirmed in panel" });
    expect(started.isError).toBe(false);
    const run = store.leadRun("lead1", true)!;
    expect(run.mode).toBe("team");
    expect(run.tasks.map((task) => [task.id, task.role, task.state])).toEqual([["T1", "writer", "todo"], ["T2", "checker", "todo"]]);
    expect(run.posts[0]).toMatchObject({ author: "lead", kind: "brief" });

    const writer = fake.launched.find((entry) => entry.prompt.includes('You are "writer"'))!.terminalId;
    const claimed = await shim(writer, "task", { action: "claim" });
    expect(claimed.text).toContain("T1 is yours");
    expect((await shim(writer, "task", { action: "done", id: "T1", result: "wrote three lines" })).text).toContain("T1 is done");
    const posted = await shim(writer, "post", { kind: "question", text: "Which format?", to: ["lead"] });
    expect(posted.isError).toBe(false);
    // The lead hears it in its next command.
    expect((await shim("lead1", "board")).text).toContain("Which format?");
    expect(store.get(run.id)!.tasks.find((task) => task.id === "T1")!.state).toBe("done");
  });
});

describe("Orca status", () => {
  it("doesn't end a member's turn on the idle status it reports while starting", async () => {
    await store.setLead(lead("delegation"));
    await shim("lead1", "delegate", { tasks: [{ role: "checker", task: "Write checks/a.check" }] });
    const checker = fake.launched[0]!.terminalId;
    fake.idle(checker);
    await onAgentStatus({ terminalId: checker, state: "done" });
    expect(store.leadRun("lead1", true)!.members[0]!.state).toBe("working");
  });
});

describe("the launch hook", () => {
  const deps = (): HookDeps => ({ orca: worker, store, pluginRoot: "/plugins/agent-team", socket: "/tmp/s.sock", nodeBin: "/bin/node", settings: async () => ({ directive: true, defaultTeam: "", language: "auto" }), locale: () => "en" });

  it("quotes and splits commands as a shell does", () => {
    const words = ["claude", "--model", "haiku", "it's \"fine\"\nline two"];
    expect(shellWords(words.map(shellQuote).join(" "))).toEqual(words);
    expect(shellWords(`claude '--dangerously-skip-permissions' 'a'\\''b'`)).toEqual(["claude", "--dangerously-skip-permissions", "a'b"]);
  });

  it("puts agent-team on every agent's PATH", async () => {
    const event = await onAgentLaunch(deps(), { agent: "codex", workspaceId: "p::/repo", terminalId: "t1", command: "codex", env: {} });
    expect(event.env.PATH?.startsWith("/plugins/agent-team/bin:")).toBe(true);
    expect(event.env.AGENT_TEAM_SOCKET).toBe("/tmp/s.sock");
  });

  it("ties a launch to its terminal, drops the marker, and gives Claude its standing instructions", async () => {
    await store.addLaunch({ id: "L0000ABCD", kind: "member", prompt: "the task", systemPrompt: "You are writer", member: { leadTerminalId: "lead1", role: "writer", agent: "claude", model: "haiku", title: "writer#1" }, createdAt: new Date().toISOString() });
    const event = await onAgentLaunch(deps(), { agent: "claude", workspaceId: "p::/repo", terminalId: "t9", command: `claude '--model' 'haiku' '[ensemble:L0000ABCD]\nthe task'`, env: {} });
    expect(shellWords(event.command)).toEqual(["claude", "--model", "haiku", "--append-system-prompt", "You are writer", "the task"]);
    expect(store.member("t9")?.role).toBe("writer");
  });

  it("turns a new agent whose first prompt starts with @team into a lead", async () => {
    const repo = mkdtempSync(join(tmpdir(), "oat-repo-"));
    mkdirSync(join(repo, ".agents", "teams"), { recursive: true });
    writeFileSync(join(repo, ".agents", "teams", "web.team.json"), JSON.stringify(team("auto")));
    expect(parseDirective("@team web delegation\nAdd a toggle")).toEqual({ name: "web", mode: "delegation", request: "Add a toggle" });
    const event = await onAgentLaunch(deps(), { agent: "claude", workspaceId: `p::${repo}`, terminalId: "t5", command: `claude '@team web delegation\nAdd a dark mode toggle'`, env: {} });
    const words = shellWords(event.command);
    expect(words.at(-1)).toContain("You are the lead of the agent team");
    expect(words.at(-1)).toContain("Add a dark mode toggle");
    expect(words).toContain("--append-system-prompt");
    const session = store.lead("t5")!;
    expect(session.source).toEqual({ kind: "file", file: ".agents/teams/web.team.json" });
    expect(session.mode).toBe("delegation");
  });
});

describe("reading screens", () => {
  it("takes an agent's last reply without the TUI around it", () => {
    const screen = ["❯ do it", "⏺ Working on it.", "  ran 1 command", "⏺ Done: wrote notes/a.txt.", "  Checked with cat.", "✻ Baked for 3s", "────────", "❯ ", "────────", "  ⏵⏵ bypass permissions on"];
    expect(lastReplyFromScreen(screen)).toBe("Done: wrote notes/a.txt.\n  Checked with cat.");
  });

  it("finds what the user typed after the brief was shown", () => {
    const before = ["⏺ Here is the brief.", "  Please confirm."];
    const after = [...before, "❯ Confirmed, go ahead with", "  exactly that brief.", "⏺ Starting the team."];
    expect(typedAfter(after, before).map((message) => message.text)).toEqual(["Confirmed, go ahead with exactly that brief."]);
    expect(typedAfter(before, before)).toEqual([]);
  });
});
