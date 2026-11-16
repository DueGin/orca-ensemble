// The plugin's state on disk, under ~/.orca-ensemble/<plugin>: one file per run, and an index of lead sessions,
// members and launches in flight. Changes to a run go one at a time and are traced into its data flow.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { memberOf, newRunId, normalizeRun, type PendingBrief, type Run } from "../shared/collab";
import { logEvents, traceRun, type FlowParty, type NewEvent } from "../shared/flow";
import type { CollabMode, PromptLanguage, TeamMode } from "../shared/modes";
import type { Team } from "../shared/team";

/** Where a session's team comes from: a team file of the project (re-read on every status), a preset, or a copy. */
export type TeamSource = { kind: "file"; file: string } | { kind: "preset"; presetId: string } | { kind: "inline" };

/** A role the lead formed from a candidate during its session. */
export interface SessionRole {
  name: string;
  candidate: string;
  agent: string;
  model?: string;
  effort?: string;
  folders: string[];
  instructions: string;
  createdAt: string;
}

/** A lead's session: the terminal it runs in, its team and its mode. */
export interface LeadSession {
  terminalId: string;
  workspaceId: string | null;
  /** The lead's checkout; members run here too. */
  path: string;
  projectId: string | null;
  projectName: string;
  source: TeamSource;
  team: Team;
  language: PromptLanguage;
  mode: TeamMode | null;
  locked: CollabMode | null;
  roles: SessionRole[];
  brief: (PendingBrief & { confirmedBy?: "panel"; transcript?: string[] }) | null;
  agentSessionId: string | null;
  createdAt: string;
  endedAt: string | null;
}

/** A member: the terminal it runs in and the lead it works for. */
export interface MemberSession {
  terminalId: string;
  leadTerminalId: string;
  role: string;
  agent: string;
  model?: string;
  effort?: string;
  title: string;
  createdAt: string;
}

/** A planner agent writing a team file. */
export interface PlannerJob {
  terminalId: string;
  root: string;
  file: string;
  goal: string;
  status: "planning" | "done" | "failed";
  errors: string[];
  startedAt: string;
  endedAt: string | null;
}

/** A launch the plugin started, until Orca's launch hook ties it to a terminal. */
export interface PendingLaunch {
  id: string;
  kind: "lead" | "member" | "planner";
  /** The first prompt the agent should get instead of the launch marker. */
  prompt: string;
  /** Standing instructions, for agents that take an appended system prompt. */
  systemPrompt: string;
  lead?: Omit<LeadSession, "terminalId" | "createdAt" | "endedAt" | "agentSessionId">;
  member?: Omit<MemberSession, "terminalId" | "createdAt">;
  planner?: { root: string; file: string; goal: string };
  createdAt: string;
}

interface Index {
  leads: Record<string, LeadSession>;
  members: Record<string, MemberSession>;
  launches: Record<string, PendingLaunch>;
  planners: Record<string, PlannerJob>;
}

/** Who is changing runs right now: "lead", a member's terminal, or the plugin moving a run along. */
const actors = new AsyncLocalStorage<FlowParty>();
export const asActor = <T>(actor: FlowParty, work: () => Promise<T>): Promise<T> => actors.run(actor, work);

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

export class Store {
  private readonly runs = new Map<string, Run>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private index: Index = { leads: {}, members: {}, launches: {}, planners: {} };
  private indexQueue: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> | null = null;
  /** Called after any change, so panels and the status bar refresh. */
  onChange: (runId: string | null) => void = () => undefined;

  constructor(readonly dir: string) {
    mkdirSync(join(dir, "runs"), { recursive: true });
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.index = { leads: {}, members: {}, launches: {}, planners: {}, ...JSON.parse(await readFile(join(this.dir, "index.json"), "utf8")) };
      } catch {
        // First start.
      }
      for (const name of await readdir(join(this.dir, "runs")).catch(() => [] as string[])) {
        if (!name.endsWith(".json")) continue;
        try {
          const run = normalizeRun(JSON.parse(await readFile(join(this.dir, "runs", name), "utf8")) as Run);
          this.runs.set(run.id, run);
        } catch {
          // A broken run file is skipped.
        }
      }
    })();
    return this.loaded;
  }

  // ----- Runs

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  allRuns(): Run[] {
    return [...this.runs.values()];
  }

  newId(): string {
    for (;;) {
      const id = newRunId();
      if (!this.runs.has(id)) return id;
    }
  }

  /** The lead's newest run, or its newest active one. */
  leadRun(leadTerminalId: string, activeOnly: boolean): Run | undefined {
    return [...this.runs.values()].filter((run) => run.leadAgentId === leadTerminalId && (!activeOnly || run.status === "active")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  activeRuns(): Run[] {
    return [...this.runs.values()].filter((run) => run.status === "active");
  }

  /** The newest active run the terminal is a member of. */
  memberRun(terminalId: string): Run | undefined {
    return [...this.runs.values()].filter((run) => run.status === "active" && memberOf(run, terminalId) !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  async create(created: Run): Promise<Run> {
    if (this.runs.has(created.id)) throw new Error(`Run ${created.id} already exists.`);
    const run = logEvents(created, traceRun(null, created, actors.getStore() ?? "plugin"), created.createdAt);
    this.runs.set(run.id, run);
    await this.save(run.id);
    return run;
  }

  /** Changes a run, one change at a time per run, saves it and traces the change; `trace: false` skips the trace. */
  mutate(id: string, change: (run: Run) => Run, options: { trace?: boolean } = {}): Promise<Run> {
    const actor = actors.getStore() ?? "plugin";
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const before = this.runs.get(id);
      if (!before) throw new Error(`Run ${id} was not found.`);
      const after = change(before);
      if (after === before) return before;
      const run = options.trace === false ? after : logEvents(after, traceRun(before, after, actor), new Date().toISOString());
      this.runs.set(id, run);
      await this.save(id);
      return run;
    });
    this.queues.set(id, next);
    return next;
  }

  /** Records events no state change shows, such as a refused file claim or a notice that went out. */
  log(id: string, events: readonly NewEvent[]): Promise<Run> {
    return this.mutate(id, (run) => logEvents({ ...run }, events, new Date().toISOString()));
  }

  private async save(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    await writeAtomic(join(this.dir, "runs", `${id}.json`), JSON.stringify(run, null, 2) + "\n");
    this.onChange(id);
  }

  /** Forgets closed runs past the newest `keep`. */
  async prune(keep = 80): Promise<void> {
    const closed = [...this.runs.values()].filter((run) => run.status === "closed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const run of closed.slice(keep)) {
      this.runs.delete(run.id);
      await unlink(join(this.dir, "runs", `${run.id}.json`)).catch(() => undefined);
    }
  }

  // ----- Sessions

  lead(terminalId: string | null | undefined): LeadSession | undefined {
    return terminalId ? this.index.leads[terminalId] : undefined;
  }

  member(terminalId: string | null | undefined): MemberSession | undefined {
    return terminalId ? this.index.members[terminalId] : undefined;
  }

  leads(): LeadSession[] {
    return Object.values(this.index.leads);
  }

  members(): MemberSession[] {
    return Object.values(this.index.members);
  }

  launch(id: string): PendingLaunch | undefined {
    return this.index.launches[id];
  }

  /** Changes the index, one change at a time, and saves it. */
  updateIndex(change: (index: Index) => void): Promise<void> {
    const next = this.indexQueue.catch(() => undefined).then(async () => {
      change(this.index);
      await writeAtomic(join(this.dir, "index.json"), JSON.stringify(this.index, null, 2) + "\n");
      this.onChange(null);
    });
    this.indexQueue = next;
    return next;
  }

  setLead(session: LeadSession): Promise<void> {
    return this.updateIndex((index) => {
      index.leads[session.terminalId] = session;
    });
  }

  patchLead(terminalId: string, patch: Partial<LeadSession>): Promise<void> {
    return this.updateIndex((index) => {
      const lead = index.leads[terminalId];
      if (lead) index.leads[terminalId] = { ...lead, ...patch };
    });
  }

  planner(terminalId: string | null | undefined): PlannerJob | undefined {
    return terminalId ? this.index.planners[terminalId] : undefined;
  }

  planners(): PlannerJob[] {
    return Object.values(this.index.planners);
  }

  setPlanner(job: PlannerJob): Promise<void> {
    return this.updateIndex((index) => {
      index.planners[job.terminalId] = job;
    });
  }

  setMember(member: MemberSession): Promise<void> {
    return this.updateIndex((index) => {
      index.members[member.terminalId] = member;
    });
  }

  addLaunch(launch: PendingLaunch): Promise<void> {
    return this.updateIndex((index) => {
      index.launches[launch.id] = launch;
      // Launches that never reached the hook (Orca refused them) are dropped after a day.
      const old = Date.now() - 24 * 3600_000;
      for (const [id, entry] of Object.entries(index.launches)) if (Date.parse(entry.createdAt) < old) delete index.launches[id];
    });
  }

  takeLaunch(id: string): PendingLaunch | undefined {
    const launch = this.index.launches[id];
    if (launch) void this.updateIndex((index) => void delete index.launches[id]);
    return launch;
  }

  // ----- Session state, as the tools read it

  sessionMode(leadTerminalId: string): TeamMode | null {
    return this.lead(leadTerminalId)?.mode ?? null;
  }

  sessionLock(leadTerminalId: string): CollabMode | null {
    return this.lead(leadTerminalId)?.locked ?? null;
  }

  setSessionMode(leadTerminalId: string, mode: TeamMode | null): Promise<void> {
    return this.patchLead(leadTerminalId, { mode });
  }

  lockSession(leadTerminalId: string, locked: CollabMode): Promise<void> {
    return this.updateIndex((index) => {
      const lead = index.leads[leadTerminalId];
      if (lead && !lead.locked) lead.locked = locked;
    });
  }

  sessionRoles(leadTerminalId: string): SessionRole[] {
    return this.lead(leadTerminalId)?.roles ?? [];
  }

  setSessionRoles(leadTerminalId: string, roles: SessionRole[]): Promise<void> {
    return this.patchLead(leadTerminalId, { roles: [...roles] });
  }

  pendingBrief(leadTerminalId: string): LeadSession["brief"] {
    return this.lead(leadTerminalId)?.brief ?? null;
  }

  setPendingBrief(leadTerminalId: string, brief: LeadSession["brief"]): Promise<void> {
    return this.patchLead(leadTerminalId, { brief });
  }
}

export const newLaunchId = () => `L${Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0").toUpperCase()}`;
