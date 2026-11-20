import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrcaAdapter, type OrcaWorker } from "../src/worker/adapter";
import { handleShim, initCollaboration, onAgentStatus } from "../src/worker/collab";
import { LAUNCH_MARKER, onAgentLaunch, parseDirective, shellQuote, shellWords, type HookDeps } from "../src/worker/hooks";
import { detectOrchestration, resetOrchestrationSupport } from "../src/worker/orchestra";
import { Store, type LeadSession } from "../src/worker/store";
import { lastReplyFromScreen, typedAfter } from "../src/worker/transcripts";
import { createRun, finishMember, upsertMember, type Run } from "../src/shared/collab";
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
  launched: { terminalId: string; agent: string; model?: string; prompt: string; surface: string }[] = [];
  sent: { terminalId: string; text: string }[] = [];
  private next = 1;
  constructor() {
    super(worker);
  }
  override async launch(input: { path: string; agent: string; model?: string; effort?: string; prompt: string; surface?: "chat" | "terminal" }) {
    const terminalId = `term_m${this.next++}`;
    const surface = input.surface ?? "terminal";
    this.launched.push({ terminalId, agent: input.agent, model: input.model, prompt: input.prompt, surface });
    this.agents.set(terminalId, { terminalId, title: null, agent: input.agent, state: "working", stateStartedAt: Date.now(), workspaceId: "w", at: Date.now() });
    return { terminalId, surface };
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
  override async runCli<T>(_args?: string[]): Promise<T> {
    return {} as T;
  }
  /** Help and other non-JSON probes answer like any other call (the CLI is "there"). */
  override async rawCli(args: string[]): Promise<string> {
    await this.runCli(args);
    return "";
  }
  override async piModels() {
    return ["fluxcode-国模/deepseek-v4.1-flash", "fluxcode-国模/qwen-max"];
  }
  idle(terminalId: string) {
    const row = this.agents.get(terminalId)!;
    this.agents.set(terminalId, { ...row, state: "done", at: Date.now() });
  }
}

/** Orca from before its orchestration: every verb is unknown to it. */
class PlainOrca extends FakeOrca {
  override async runCli<T>(args: string[]): Promise<T> {
    if (args[0] === "orchestration") throw new Error(`error: unknown command 'orchestration'`);
    return super.runCli<T>(args);
  }
}

/** An orca CLI that can't be run at all (not found, or every call fails): each call rejects. */
class OfflineOrca extends FakeOrca {
  calls: string[][] = [];
  override async runCli<T>(args: string[]): Promise<T> {
    this.calls.push(args);
    throw new Error("The orca CLI was not found next to Orca.");
  }
}

/** The CLI verb of a call, such as "orchestration send". */
const verb = (args: string[]) => args.slice(0, 2).join(" ");

/**
 * Orca with its orchestration: the CLI answers per verb from `responses` (a value, or a function of the call's args,
 * which may throw); a verb without one answers `{}`, so the support probe (`worker-start --help`) succeeds.
 */
class OrchestratingOrca extends FakeOrca {
  responses = new Map<string, unknown>();
  calls: string[][] = [];
  override async runCli<T>(args: string[]): Promise<T> {
    this.calls.push(args);
    const head = verb(args);
    if (this.responses.has(head)) {
      const answer = this.responses.get(head);
      if (typeof answer === "function") return (answer as (args: string[]) => unknown)(args) as T;
      return answer as T;
    }
    return {} as T;
  }
  /** The calls of one verb, without the support probe (`--help`). */
  callsOf(head: string): string[][] {
    return this.calls.filter((args) => verb(args) === head && !args.includes("--help"));
  }
}

const team = (mode: Team["mode"]): Team => {
  const checked = checkTeam({
    version: 1,
    name: "notes",
    mode,
    lead: { agent: "claude", model: "haiku", surface: "terminal" },
    roles: [
      { name: "writer", agent: "claude", model: "haiku", folders: ["notes"], instructions: "Writes notes.", surface: "terminal" },
      { name: "checker", agent: "codex", model: "gpt-5.5", folders: ["checks"], instructions: "Writes checks.", surface: "terminal" },
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
  initCollaboration(fake, store, async (session) => ({ team: session.team, source: "the test team" }), "/plugins/ensemble/bin/agent-team");
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
    // Members are named after their roles.
    expect(run.members.map((member) => [member.title, member.state, member.result])).toEqual([["writer", "done", "Wrote notes/a.txt"], ["checker", "done", "Wrote checks/a.check"]]);

    const waited = await shim("lead1", "wait", { timeoutSeconds: 5 });
    expect(waited.text).toContain("Every member has finished");
    expect(waited.text).toContain("Wrote checks/a.check");
    const flow = store.get(run.id)!.events.map((event) => `${event.component}:${event.action}`);
    expect(flow).toEqual(expect.arrayContaining(["split:split", "split:assign", "contexts:start", "reports:report", "reports:collect"]));
  });

  it("starts a member whose team asks for a chat as a chat, without the launch marker", async () => {
    const chatted = checkTeam({
      version: 1,
      name: "chat",
      mode: "delegation",
      lead: { agent: "claude", model: "haiku", surface: "terminal" },
      roles: [{ name: "writer", agent: "codex", model: "gpt-5.5", surface: "chat", folders: ["notes"], instructions: "Writes notes." }],
    });
    if (!chatted.ok) throw new Error(chatted.errors.join("\n"));
    await store.setLead({ ...lead("delegation"), team: chatted.team });
    const delegated = await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }], title: "Docs" });
    expect(delegated.isError).toBe(false);
    const launch = fake.launched[0]!;
    expect(launch.surface).toBe("chat");
    expect(LAUNCH_MARKER.test(launch.prompt)).toBe(false);
    expect(launch.prompt).toContain("'/plugins/ensemble/bin/agent-team' status");
    expect(delegated.text).toContain("- writer (codex/gpt-5.5): started");
    expect(store.member(launch.terminalId)?.surface).toBe("chat");
    expect(launch.prompt).toContain("Write notes/a.txt");
  });

  it("starts a pi member in a terminal even when its team asks for a chat, with the provider/id model", async () => {
    const piTeam = checkTeam({
      version: 1,
      name: "pi",
      mode: "delegation",
      lead: { agent: "claude", model: "haiku", surface: "terminal" },
      roles: [{ name: "writer", agent: "pi", model: "qwen-max", surface: "chat", folders: ["notes"], instructions: "Writes notes." }],
    });
    if (!piTeam.ok) throw new Error(piTeam.errors.join("\n"));
    await store.setLead({ ...lead("delegation"), team: piTeam.team });
    const delegated = await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }], title: "Docs" });
    expect(delegated.isError).toBe(false);
    const launch = fake.launched[0]!;
    // pi's chat starts and does nothing: always a terminal.
    expect(launch.surface).toBe("terminal");
    expect(LAUNCH_MARKER.test(launch.prompt)).toBe(true);
    // Orca gets the provider/id model; the bare team model was completed from the host's list.
    expect(launch.model).toBe("fluxcode-国模/qwen-max");
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

const pooled = (mode: Team["mode"]): Team => {
  const checked = checkTeam({
    version: 1,
    name: "pool",
    mode,
    lead: { agent: "claude", model: "haiku", surface: "terminal" },
    roles: [],
    candidates: [
      { name: "fast", agent: "claude", model: "haiku", surface: "terminal", notes: "Good at small edits." },
      { name: "gpt-5.5", agent: "codex", model: "gpt-5.5", surface: "terminal", notes: "Good at tests." },
    ],
  });
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  return checked.team;
};

describe("work for candidates", () => {
  it("goes under a job name: the role is formed on the candidate and its member is named after it", async () => {
    await store.setLead({ ...lead("delegation"), team: pooled("delegation") });
    const delegated = await shim("lead1", "delegate", { tasks: [{ role: "tester", candidate: "gpt-5.5", task: "Write checks/a.check" }], title: "Checks" });
    expect(delegated.isError).toBe(false);
    expect(delegated.text).toContain("- tester (codex/gpt-5.5): started");
    expect(fake.launched.map((entry) => [entry.agent, entry.model])).toEqual([["codex", "gpt-5.5"]]);
    expect(store.sessionRoles("lead1")).toMatchObject([{ name: "tester", candidate: "gpt-5.5", agent: "codex", model: "gpt-5.5", folders: [], instructions: "Good at tests." }]);
    const run = store.leadRun("lead1", false)!;
    expect(run.members.map((member) => [member.role, member.title])).toEqual([["tester", "tester"]]);
    // Later work for the job uses the role alone.
    await shim(fake.launched[0]!.terminalId, "report", { result: "Wrote checks/a.check" });
    expect((await shim("lead1", "delegate", { tasks: [{ role: "tester", task: "Write checks/b.check" }] })).isError).toBe(false);
  });

  it("refuses a candidate's own name as the role, and a formed role on another candidate", async () => {
    await store.setLead({ ...lead("delegation"), team: pooled("delegation") });
    const bare = await shim("lead1", "delegate", { tasks: [{ role: "gpt-5.5", task: "Write checks/a.check" }] });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain('gpt-5.5 is a candidate, not a job. Name the job in role (such as api, tester or docs) and the candidate in candidate: {"role": "tester", "candidate": "gpt-5.5"}.');
    expect((await shim("lead1", "delegate", { tasks: [{ role: "fast", candidate: "gpt-5.5", task: "x" }] })).text).toContain("fast is a candidate, not a job");
    expect((await shim("lead1", "delegate", { tasks: [{ role: "tester", candidate: "slow", task: "x" }] })).text).toContain('There is no candidate "slow"');
    expect(fake.launched).toEqual([]);
    expect(store.sessionRoles("lead1")).toEqual([]);
    await shim("lead1", "delegate", { tasks: [{ role: "tester", candidate: "gpt-5.5", task: "x" }] });
    expect((await shim("lead1", "delegate", { tasks: [{ role: "tester", candidate: "fast", task: "y" }] })).text).toContain("tester runs on gpt-5.5");
  });

  it("forms the roles a brief names with candidates when it is recorded", async () => {
    await store.setLead({ ...lead("team"), team: pooled("team") });
    const recorded = await shim("lead1", "brief", {
      brief: { title: "Todo", goal: "A todo list", requirements: ["three items"], acceptance: ["three lines"] },
      tasks: [{ title: "Write the list", role: "writer", candidate: "fast" }, { title: "Write the checks", role: "tester", candidate: "gpt-5.5", after: [1] }],
    });
    expect(recorded.isError).toBe(false);
    expect(store.sessionRoles("lead1").map((role) => [role.name, role.candidate])).toEqual([["writer", "fast"], ["tester", "gpt-5.5"]]);
    await store.setPendingBrief("lead1", { ...store.pendingBrief("lead1")!, confirmedBy: "panel" });
    expect((await shim("lead1", "kickoff", { userConfirmation: "confirmed in panel" })).isError).toBe(false);
    expect(store.leadRun("lead1", true)!.members.map((member) => member.title).sort()).toEqual(["tester", "writer"]);
    const refused = await shim("lead1", "brief", { brief: { title: "Again", goal: "g", requirements: ["r"], acceptance: ["a"] }, tasks: [{ title: "t", role: "fast" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("fast is a candidate, not a job");
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

describe("members that ride Orca's orchestration", () => {
  let on: OrchestratingOrca;
  let runs = 0;
  /**
   * A team run with one terminal member, dispatched a minute ago: its last round and no work left, so finishing the
   * member needs no next round.
   */
  const memberRun = async (terminalId: string, dispatchId?: string, surface: "chat" | "terminal" = "terminal"): Promise<Run> => {
    await store.setLead(lead("team"));
    const at = new Date(Date.now() - 60_000).toISOString();
    runs += 1;
    const run = await store.create({ ...createRun({ id: `run_probe${runs}`, leadAgentId: "lead1", workspaceId: "w", mode: "team", title: "t", rounds: 1, language: "en", now: at }), members: [] });
    await store.setMember({ terminalId, leadTerminalId: "lead1", role: "writer", agent: "claude", surface, title: "writer#1", createdAt: at, ...(dispatchId ? { dispatchId } : {}) });
    return store.mutate(run.id, (current) => upsertMember(current, { role: "writer", agentId: terminalId, title: "writer#1", task: "" }, at));
  };

  beforeEach(async () => {
    on = new OrchestratingOrca();
    resetOrchestrationSupport();
    root = mkdtempSync(join(tmpdir(), "oat-"));
    store = new Store(join(root, ".data"));
    await store.load();
    initCollaboration(on, store, async (session) => ({ team: session.team, source: "the test team" }), "/plugins/ensemble/bin/agent-team");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetOrchestrationSupport();
  });

  it("judges a member's end of turn by its dispatch, not by the agent's screen", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T12:00:00Z"));
    const run = await memberRun("term_d1", "ctx_live");
    on.responses.set("orchestration worker-show", { dispatchId: "ctx_live", taskId: "task_1", runId: "run_1", state: "running", activity: "working" });
    on.idle("term_d1");
    // The plugin's own reading would end the turn here: the agent went idle after work.
    await onAgentStatus({ terminalId: "term_d1", state: "done" });
    expect(store.get(run.id)!.members[0]!.state).toBe("working");
    expect(on.calls.some((args) => args.slice(0, 2).join(" ") === "orchestration worker-show" && args.join(" ").includes("ctx_live"))).toBe(true);

    // The dispatch's outcome is the member's, not the plugin's guess from the screen.
    on.responses.set("orchestration worker-show", { dispatchId: "ctx_live", taskId: "task_1", runId: "run_1", state: "failed", activity: "idle" });
    await onAgentStatus({ terminalId: "term_d1", state: "done" });
    expect(store.get(run.id)!.members[0]!.state).toBe("failed");
  });

  it("finishes a member as completed when the dispatch says it settled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T12:00:00Z"));
    const run = await memberRun("term_d2", "ctx_done");
    on.responses.set("orchestration worker-show", { dispatchId: "ctx_done", taskId: "task_2", runId: "run_1", state: "succeeded", activity: "idle" });
    on.idle("term_d2");
    await onAgentStatus({ terminalId: "term_d2", state: "done" });
    expect(store.get(run.id)!.members[0]!.state).toBe("done");
  });

  it("falls through to the plugin's own reading when the dispatch can't be read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T12:00:00Z"));
    const run = await memberRun("term_d3", "ctx_gone");
    on.responses.set("orchestration worker-show", null);
    on.idle("term_d3");
    await onAgentStatus({ terminalId: "term_d3", state: "done" });
    // The same reading as without orchestration: idle while starting is not the end of a turn.
    expect(store.get(run.id)!.members[0]!.state).toBe("working");
  });

  it("stops each member's worker before the plugin closes its terminal", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T12:00:00Z"));
    const run = await memberRun("term_d4", "ctx_stop");
    const closed = vi.spyOn(on, "closeTerminal");
    on.idle("term_d4");
    // Both members finished: a run with one still working can't be closed.
    await store.mutate(run.id, (current) => finishMember(current, "term_d4", "completed", "done", new Date().toISOString()));
    const reply = await shim("lead1", "close", { closeMembers: true });
    expect(reply.isError).toBe(false);
    expect(reply.text).toContain("Stopped 1 member worker");
    expect(on.calls.some((args) => args.slice(0, 2).join(" ") === "orchestration worker-stop" && args.join(" ").includes("ctx_stop"))).toBe(true);
    expect(closed).toHaveBeenCalledWith("term_d4");
    expect(store.get(run.id)!.status).toBe("closed");
  });

  it("types into a terminal member rather than sending to its dispatch", async () => {
    const run = await memberRun("term_d6", "ctx_typed");
    on.idle("term_d6");
    await shim("lead1", "send", { agentId: "term_d6", message: "Check the header again." });
    // Verified: a dispatch send reaches a terminal worker only as a new follow-up task, never as a message.
    expect(on.calls.some((args) => args.slice(0, 2).join(" ") === "orchestration send")).toBe(false);
    expect(on.sent.map((entry) => entry.terminalId)).toContain("term_d6");
    // The dispatch the plugin sent work past no longer tells the member's turn: its state can't end it.
    on.responses.set("orchestration worker-show", { dispatchId: "ctx_typed", taskId: "task_6", runId: "run_1", state: "succeeded", activity: "idle" });
    on.idle("term_d6");
    await onAgentStatus({ terminalId: "term_d6", state: "done" });
    expect(store.get(run.id)!.members[0]!.state).toBe("working");
  });

  it("closes the run as before when Orca has no orchestration", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T12:00:00Z"));
    const run = await memberRun("term_d7", "ctx_none");
    const older = new PlainOrca();
    // Detection is one probe per plugin run: settle it before anything asks whether orchestration is on.
    initCollaboration(older, store, async (session) => ({ team: session.team, source: "the test team" }), "/plugins/ensemble/bin/agent-team");
    expect(await detectOrchestration(older)).toBe(false);
    const closed = vi.spyOn(older, "closeTerminal");
    await store.mutate(run.id, (current) => finishMember(current, "term_d7", "completed", "done", new Date().toISOString()));
    older.idle("term_d7");
    const reply = await shim("lead1", "close", { closeMembers: true });
    expect(reply.isError).toBe(false);
    expect(reply.text).not.toContain("Stopped");
    expect(closed).toHaveBeenCalledWith("term_d7");
    expect(store.get(run.id)!.status).toBe("closed");
  });

  /** Orca makes one Run when asked, records every task, and dispatches each: tasks `task_w1`…, dispatches `ctx_w1`…. */
  const takeWorkers = () => {
    let tasks = 0;
    let dispatches = 0;
    on.responses.set("orchestration run-create", { runId: "run_orca1" });
    on.responses.set("orchestration task-create", () => ({ taskId: `task_w${++tasks}` }));
    on.responses.set("orchestration dispatch", () => ({ dispatch: { id: `ctx_w${++dispatches}` } }));
  };

  it("attaches every member to the team run's one Orca Run as a worker, and keeps its dispatch", async () => {
    takeWorkers();
    expect(await detectOrchestration(on)).toBe(true);
    await store.setLead(lead("delegation"));
    const delegated = await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }, { role: "checker", task: "Write checks/a.check" }], title: "Docs" });
    expect(delegated.isError).toBe(false);
    expect(delegated.text).not.toContain("did not take this member");
    const [writer, checker] = on.launched.map((entry) => entry.terminalId) as [string, string];
    const run = store.leadRun("lead1", true)!;

    // One Run for the team run, made on the lead's behalf; the team run and each member remember it.
    expect(on.callsOf("orchestration run-create")).toEqual([["orchestration", "run-create", "--objective", `${run.id} Docs`, "--from", "lead1"]]);
    expect(run.orcaRunId).toBe("run_orca1");
    expect(store.member(writer)).toMatchObject({ dispatchId: "ctx_w1", orcaTaskId: "task_w1", orcaRunId: "run_orca1" });
    expect(store.member(checker)).toMatchObject({ dispatchId: "ctx_w2", orcaTaskId: "task_w2", orcaRunId: "run_orca1" });

    // Each member's task is recorded in the Run and dispatched to the member's own terminal (its surface and model stay
    // the plugin's launch) without --inject: the task is already in the launch prompt, and Orca types nothing more.
    const created = on.callsOf("orchestration task-create");
    expect(created).toHaveLength(2);
    expect(created[0]).toEqual(["orchestration", "task-create", "--spec", expect.any(String), "--task-title", store.member(writer)!.title, "--run", "run_orca1", "--from", "lead1"]);
    const spec = created[0]![created[0]!.indexOf("--spec") + 1]!;
    expect(spec).toContain("Writes notes.");
    expect(spec).not.toContain("Write notes/a.txt");
    const dispatched = on.callsOf("orchestration dispatch");
    expect(dispatched[0]).toEqual(["orchestration", "dispatch", "--task", "task_w1", "--to", writer, "--run", "run_orca1", "--from", "lead1"]);
    expect(dispatched[1]).toEqual(expect.arrayContaining(["--to", checker]));
    expect(dispatched.flat()).not.toContain("--inject");
  });

  it("sends a reporting member's worker_done from its own shell, so Orca settles its dispatch", async () => {
    takeWorkers();
    expect(await detectOrchestration(on)).toBe(true);
    await store.setLead(lead("delegation"));
    await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }], title: "Docs" });
    const writer = on.launched[0]!.terminalId;
    expect(store.member(writer)).toMatchObject({ dispatchId: "ctx_w1", orcaTaskId: "task_w1" });
    const execs: string[][] = [];
    const caller = { handle: writer, exec: async (args: string[]) => (execs.push(args), {}) };
    const reply = await handleShim({ command: "report", input: { result: "Wrote notes/a.txt" }, terminalId: writer, workspaceId: "w", userDataPath: null, cwd: root, protocol: 2 }, caller as never);
    expect(reply.isError).toBe(false);
    expect(execs).toEqual([["orchestration", "send", "--type", "worker_done", "--task-id", "task_w1", "--dispatch-id", "ctx_w1", "--outcome", "succeeded", "--subject", store.member(writer)!.title, "--body", "Wrote notes/a.txt"]]);
    // Settled by Orca: nothing left for the plugin to abandon.
    expect(store.member(writer)?.dispatchId).toBeUndefined();
    expect(store.leadRun("lead1", false)!.members[0]!.state).toBe("done");
  });

  it("keeps the plugin's own dispatch for a member Orca won't take, and says so", async () => {
    on.responses.set("orchestration run-create", { runId: "run_orca2" });
    on.responses.set("orchestration worker-start", (args: string[]) => {
      if (args.includes("--help")) return {};
      throw new Error("worker-start: terminal is not an agent");
    });
    expect(await detectOrchestration(on)).toBe(true);
    await store.setLead(lead("delegation"));
    const delegated = await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }], title: "Docs" });
    expect(delegated.isError).toBe(false);
    expect(delegated.text).toContain("writer: Orca's orchestration did not take this member; the plugin dispatches it itself.");
    const writer = on.launched[0]!.terminalId;
    expect(store.member(writer)?.dispatchId).toBeUndefined();
    expect(store.leadRun("lead1", true)!.members[0]!.state).toBe("working");
  });

  it.each([
    { state: "succeeded", member: "done", task: "done", result: "" },
    { state: "failed", member: "failed", task: "dropped", result: "failed:" },
    { state: "stopped", member: "done", task: "dropped", result: "canceled:" },
  ])("finishes a delegated member whose dispatch $state as $member, its task $task", async ({ state, member, task, result }) => {
    takeWorkers();
    expect(await detectOrchestration(on)).toBe(true);
    await store.setLead(lead("delegation"));
    await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }], title: "Docs" });
    const writer = on.launched[0]!.terminalId;
    expect(store.member(writer)?.dispatchId).toBe("ctx_w1");
    // A minute on, so the end of turn is well past the task's dispatch.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    on.responses.set("orchestration worker-show", { dispatchId: "ctx_w1", taskId: "task_w1", runId: "run_orca1", state, activity: "idle" });
    on.idle(writer);
    // An idle lead takes the plugin's notice at once, rather than after its retries.
    on.idle("lead1");
    await onAgentStatus({ terminalId: writer, state: "done" });
    expect(on.callsOf("orchestration worker-show").at(-1)).toEqual(["orchestration", "worker-show", "--dispatch", "ctx_w1"]);
    const run = store.leadRun("lead1", false)!;
    expect(run.members[0]!.state).toBe(member);
    const board = run.tasks.find((entry) => entry.owner === writer)!;
    expect(board.state).toBe(task);
    if (result) expect(board.result?.startsWith(result)).toBe(true);
  });

  it("sends a chat member's message through its dispatch, and follows the follow-up dispatch Orca makes", async () => {
    expect(await detectOrchestration(on)).toBe(true);
    const run = await memberRun("term_c1", "ctx_chat", "chat");
    on.responses.set("orchestration send", { delivery: "follow_up", followUpOf: "ctx_chat", dispatchId: "ctx_chat2", taskId: "task_c2", state: "ready" });
    on.idle("term_c1");
    const reply = await shim("lead1", "send", { agentId: "term_c1", message: "Check the header again." });
    expect(reply.isError).toBe(false);
    expect(on.callsOf("orchestration send")).toEqual([
      ["orchestration", "send", "--from", "lead1", "--to", "dispatch:ctx_chat", "--subject", "Ensemble", "--body", expect.stringContaining("Check the header again.")],
    ]);
    // Nothing typed into the chat: the message went through Orca.
    expect(on.sent.filter((entry) => entry.terminalId === "term_c1")).toEqual([]);
    expect(store.member("term_c1")?.dispatchId).toBe("ctx_chat2");

    // The follow-up is the dispatch that now tells the member's turn; the settled parent no longer does.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    on.responses.set("orchestration worker-show", (args: string[]) => ({ dispatchId: args[3], taskId: "task_c", runId: "run_1", state: args[3] === "ctx_chat2" ? "succeeded" : "running", activity: "idle" }));
    on.idle("term_c1");
    on.idle("lead1");
    await onAgentStatus({ terminalId: "term_c1", state: "done" });
    expect(on.callsOf("orchestration worker-show").at(-1)).toEqual(["orchestration", "worker-show", "--dispatch", "ctx_chat2"]);
    expect(store.get(run.id)!.members[0]!.state).toBe("done");
  });

  it("runs a delegation end to end when every orca CLI call rejects", async () => {
    const offline = new OfflineOrca();
    initCollaboration(offline, store, async (session) => ({ team: session.team, source: "the test team" }), "/plugins/ensemble/bin/agent-team");
    expect(await detectOrchestration(offline)).toBe(false);
    await store.setLead(lead("delegation"));
    const delegated = await shim("lead1", "delegate", { tasks: [{ role: "writer", task: "Write notes/a.txt" }], title: "Docs" });
    expect(delegated.isError).toBe(false);
    expect(delegated.text).not.toContain("orchestration");
    const writer = offline.launched[0]!.terminalId;
    expect(store.member(writer)?.dispatchId).toBeUndefined();
    expect(store.member(writer)?.orcaRunId).toBeUndefined();
    expect(store.leadRun("lead1", true)!.orcaRunId ?? null).toBeNull();
    // The support probe is the only orchestration call: no Run, no worker, no send was tried.
    expect(offline.calls.filter((args) => args[0] === "orchestration" && !args.includes("--help"))).toEqual([]);

    offline.idle("lead1");
    expect((await shim(writer, "report", { result: "Wrote notes/a.txt" })).isError).toBe(false);
    // A follow-up is typed into the idle member by the plugin.
    offline.idle(writer);
    expect((await shim("lead1", "send", { agentId: writer, message: "Add a title line." })).isError).toBe(false);
    expect(offline.sent.filter((entry) => entry.terminalId === writer).at(-1)?.text).toContain("Add a title line.");
    offline.idle("lead1");
    expect((await shim(writer, "report", { result: "Added the title line" })).isError).toBe(false);
    const waited = await shim("lead1", "wait", { timeoutSeconds: 5 });
    expect(waited.text).toContain("Every member has finished");
    expect(waited.text).toContain("Added the title line");

    offline.idle(writer);
    const closed = vi.spyOn(offline, "closeTerminal");
    const reply = await shim("lead1", "close", { closeMembers: true });
    expect(reply.isError).toBe(false);
    expect(reply.text).not.toContain("Stopped");
    expect(closed).toHaveBeenCalledWith(writer);
    expect(store.leadRun("lead1", false)!.status).toBe("closed");
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
    // A member runs with full access: delegated work never stops on a permission prompt.
    expect(shellWords(event.command)).toEqual(["claude", "--model", "haiku", "--append-system-prompt", "You are writer", "--dangerously-skip-permissions", "the task"]);
    expect(store.member("t9")?.role).toBe("writer");
  });

  it("adds pi's own model flags when the launch could not carry the model", async () => {
    await store.addLaunch({ id: "L0000BBBB", kind: "member", prompt: "the task", systemPrompt: "", member: { leadTerminalId: "lead1", role: "worker", agent: "pi", title: "worker#1" }, model: "fluxcode-国模/deepseek-v4.1-flash", effort: "high", createdAt: new Date().toISOString() });
    const event = await onAgentLaunch(deps(), { agent: "pi", workspaceId: "p::/repo", terminalId: "t7", command: `pi '[ensemble:L0000BBBB]\nthe task'`, env: {} });
    expect(shellWords(event.command)).toEqual(["pi", "--model", "fluxcode-国模/deepseek-v4.1-flash", "--thinking", "high", "the task"]);
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
