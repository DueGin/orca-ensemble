// Orca's own agent orchestration, which the team's runs ride on: one Orca Run per team run, every member a supervised
// Dispatch of it. Orca then delivers messages to a member (a chat included, at its turn's end), tells the result from
// the dispatch's state, and wakes the lead when a worker reports `worker_done`. The plugin keeps the team's own model
// on top: the brief, the task board, file claims, review rounds and the data flow.
//
// A dispatch is `ctx_…`. `worker-show` is the read side: it says succeeded/failed/running and the last activity. The
// lead alone consumes Orca's mail (`check`), so the plugin only ever reads with `worker-show` and never steals it.
import type { OrcaAdapter } from "./adapter";

/** A supervised worker: the dispatch Orca made for one member of one run. */
export interface Dispatch {
  dispatchId: string;
  taskId: string;
  runId: string;
  /** running, ready, succeeded, failed, stopped, unknown… as Orca reports it. */
  state: string;
  activity?: string;
  liveness?: string;
}

/** Whether this Orca knows the orchestration verbs the plugin needs; older ones keep the plugin's own dispatch path. */
export const ORCHESTRATION_HELP = "orchestration worker-start";

/** What Orca did with a message to a dispatch, as `orchestration send` reports it. */
export interface SendResult {
  /** "mail": the worker has it for its next turn. "follow_up": Orca made a new dispatch that gives it the text as a task. */
  delivery: "mail" | "follow_up";
  /** The dispatch that now carries the work: the follow-up when Orca made one, else the one addressed. */
  dispatchId: string;
  /** The dispatch the message was addressed to. */
  followUpOf: string;
  state: string;
}

let supported: boolean | null = null;
/** The adapter the cached answer is about; a second adapter starts a fresh probe rather than inheriting it. */
let probedFor: OrcaAdapter | null = null;
/** Bumped by every reset: a probe an earlier session started can't answer for the one now running. */
let generation = 0;

/** When the plugin last sent a dispatch its member's work itself, by dispatch id. */
const lastSent = new Map<string, number>();

export function orchestrationSupported(adapter?: OrcaAdapter): boolean {
  return adapter ? (probedFor === adapter ? supported ?? false : false) : supported ?? false;
}

/** Asks the CLI once whether it has `orchestration worker-start`; cached for the adapter's lifetime. */
export async function detectOrchestration(adapter: OrcaAdapter): Promise<boolean> {
  if (probedFor === adapter && supported !== null) return supported;
  const asked = generation;
  // Help prints text, not JSON: ask for the exit code, not a parsed answer.
  const answer = await adapter.rawCli(["orchestration", "worker-start", "--help"], 20_000).then(() => true, () => false);
  // A session that was reset (or replaced) while the probe ran doesn't get the answer kept.
  if (asked !== generation) return false;
  supported = answer;
  probedFor = adapter;
  return answer;
}

export function resetOrchestrationSupport(): void {
  supported = null;
  probedFor = null;
  generation += 1;
}

/** One Orca Run per team run; it is created (and bound to the lead) the first time it is needed. */
export class Orchestra {
  private readonly runs = new Map<string, string>();

  constructor(private readonly adapter: OrcaAdapter, private readonly lead: (id: string) => string | null) {}

  enabled(): boolean {
    return orchestrationSupported(this.adapter);
  }

  /** Whether Orca's orchestration holds a dispatch for this member, so it can be asked about and stopped through. */
  holds(member: { dispatchId?: string; dispatchedAt?: string } | undefined): member is { dispatchId: string; dispatchedAt?: string } {
    return this.enabled() && !!member?.dispatchId;
  }

  /**
   * Whether that dispatch is what tells the member's turn: no. A dispatch describes one turn, and Orca leaves it settled
   * for good; when the plugin has since sent the member the work it is on itself (see sendMember), the dispatch speaks
   * of an earlier turn and must not end this one.
   */
  governs(member: { dispatchId?: string; dispatchedAt?: string } | undefined): member is { dispatchId: string; dispatchedAt?: string } {
    if (!this.holds(member)) return false;
    const last = lastSent.get(member.dispatchId);
    return !last || (!!member.dispatchedAt && Date.parse(member.dispatchedAt) >= last);
  }

  /** Records that the plugin sent a dispatch the work itself; from then on that dispatch describes an earlier turn. */
  static sent(dispatchId: string): void {
    lastSent.set(dispatchId, Date.now());
  }

  /** The Orca Run of a team run, created on the lead's behalf when there is none. */
  async runFor(teamRunId: string, leadId: string, objective: string): Promise<string | null> {
    if (!this.enabled()) return null;
    const known = this.runs.get(teamRunId);
    if (known) return known;
    const from = this.lead(leadId);
    if (!from) return null;
    try {
      const made = await this.adapter.runCli<{ runId: string }>(["orchestration", "run-create", "--objective", objective.slice(0, 2000), "--from", from], 60_000);
      if (!made?.runId) return null;
      this.runs.set(teamRunId, made.runId);
      return made.runId;
    } catch {
      return null;
    }
  }

  /** Remembers a Run for a team run that already has one (after a restart, from the store). */
  bind(teamRunId: string, runId: string): void {
    this.runs.set(teamRunId, runId);
  }

  /**
   * Attaches an agent the plugin already started (its own surface and model) as a worker of the run, with its task.
   * Orca injects its worker preamble into the agent's next turn, so the agent reports through `worker_done`.
   */
  async startWorker(input: { runId: string; leadId: string; handle: string; title: string; spec: string; workspacePath: string }): Promise<Dispatch | null> {
    if (!this.enabled()) return null;
    const from = this.lead(input.leadId);
    if (!from) return null;
    try {
      const result = await this.adapter.runCli<Dispatch & { next?: string }>(
        ["orchestration", "worker-start", "--run", input.runId, "--from", from, "--task-title", input.title.slice(0, 200), "--spec", input.spec, "--terminal", input.handle, "--worktree", `path:${input.workspacePath}`],
        180_000,
      );
      if (!result?.dispatchId) return null;
      return { dispatchId: result.dispatchId, taskId: result.taskId, runId: result.runId ?? input.runId, state: result.state ?? "ready" };
    } catch {
      return null;
    }
  }

  /** What Orca says about a dispatch; null when the CLI can't answer (a plugin restart, an older Orca). */
  async show(dispatchId: string): Promise<Dispatch | null> {
    if (!this.enabled()) return null;
    try {
      const result = await this.adapter.runCli<Dispatch>(["orchestration", "worker-show", "--dispatch", dispatchId], 30_000);
      return result?.dispatchId ? result : null;
    } catch {
      return null;
    }
  }

  /**
   * Sends text to a worker through Orca: a busy worker gets it as mail when its turn ends, a finished one as a
   * follow-up dispatch. Returns what Orca did, or null when the CLI can't send (an older Orca, no lead to send from).
   */
  async send(dispatchId: string, leadId: string, subject: string, body: string): Promise<SendResult | null> {
    if (!this.enabled()) return null;
    const from = this.lead(leadId);
    if (!from) return null;
    try {
      const result = await this.adapter.runCli<Partial<SendResult> & { taskId?: string }>(
        ["orchestration", "send", "--from", from, "--to", `dispatch:${dispatchId}`, "--subject", subject.slice(0, 200), "--body", body],
        60_000,
      );
      // A worker only ever gets the body as a task, never as mail: Orca answers `delivery: "follow_up"` with a new
      // dispatch of its own (`followUpOf`). Keep that id, or every later read and stop would ask about a settled parent.
      return {
        delivery: result?.delivery === "follow_up" || (!!result?.dispatchId && result.dispatchId !== dispatchId) ? "follow_up" : "mail",
        dispatchId: result?.dispatchId ?? dispatchId,
        followUpOf: result?.followUpOf ?? dispatchId,
        state: result?.state ?? "ready",
      };
    } catch {
      return null;
    }
  }

  /**
   * Stops a worker's agent through Orca; the dispatch is fenced so nothing else is delivered to it. Only a terminal
   * Orca started itself is closed: on one the plugin launched and attached, Orca refuses (`stop_unknown`, "the worker
   * terminal is external") and the process keeps running, so the caller still closes the terminal itself.
   */
  async stop(dispatchId: string): Promise<{ ok: boolean; state: string; error: string | null }> {
    if (!this.enabled()) return { ok: false, state: "unknown", error: "orchestration not available" };
    try {
      const result = await this.adapter.runCli<{ state?: string }>(["orchestration", "worker-stop", "--dispatch", dispatchId], 60_000);
      return { ok: true, state: result?.state ?? "stopped", error: null };
    } catch (error) {
      return { ok: false, state: "unknown", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Settles a dispatch whose worker the plugin has finished itself: the member reported through its own team tool, not
   * through `worker_done`, so Orca still holds the dispatch open and would escalate "stopped without reporting" to the
   * lead. Abandoning fences it without touching the agent's process (the plugin keeps the agent for the next task).
   */
  async abandon(dispatchId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    try {
      await this.adapter.runCli(["orchestration", "worker-abandon", "--dispatch", dispatchId], 60_000);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a dispatch has stopped working: a settled state, or Orca says the agent's pane is idle after work. */
  static settled(dispatch: Pick<Dispatch, "state">): { settled: boolean; outcome: "completed" | "failed" | "canceled" } {
    const state = dispatch.state.toLowerCase();
    // Canceled first: "abandoned" contains "done".
    if (/stop|cancel|abandon|kill/.test(state)) return { settled: true, outcome: "canceled" };
    if (/succeed|complete|done/.test(state)) return { settled: true, outcome: "completed" };
    if (/fail|error/.test(state)) return { settled: true, outcome: "failed" };
    return { settled: false, outcome: "completed" };
  }
}
