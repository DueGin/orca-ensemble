// The team on Orca: lead and members are agent CLIs in Orca terminals; they reach the plugin through `agent-team`
// commands, served here. This module holds the lead's context, starting and messaging members, moving a run along
// (staffing, handing out tasks, review rounds, notices), and the commands themselves.
import { z } from "zod";
import {
  addBatch, addPost, addTasks, assignTasks, attachPacket, batchToSummarize, briefText, claimPaths, claimTask, completeTask, confirmsBrief, createRun,
  DEFAULT_TEAM_ROUNDS, excerpt, finishMember, inboxOf, inboxText, leadInbox, markCollected, markInbox, markPlansNotified, markVerdictsDelivered, MAX_NUDGES,
  MAX_ROUNDS, MAX_TEAM_SIZE, MEMBER_POST_KINDS, memberOf, memberTitle, nextStep, pathsOverlap, pendingPlans, rejectTask, releaseClaims, releaseTask,
  retireMember, retireRole, reviewPlan, roundComplete, runFinished, runSummary, startBatch, startRound, submitPlan, summarizeBatch, taskBoardText, taskOf,
  taskReady, TO_ALL, touchMember, undeliveredVerdicts, unstaffedRoles, updateMember, updateTasks, upsertMember, wakeMembers, workingMembers, mayTake,
  boardPage, type BoardTask, type Brief, type NewTask, type PendingBrief, type Run, type RunMember, type TaskChange,
} from "../shared/collab";
import { logEvents, type FlowParty, type NewEvent } from "../shared/flow";
import { allowsMode, effectiveMode, isPromptLanguage, LEAD_TOOLS, MEMBER_TOOLS, MODE_SPECS, PLUGIN_MESSAGE_PREFIX, TEAM_BIN, type CollabMode, type PromptLanguage, type TeamMode } from "../shared/modes";
import type { RoleNote } from "../shared/prompt";
import { promptsFor } from "../shared/prompts";
import type { ShimRequest, ShimResponse } from "../shared/ipc";
import { parseTeam, runtimeLabel, type Team } from "../shared/team";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { OrcaAdapter } from "./adapter";
import { asActor, newLaunchId, type LeadSession, type SessionRole, type Store } from "./store";
import { claudeTranscript, claudeTurn, lastReplyFromScreen, typedAfter } from "./transcripts";

const MAX_WAIT_SECONDS = 540;
const BOARD_LIMIT = 24_000;

const now = () => new Date().toISOString();
export interface Result {
  text?: string;
  isError?: boolean;
  structuredContent?: unknown;
}
const ok = (text: string, structuredContent?: unknown): Result => ({ text, ...(structuredContent === undefined ? {} : { structuredContent }) });
const fail = (text: string): Result => ({ isError: true, text });
const key = (value: string) => value.trim().toLowerCase();
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** The caller of a command: the Orca terminal it runs in. */
interface Caller {
  id: string;
  workspaceId: string | null;
}

interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  input: S;
  execute(input: z.output<S>, context: { agent: Caller; signal: AbortSignal }): Promise<Result>;
}
function defineTool<S extends z.ZodTypeAny>(tool: ToolDef<S>): ToolDef {
  return tool as unknown as ToolDef;
}

let adapterRef: OrcaAdapter | null = null;
const orca = (): OrcaAdapter => adapterRef!;
let store: Store = null as unknown as Store;

/** Reads a team for a lead: its team file again (edits apply), a preset, or the copy taken when the session started. */
let readTeamRef: (lead: LeadSession) => Promise<{ team: Team; source: string }> = async (lead) => ({ team: lead.team, source: "the session's copy" });

export function initCollaboration(adapter: OrcaAdapter, runs: Store, readTeam: typeof readTeamRef): void {
  adapterRef = adapter;
  store = runs;
  readTeamRef = readTeam;
}

// ---------------------------------------------------------------------------------------------------------------------
// The lead and its members

interface LeadContext {
  lead: LeadSession;
  workspaceId: string;
  team: Team;
  file: string;
  override: TeamMode | null;
  locked: CollabMode | null;
  effective: TeamMode;
  sessionRoles: SessionRole[];
}

async function leadContext(caller: { id: string; workspaceId?: string | null }): Promise<LeadContext> {
  await store.load();
  const lead = store.lead(caller.id);
  if (!lead) throw new Error(`This terminal is not an agent team's lead. Start a team session from the Agent Team panel, or begin the first prompt of a new agent with "@team".`);
  const { team, source } = await readTeamRef(lead);
  const override = lead.mode;
  const locked = lead.locked;
  return { lead, workspaceId: lead.workspaceId ?? caller.workspaceId ?? "", team, file: source, override, locked, effective: effectiveMode(team.mode, override, locked), sessionRoles: team.candidates.length ? lead.roles : [] };
}

/** Whether the user confirmed the brief: Confirm in the panel, their own words in the lead's transcript or on its screen. */
async function userConfirmed(leadId: string, pending: PendingBrief & { confirmedBy?: string; transcript?: string[] }, quote: string): Promise<boolean> {
  if (pending.confirmedBy === "panel") return true;
  const lead = store.lead(leadId);
  const after = Date.parse(pending.at);
  const transcript = lead ? await claudeTranscript(lead.path, lead.agentSessionId) : null;
  if (transcript) {
    const messages = transcript.filter((message) => message.role === "user").map((message) => ({ role: "user" as const, text: message.text, seq: message.at }));
    if (confirmsBrief(messages, after, quote)) return true;
  }
  const screen = await orca().readTerminal(leadId, 400);
  return confirmsBrief(typedAfter(screen, pending.transcript ?? []), 0, quote);
}

interface MemberSpec extends RoleNote {
  agent: string;
  model?: string;
  effort?: string;
  formed: boolean;
}

const HELPER = "helper";
const RESERVED = new Set([HELPER, "lead", TO_ALL, "anyone"]);

/**
 * A fixed role of the team, a role the lead formed from a candidate, a candidate itself, or the helper (on the lead's
 * model), which only a team without candidates has: with a preset pool, every model comes from the pool.
 */
function roleSpec(ctx: LeadContext, name: string): MemberSpec | null {
  const fixed = ctx.team.roles.find((role) => key(role.name) === key(name));
  if (fixed) return { ...fixed, formed: false };
  const formed = ctx.sessionRoles.find((role) => key(role.name) === key(name));
  if (formed) return { name: formed.name, agent: formed.agent, model: formed.model, effort: formed.effort, folders: formed.folders, instructions: formed.instructions, formed: true };
  // Work can go straight to a candidate: its member runs on the candidate's model, with its description as notes.
  const candidate = ctx.team.candidates.find((entry) => key(entry.name) === key(name));
  if (candidate) return { name: candidate.name, agent: candidate.agent, model: candidate.model, effort: candidate.effort, folders: [], instructions: candidate.notes, formed: true };
  if (key(name) === HELPER && !ctx.team.candidates.length) {
    return { name: HELPER, agent: ctx.team.lead.agent, model: ctx.team.lead.model, effort: ctx.team.lead.effort, folders: [], instructions: "Helps the lead with work no role owns.", formed: false };
  }
  return null;
}

const headerFor = (spec: MemberSpec, lang: PromptLanguage) => (spec.formed ? promptsFor(lang).roleHeader(spec) : "");

/** The roles of a run as prompts list them: its active members' roles, plus `extra`. */
function rosterOf(ctx: LeadContext, run: Run, extra: readonly MemberSpec[] = []): RoleNote[] {
  const names = [...new Set([...run.members.filter((member) => !member.retired).map((member) => member.role), ...extra.map((spec) => spec.name)].map(key))];
  return names.map((name) => roleSpec(ctx, name) ?? { name, folders: [], instructions: "" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Members: started in Orca terminals of the lead's workspace

const sameRuntime = (a: { agent: string; model?: string; effort?: string }, b: { agent: string; model?: string; effort?: string }) =>
  a.agent === b.agent && (a.model ?? "") === (b.model ?? "") && (a.effort ?? "") === (b.effort ?? "");

/** Agents of a workspace, refreshed into the adapter's map; Orca lists only agents that still run. */
async function refreshAgents(workspaceId: string | null | undefined): Promise<void> {
  const rows = await orca().listAgents(workspaceId ?? undefined);
  for (const row of rows) {
    if (!row.terminalId) continue;
    const was = orca().agents.get(row.terminalId);
    // A working agent's state comes from events; agents.list confirms it runs and fills in what events didn't.
    orca().agents.set(row.terminalId, { ...(was ?? { workspaceId: workspaceId ?? null }), ...row, terminalId: row.terminalId, state: was && Date.now() - was.at < 5000 ? was.state : row.state, at: Date.now(), workspaceId: was?.workspaceId ?? workspaceId ?? null });
  }
}

/** Whether the agent in a terminal still runs. */
async function agentAlive(terminalId: string, workspaceId: string | null): Promise<boolean> {
  if (orca().agents.has(terminalId) && Date.now() - orca().agents.get(terminalId)!.at < 15_000) return true;
  await refreshAgents(workspaceId);
  if (orca().agents.has(terminalId) && Date.now() - orca().agents.get(terminalId)!.at < 15_000) return true;
  return orca().terminalAlive(terminalId);
}

/** Idle: waiting for input. */
async function isIdleAgent(terminalId: string, workspaceId: string | null): Promise<boolean> {
  if (!orca().stateOf(terminalId)) await refreshAgents(workspaceId);
  if (!orca().stateOf(terminalId)) {
    const probed = await orca().probeState(terminalId);
    return probed === "done" || probed === "waiting";
  }
  return orca().isIdle(terminalId);
}

/** When each member was last seen working since it was given work; a "done" before that is the idle start, not an end. */
const seenWorking = new Map<string, number>();

export function noteAgentWorking(terminalId: string): void {
  seenWorking.set(terminalId, Date.now());
  orca().noteWorking(terminalId);
}

/** The role's idle member for this lead on the role's agent and model. */
async function reusableMember(leadId: string, spec: MemberSpec): Promise<string | "busy" | null> {
  const lead = store.lead(leadId);
  const mine = store.members().filter((member) => member.leadTerminalId === leadId && key(member.role) === key(spec.name) && sameRuntime(member, spec)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let busy = false;
  for (const member of mine) {
    if (!(await agentAlive(member.terminalId, lead?.workspaceId ?? null))) continue;
    if (await isIdleAgent(member.terminalId, lead?.workspaceId ?? null)) return member.terminalId;
    busy = true;
  }
  return busy ? "busy" : null;
}

/** Continues the role's idle member with the prompt, or starts one in a new terminal of the lead's workspace. */
async function dispatch(ctx: LeadContext, leadId: string, spec: MemberSpec, prompt: string, lang: PromptLanguage): Promise<{ agentId: string; title: string; continued: boolean }> {
  const existing = await reusableMember(leadId, spec);
  if (existing === "busy") throw new Error(lang === "zh" ? `${spec.name} 正忙于其他工作；请等它完成，或把工作交给别的角色。` : `${spec.name} is busy with other work; wait for it to finish, or give the work to another role.`);
  if (existing) {
    const sent = await orca().send(existing, prompt);
    if (!sent) throw new Error(lang === "zh" ? `无法把任务交给 ${spec.name}。` : `Could not hand the task to ${spec.name}.`);
    seenWorking.delete(existing);
    return { agentId: existing, title: store.member(existing)?.title ?? spec.name, continued: true };
  }
  const P = promptsFor(lang);
  const title = memberTitle(spec.name);
  const launchId = newLaunchId();
  const systemPrompt = P.memberSystemPrompt(ctx.team, spec);
  const member = { leadTerminalId: leadId, role: spec.name, agent: spec.agent, model: spec.model, effort: spec.effort, title };
  await store.addLaunch({ id: launchId, kind: "member", prompt, systemPrompt, member, createdAt: now() });
  // The marker lets the launch hook tie this launch to its terminal; agents without a system prompt get the
  // standing instructions in their first message.
  const first = `[agent-team:${launchId}]\n${spec.agent === "claude" ? prompt : P.memberStartPrompt(ctx.team, spec, prompt)}`;
  const { terminalId } = await orca().launch({ path: ctx.lead.path, agent: spec.agent, model: spec.model, effort: spec.effort, prompt: first });
  if (!store.member(terminalId)) await store.setMember({ terminalId, ...member, createdAt: now() });
  void orca().runCli(["terminal", "rename", "--terminal", terminalId, "--title", title]).catch(() => undefined);
  seenWorking.delete(terminalId);
  return { agentId: terminalId, title, continued: false };
}

/** Sends to an idle agent only, so a message never interrupts a turn; returns whether it went in. */
async function sendIfIdle(id: string, text: string): Promise<boolean> {
  const member = store.member(id);
  const workspaceId = store.lead(member?.leadTerminalId ?? id)?.workspaceId ?? null;
  if (!(await isIdleAgent(id, workspaceId))) return false;
  return orca().send(id, text);
}

/** Like sendIfIdle, but gives an agent whose turn just ended a few seconds to report idle. */
async function sendWhenIdle(id: string, text: string, attempts = 8): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await sendIfIdle(id, text)) return true;
    const member = store.member(id);
    if (member && !(await agentAlive(id, store.lead(member.leadTerminalId)?.workspaceId ?? null))) return false;
    await sleep(750);
  }
  return false;
}

/** What a member said last: its report, its Claude transcript, or its screen. */
const reports = new Map<string, string>();
async function lastMessage(id: string): Promise<string | null> {
  const reported = reports.get(id);
  if (reported) {
    reports.delete(id);
    return reported;
  }
  const member = store.member(id);
  const lead = member ? store.lead(member.leadTerminalId) : store.lead(id);
  const sessionId = orca().agents.get(id)?.sessionId ?? null;
  if (lead && sessionId) {
    const transcript = await claudeTranscript(lead.path, sessionId);
    const last = transcript?.filter((message) => message.role === "assistant").at(-1)?.text;
    if (last) return last;
  }
  const screen = lastReplyFromScreen(await orca().readTerminal(id, 300));
  return screen || null;
}

/**
 * Whether an agent's turn that began at `since` has ended, and what it said: from Claude's transcript (its last message
 * ended the turn), null when that can't be told. Orca's "done" alone isn't enough: an agent reports idle while it starts.
 */
async function turnEnded(terminalId: string, since: number): Promise<{ ended: boolean | null; text: string | null }> {
  const member = store.member(terminalId);
  const lead = member ? store.lead(member.leadTerminalId) : store.lead(terminalId);
  const agent = member?.agent ?? lead?.team.lead.agent ?? orca().agents.get(terminalId)?.agent ?? null;
  const sessionId = orca().agents.get(terminalId)?.sessionId ?? (member ? null : lead?.agentSessionId) ?? null;
  if (agent === "claude" && lead) {
    if (!sessionId) return { ended: null, text: null };
    const turn = await claudeTurn(lead.path, sessionId);
    if (turn.found) return { ended: turn.ended && turn.endedAt >= since - 2000, text: turn.text || null };
  }
  return { ended: null, text: null };
}

/** Replaces a finished member's result with its own report, in the member, its delegated task and the flow. */
function amendReport(run: Run, agentId: string, result: string): Run {
  const text = excerpt(result, 4000);
  const index = run.events.map((event) => event.component === "reports" && event.action === "report" && event.from === agentId).lastIndexOf(true);
  return {
    ...run,
    updatedAt: now(),
    members: run.members.map((member) => (member.agentId === agentId ? { ...member, result: text, collected: false } : member)),
    tasks: run.tasks.map((task) => (task.owner === agentId && task.state === "done" && task === [...run.tasks].reverse().find((entry) => entry.owner === agentId && entry.state === "done") ? { ...task, result: excerpt(result, 300) } : task)),
    events: index < 0 ? run.events : run.events.map((event, at) => (at === index ? { ...event, note: excerpt(result.replace(/\s+/g, " "), 160) } : event)),
  };
}

/** A member's turn has ended: its transcript says so, or (no transcript) it worked since its dispatch and went idle. */
async function memberTurnEnded(terminalId: string, member: RunMember): Promise<{ ended: boolean; text: string | null }> {
  const since = Date.parse(member.dispatchedAt);
  const turn = await turnEnded(terminalId, since);
  if (turn.ended !== null) return { ended: turn.ended, text: turn.text };
  const agent = store.member(terminalId)?.agent;
  const worked = (seenWorking.get(terminalId) ?? 0) >= since;
  // Claude without a transcript yet: wait for the next event; other agents: idle after work, past a short start.
  return { ended: agent !== "claude" && worked && Date.now() - since > 15_000, text: null };
}

/** Closes the lead's active run so a new one can start; refuses while its members still work. */
async function closeActive(leadId: string, lang: PromptLanguage): Promise<string | null> {
  const active = store.leadRun(leadId, true);
  if (!active) return null;
  if (!roundComplete(active) && active.members.length) {
    const working = workingMembers(active).map((member) => member.title).join(", ");
    return lang === "zh"
      ? `运行 ${active.id}（${active.mode === "team" ? "团队" : "委派"}模式）还在进行（${working}）。请先运行 ${LEAD_TOOLS.wait}，或用 ${LEAD_TOOLS.send} 调整。`
      : `Run ${active.id} (${active.mode} mode) is still working (${working}). Run ${LEAD_TOOLS.wait} first, or ${LEAD_TOOLS.send} to adjust it.`;
  }
  await store.mutate(active.id, (run) => ({ ...run, status: "closed", claims: [], updatedAt: now() }));
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Moving a run along

const staffing = new Set<string>();
const isStaffing = (runId: string) => [...staffing].some((lock) => lock.startsWith(`${runId}:`));

/** Roles with ready work and no member that the plugin can still staff: known roles, while the run has room. */
function staffableRoles(ctx: LeadContext, run: Run): string[] {
  if (run.members.filter((member) => !member.retired).length >= MAX_TEAM_SIZE) return [];
  return unstaffedRoles(run).filter((role) => { const spec = roleSpec(ctx, role); return spec !== null && spec.name !== HELPER; });
}

/** Starts a member for each role that has a ready task but no member in the run yet, up to MAX_TEAM_SIZE. */
async function staff(runId: string): Promise<void> {
  const run = store.get(runId);
  if (!run || run.mode !== "team" || run.status !== "active" || !run.brief) return;
  const roles = unstaffedRoles(run).filter((role) => !staffing.has(`${runId}:${key(role)}`));
  if (!roles.length) return;
  const ctx = await leadContext({ id: run.leadAgentId, workspaceId: run.workspaceId });
  for (const role of roles) {
    const current = store.get(runId)!;
    if (current.members.filter((member) => !member.retired).length >= MAX_TEAM_SIZE) break;
    const spec = roleSpec(ctx, role);
    if (!spec) continue; // An unknown role: the task stays open, and the lead sees it on the board.
    const lock = `${runId}:${key(spec.name)}`;
    if (staffing.has(lock)) continue;
    staffing.add(lock);
    try {
      const started = await dispatch(ctx, run.leadAgentId, spec, promptsFor(current.language).teamKickoffPrompt(current, current.brief!, rosterOf(ctx, current, [spec]), spec, headerFor(spec, current.language)), current.language);
      await store.mutate(runId, (latest) => {
        // New work after the lead was told the run finished opens a new round, so the lead hears back again.
        const reopened = roundComplete(latest) && latest.notifiedRound >= latest.round ? { ...latest, round: latest.round + 1, rounds: Math.max(latest.rounds, latest.round + 1) } : latest;
        return addPost(upsertMember(reopened, { role: spec.name, agentId: started.agentId, title: started.title, task: "" }, now()), { author: "lead", agentId: run.leadAgentId, kind: "note", text: latest.language === "zh" ? `${started.title}（${spec.name}）为它的待办任务加入了运行。` : `${started.title} (${spec.name}) joined the run for its open tasks.`, to: [], files: [] }, now()).run;
      });
    } catch (error) {
      console.error(`[agent-team] run ${runId}: could not staff ${role}`, error);
    } finally {
      staffing.delete(lock);
    }
  }
}

type Action =
  | { kind: "dispatch"; run: Run; assignments: { taskId: string; agentId: string }[] }
  | { kind: "verdicts"; run: Run; owners: { agentId: string; taskIds: string[]; dispatchedAt: string }[] }
  | { kind: "plans"; taskIds: string[] }
  | { kind: "round"; run: Run }
  | { kind: "notify"; round: number; previous: number };

/**
 * After a change: staff roles that have work, hand open tasks to idle members, tell the lead about plans waiting for it,
 * start the next team round, or tell an idle lead that its run needs it. Whether to act is decided inside the run's
 * serialized update, so two callers racing (a hook and agent-team wait's reconcile) never act twice.
 */
function advance(runId: string, depth = 0): Promise<void> {
  return asActor("plugin", () => moveAlong(runId, depth));
}

async function moveAlong(runId: string, depth: number): Promise<void> {
  if (depth > 6) return;
  await staff(runId).catch((error) => console.error(`[agent-team] staffing ${runId} failed`, error));
  let action: Action | null = null;
  await store.mutate(runId, (current) => {
    const step = nextStep(current);
    if (step.kind === "dispatch") {
      const next = assignTasks(current, step.assignments, now());
      action = { kind: "dispatch", run: next, assignments: step.assignments };
      return next;
    }
    if (step.kind === "verdicts") {
      // The owners wait idle for the lead's verdict: they go back to work with it now.
      let next = markVerdictsDelivered(current, step.taskIds, true, now());
      const owners = new Map<string, string[]>();
      for (const id of step.taskIds) {
        const owner = taskOf(current, id)!.owner!;
        owners.set(owner, [...(owners.get(owner) ?? []), id]);
      }
      const stamp = now();
      for (const owner of owners.keys()) next = updateMember(next, owner, { state: "working", collected: false, dispatchedAt: stamp }, stamp);
      action = { kind: "verdicts", run: next, owners: [...owners].map(([agentId, taskIds]) => ({ agentId, taskIds, dispatchedAt: stamp })) };
      return next;
    }
    if (step.kind === "plans") {
      action = { kind: "plans", taskIds: step.taskIds };
      return markPlansNotified(current, step.taskIds, true, now());
    }
    if (step.kind === "next-round") {
      const started = startRound(current, now());
      action = { kind: "round", run: started };
      return started;
    }
    if (step.kind === "notify-lead") {
      action = { kind: "notify", round: current.round, previous: current.notifiedRound };
      return { ...current, notifiedRound: current.round };
    }
    return current;
  }).catch(() => undefined);
  const taken = action as Action | null;
  if (!taken) return;
  if (taken.kind === "dispatch") {
    const ctx = await leadContext({ id: taken.run.leadAgentId, workspaceId: taken.run.workspaceId }).catch(() => null);
    for (const { taskId, agentId } of taken.assignments) {
      const member = memberOf(taken.run, agentId);
      const task = taskOf(taken.run, taskId);
      // assignTasks skips an assignment that went stale between planning and applying it.
      if (!member || !task || task.owner !== agentId || task.state !== "doing") continue;
      const spec = ctx ? roleSpec(ctx, member.role) : null;
      const sent = await sendWhenIdle(agentId, promptsFor(taken.run.language).assignmentPrompt(taken.run, task, spec ? headerFor(spec, taken.run.language) : "")).catch(() => false);
      if (sent) continue;
      // The member couldn't take it (busy in another turn, or gone): the task goes back on the board.
      await store.mutate(runId, (current) => {
        const back = releaseTask(current, agentId, task.id, now()).run;
        const latest = memberOf(back, agentId);
        return latest?.dispatchedAt === member.dispatchedAt && latest.state === "working" ? updateMember(back, agentId, { state: "done" }, now()) : back;
      });
    }
    await advance(runId, depth + 1);
    return;
  }
  if (taken.kind === "verdicts") {
    for (const owner of taken.owners) {
      const tasks = owner.taskIds.map((id) => taskOf(taken.run, id)).filter((task): task is BoardTask => !!task);
      const sent = await sendWhenIdle(owner.agentId, promptsFor(taken.run.language).planReviewedPrompt(taken.run, tasks)).catch(() => false);
      if (sent) {
        await store.log(runId, tasks.map((task) => ({ component: "plans", action: "verdict", direction: "out", from: "plugin", to: [owner.agentId], subject: task.id, note: task.plan?.status ?? "" })));
        continue;
      }
      // Not delivered: keep the verdicts for the owner's next tool result or the next try.
      await store.mutate(runId, (current) => {
        const back = markVerdictsDelivered(current, owner.taskIds, false, now());
        const latest = memberOf(back, owner.agentId);
        return latest?.dispatchedAt === owner.dispatchedAt && latest.state === "working" ? updateMember(back, owner.agentId, { state: "done" }, now()) : back;
      });
    }
    await advance(runId, depth + 1);
    return;
  }
  if (taken.kind === "plans") {
    const run = store.get(runId)!;
    const plans = taken.taskIds.map((id) => taskOf(run, id)).filter((task): task is BoardTask => !!task);
    const sent = await sendWhenIdle(run.leadAgentId, plans.map((task) => promptsFor(run.language).planWaitingPrompt(run, task)).join("\n\n---\n\n"), 4).catch(() => false);
    // Not sent (the lead is busy): agent-team wait shows them, and the lead's turn end or the sweep tries again.
    if (!sent) await store.mutate(runId, (current) => markPlansNotified(current, taken.taskIds, false, now()));
    else {
      const seen = new Set<string>();
      await store.log(runId, plans.flatMap((task) => (seen.has(task.id) ? [] : [{ component: "plans" as const, action: "notify" as const, direction: "out" as const, from: "plugin" as const, to: ["lead"], subject: (seen.add(task.id), task.id), note: excerpt(task.plan?.text, 140) }])));
    }
    return;
  }
  if (taken.kind === "round") {
    for (const member of taken.run.members.filter((entry) => entry.state === "working")) {
      const sent = await sendWhenIdle(member.agentId, promptsFor(taken.run.language).teamRoundPrompt(taken.run, member.readSeq)).catch(() => false);
      if (sent) continue;
      console.error(`[agent-team] run ${runId}: could not start round ${taken.run.round} for ${member.title}`);
      await store.mutate(runId, (current) => finishMember(current, member.agentId, "failed", `(could not start round ${current.round}: the agent was not idle or is gone)`, now()));
    }
    await advance(runId, depth + 1);
    return;
  }
  const run = store.get(runId)!;
  const sent = await sendWhenIdle(run.leadAgentId, promptsFor(run.language).leadNoticePrompt(run), 4).catch(() => false);
  // Not sent (the lead is busy): give the notice back, so the lead's turn end or the sweep sends it.
  if (!sent) await store.mutate(runId, (current) => (current.notifiedRound === taken.round ? { ...current, notifiedRound: taken.previous } : current));
  else await store.log(runId, [{ component: run.mode === "team" ? "tasks" : "reports", action: "notify", direction: "out", from: "plugin", to: ["lead"], subject: run.mode === "team" ? String(taken.round) : `batch ${taken.round}`, note: "" }]);
}

/**
 * Finishes a member only if it is still on the work it had when the caller looked, and was given that work well before
 * the turn ended, so a late event for an earlier turn can't end newer work. A real turn takes longer than the margin; a
 * turn that really was shorter is caught up by reconcile.
 */
const DISPATCH_MARGIN_MS = 3000;
function finishIfCurrent(runId: string, seen: RunMember, endedAt: number, outcome: "completed" | "failed" | "canceled", message: string | null): Promise<Run> {
  return store.mutate(runId, (current) => {
    const member = memberOf(current, seen.agentId);
    if (!member || (member.state !== "working" && member.state !== "attention") || member.dispatchedAt !== seen.dispatchedAt) return current;
    if (Date.parse(member.dispatchedAt) > endedAt - DISPATCH_MARGIN_MS) return current;
    return finishMember(current, seen.agentId, outcome, message, now());
  });
}

/** Catches up members whose lifecycle events were missed, for example while the plugin reloaded. */
async function reconcile(runId: string): Promise<void> {
  const run = store.get(runId);
  if (!run) return;
  const workspaceId = store.lead(run.leadAgentId)?.workspaceId ?? null;
  if (workingMembers(run).length) await refreshAgents(workspaceId);
  for (const member of workingMembers(run)) {
    if (Date.now() - Date.parse(member.dispatchedAt) < 30_000) continue;
    if (!(await agentAlive(member.agentId, workspaceId))) {
      await finishIfCurrent(runId, member, Date.now(), "failed", "(the member's agent stopped or its terminal was closed)");
      continue;
    }
    const state = orca().stateOf(member.agentId);
    if (state === "blocked") {
      if (member.state !== "attention") await store.mutate(runId, (current) => (memberOf(current, member.agentId)?.state === "working" ? updateMember(current, member.agentId, { state: "attention" }, now()) : current));
    } else if (state === "done" || state === "waiting") {
      // Its turn ended, or it has been idle for long enough that it never will.
      const turn = await memberTurnEnded(member.agentId, member);
      if (turn.ended || Date.now() - Date.parse(member.dispatchedAt) > 600_000) {
        const message = reports.get(member.agentId) ?? turn.text ?? (await lastMessage(member.agentId));
        reports.delete(member.agentId);
        await finishIfCurrent(runId, member, Date.now(), "completed", message);
      }
    } else if (member.state === "attention") {
      await store.mutate(runId, (current) => (memberOf(current, member.agentId)?.state === "attention" ? updateMember(current, member.agentId, { state: "working" }, now()) : current));
    }
  }
  await advance(runId);
}

/** An agent's status changed: a member's turn ended or it needs attention; a lead's turn ended. */
export async function onAgentStatus(payload: { terminalId?: string; state: string; sessionId?: string; mainAgent?: { outcome?: string } }): Promise<void> {
  const terminalId = payload.terminalId;
  if (!terminalId) return;
  await store.load();
  if (payload.state === "working") seenWorking.set(terminalId, Date.now());
  const lead = store.lead(terminalId);
  if (lead && payload.sessionId && lead.agentSessionId !== payload.sessionId) await store.patchLead(terminalId, { agentSessionId: payload.sessionId });
  const run = store.memberRun(terminalId);
  const member = run ? memberOf(run, terminalId) : undefined;
  if (run && member) {
    if (payload.state === "blocked" && member.state === "working") await store.mutate(run.id, (current) => updateMember(current, terminalId, { state: "attention" }, now()));
    if (payload.state === "working" && member.state === "attention") await store.mutate(run.id, (current) => updateMember(current, terminalId, { state: "working" }, now()));
    if (payload.state === "done" && (member.state === "working" || member.state === "attention")) {
      const turn = await memberTurnEnded(terminalId, member);
      if (turn.ended) {
        const outcome = payload.mainAgent?.outcome === "failure" ? "failed" : payload.mainAgent?.outcome === "cancellation" || payload.mainAgent?.outcome === "interruption" ? "canceled" : "completed";
        const message = reports.get(terminalId) ?? turn.text ?? (await lastMessage(terminalId));
        reports.delete(terminalId);
        await finishIfCurrent(run.id, member, Date.now(), outcome, message);
        await advance(run.id);
      }
    }
  }
  const planner = store.planner(terminalId);
  if (planner && planner.status === "planning" && payload.state === "done") await finishPlanner(terminalId);
  if (lead && payload.state === "done") {
    // A delegation lead that collected every report of a batch ends its turn with the batch's summary.
    // The transcript may trail the status by a moment: try again shortly.
    for (const delay of [0, 1500, 4000, 9000]) {
      if (delay) await sleep(delay);
      if (await trySummarize(terminalId)) break;
    }
    const led = store.leadRun(terminalId, true);
    if (led) await advance(led.id);
  }
}

/** A planner's turn ended: check the team file it wrote, and open it in the team editor. */
async function finishPlanner(terminalId: string): Promise<void> {
  const job = store.planner(terminalId);
  if (!job || job.status !== "planning") return;
  const since = Date.parse(job.startedAt);
  for (const delay of [0, 1500, 4000]) {
    if (delay) await sleep(delay);
    const turn = await claudeTurn(job.root, orca().agents.get(terminalId)?.sessionId ?? null);
    if (turn.found && !(turn.ended && turn.endedAt >= since)) continue;
    const parsed = parseTeam(await readFile(join(job.root, job.file), "utf8").catch(() => ""));
    await store.setPlanner({ ...job, status: parsed.ok ? "done" : "failed", errors: parsed.ok ? [] : parsed.errors, endedAt: now() });
    if (parsed.ok) {
      const workspaces = await orca().listWorkspaces().catch(() => []);
      const row = workspaces.find((entry) => entry.path === job.root);
      if (row) await orca().openFile(row.id, job.file).catch(() => undefined);
      await orca().notify("Agent Team", `${job.file}`);
    }
    return;
  }
}

/** Records a delegation lead's last reply as its batch's summary, once its turn ended after the reports were collected. */
async function trySummarize(leadId: string): Promise<boolean> {
  const newest = store.leadRun(leadId, false);
  const batch = newest ? batchToSummarize(newest) : undefined;
  if (!newest || !batch) return true;
  const collected = newest.events.filter((event) => event.component === "reports" && event.action === "collect").at(-1)?.at;
  const turn = await turnEnded(leadId, collected ? Date.parse(collected) : Date.parse(batch.at));
  const summary = turn.ended === true ? turn.text : turn.ended === null && orca().isIdle(leadId) ? await lastMessage(leadId) : null;
  if (!summary) return false;
  await asActor("lead", () => store.mutate(newest.id, (current) => summarizeBatch(current, summary, now())));
  return true;
}

/** Moves every active run along every minute, so a notice the lead was too busy for, or a missed event, is caught up. */
let sweeping: ReturnType<typeof setInterval> | null = null;
export function startSweep(): () => void {
  if (!sweeping) {
    sweeping = setInterval(() => {
      for (const run of store.activeRuns()) void reconcile(run.id).catch((error) => orca().orca.log(`sweep of ${run.id} failed: ${String(error)}`));
      for (const lead of store.leads().filter((entry) => !entry.endedAt && orca().isIdle(entry.terminalId))) void trySummarize(lead.terminalId).catch(() => undefined);
    }, 30_000);
    sweeping.unref?.();
  }
  return () => {
    if (sweeping) clearInterval(sweeping);
    sweeping = null;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mail: messages addressed to an agent arrive with its next team tool result, so they reach it mid-turn without an
// interruption; an idle recipient is also woken (see agent-team post).

/** Appends the lead's unread messages and the plans waiting for it to a tool result. */
async function withLeadMail(leadId: string, result: Result, lang: PromptLanguage): Promise<Result> {
  const run = store.leadRun(leadId, false);
  if (!run || run.mode !== "team") return result;
  const mail = leadInbox(run);
  const plans = pendingPlans(run);
  if (!mail.length && !plans.length) return result;
  if (mail.length) await store.mutate(run.id, (current) => markInbox(current, "lead", mail.at(-1)!.seq, now()));
  const zh = lang === "zh";
  const extra = [
    inboxText(mail, lang),
    plans.length
      ? `${zh ? `📝 等你审批的计划（${LEAD_TOOLS.tasks}，review）：` : `📝 Plans waiting for your approval (${LEAD_TOOLS.tasks}, review):`}\n${plans.map((task) => `- ${task.id} "${task.title}" ${zh ? "提交者" : "by"} ${task.ownerTitle}: ${excerpt(task.plan!.text, 400)}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");
  return { ...result, text: `${result.text ?? ""}\n\n${extra}` };
}

/** Appends the member's unread messages, and the lead's verdicts on its plans, to a tool result. */
async function withMail(runId: string, agentId: string, result: Result): Promise<Result> {
  const run = store.get(runId);
  if (!run) return result;
  const mail = inboxOf(run, agentId);
  const verdicts = undeliveredVerdicts(run).filter((task) => task.owner === agentId);
  if (!mail.length && !verdicts.length) return result;
  await store.mutate(runId, (current) => {
    const read = mail.length ? markInbox(current, agentId, mail.at(-1)!.seq, now()) : current;
    const delivered = verdicts.length ? markVerdictsDelivered(read, verdicts.map((task) => task.id), true, now()) : read;
    return logEvents(delivered, verdicts.map((task) => ({ component: "plans", action: "verdict", direction: "out", from: "plugin", to: [agentId], subject: task.id, note: task.plan?.status ?? "" })), now());
  });
  const P = promptsFor(run.language);
  const heading = run.language === "zh" ? "🧾 协调器对你的计划作出了决定：" : "🧾 The lead decided on your plans:";
  const extra = [inboxText(mail, run.language), verdicts.length ? `${heading}\n${verdicts.map((task) => `- ${P.verdictLine(task)}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  return { ...result, text: `${result.text ?? ""}\n\n${extra}` };
}

/** In auto mode, the first run fixes the session's mode for good. */
async function lockIfAuto(ctx: LeadContext, leadId: string, mode: CollabMode): Promise<void> {
  if (ctx.effective === "auto" && !ctx.locked) await store.lockSession(leadId, mode);
}

/** Mirrors a delegated task on the run's task board, owned by its member, so the dashboard shows it. */
function mirrorTask(run: Run, role: string, agentId: string, title: string, task: string): Run {
  const result = addTasks(run, [{ title: excerpt(task.split("\n").find((line) => line.trim()) ?? task, 80), detail: task, role }], "lead", now());
  const id = result.added[0]?.id;
  const mirrored = { ...result.run, tasks: result.run.tasks.map((entry) => (entry.id === id ? { ...entry, state: "doing" as const, owner: agentId, ownerTitle: title } : entry)) };
  return id ? attachPacket(mirrored, id) : mirrored;
}

/** A sub-agent's context in a delegation run: started for the packet, or an idle member continued with what it already knows. */
function contextEvent(agentId: string, spec: MemberSpec, continued: boolean, note = ""): NewEvent {
  return { component: "contexts", action: continued ? "continue" : "start", direction: "out", from: "plugin", to: [agentId], subject: spec.name, note: note || runtimeLabel(spec) };
}

function leadTeamRun(leadId: string): Run | undefined {
  const run = store.leadRun(leadId, false);
  return run?.mode === "team" ? run : undefined;
}

/** The plugin is about to act on its own (hand out a task, start a round), so a wait shouldn't stop yet. */
function nextStepPending(run: Run): boolean {
  const step = nextStep(run);
  return step.kind === "dispatch" || step.kind === "verdicts" || step.kind === "next-round";
}

/** The caller's team run; a member that is idle in the run's view but calls a tool is in a turn, so it is marked working. */
async function memberTeamRun(agentId: string): Promise<{ run: Run; member: RunMember } | null> {
  const found = store.memberRun(agentId);
  const seen = found ? memberOf(found, agentId) : undefined;
  if (!found || !seen || found.mode !== "team") return null;
  const run = seen.state === "done" && !seen.retired ? await store.mutate(found.id, (current) => touchMember(current, agentId, now())) : found;
  return { run, member: memberOf(run, agentId)! };
}

/** Roles in one batch whose folders overlap, which then edit the same files at the same time. */
function overlappingRoles(specs: readonly MemberSpec[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < specs.length; i += 1) {
    for (let j = i + 1; j < specs.length; j += 1) {
      const a = specs[i]!;
      const b = specs[j]!;
      const left = a.folders.length ? a.folders : [""];
      const right = b.folders.length ? b.folders : [""];
      if (left.some((x) => right.some((y) => pathsOverlap(x, y)))) pairs.push([a.name, b.name]);
    }
  }
  return pairs;
}

/**
 * The team tools in one language: descriptions, parameter notes and every result an agent reads. An agent gets the set
 * of its language (its LANGUAGE_LABEL), so a Chinese team works and replies in Chinese.
 */
function buildTools(lang: PromptLanguage): { lead: ToolDef[]; member: ToolDef[] } {
  const zh = lang === "zh";
  const tr = (en: string, cn: string) => (zh ? cn : en);
  const P = promptsFor(lang);
  const L = LEAD_TOOLS;
  const leadMail = (leadId: string, result: Result) => withLeadMail(leadId, result, lang);
  const modeName = (mode: TeamMode) => (zh ? ({ auto: "自动", team: "团队", delegation: "委派", none: "无" } as const)[mode] : mode);

  const MODE_HINT: Record<TeamMode, string> = zh
    ? {
        auto: `按需求选择：团队模式（先与用户对接需求，${L.brief}，用户确认后 ${L.kickoff}）或委派模式（${L.delegate}）。第一次启动运行后，本会话就固定为那个模式。`,
        team: `团队模式：先和用户确定需求简报与任务计划（${L.brief}），再 ${L.kickoff}。${L.delegate} 会被拒绝。`,
        delegation: `委派模式：拆分需求后运行 ${L.delegate}。${L.kickoff} 会被拒绝。`,
        none: `无协作：你自己完成工作，不启动任何成员。${L.delegate} 和 ${L.kickoff} 会被拒绝。`,
      }
    : {
        auto: `Pick per request: team mode (intake with the user, ${L.brief}, confirmation, ${L.kickoff}) or delegation mode (${L.delegate}). The first run you start fixes the session to that mode.`,
        team: `Team mode: agree a brief and a task plan with the user first (${L.brief}), then ${L.kickoff}. ${L.delegate} is refused.`,
        delegation: `Delegation mode: split the request and run ${L.delegate}. ${L.kickoff} is refused.`,
        none: `No collaboration: do the work yourself and start no members. ${L.delegate} and ${L.kickoff} are refused.`,
      };

  const refusal = (ctx: LeadContext): string => {
    if (ctx.locked) {
      return tr(
        `This session is locked to ${ctx.locked} mode: in auto mode, the first run fixed it for the whole session. ${MODE_HINT[ctx.locked]} Only resetting the session changes it.`,
        `本会话已锁定为${modeName(ctx.locked)}模式：自动模式下第一次运行就固定了整个会话的模式。${MODE_HINT[ctx.locked]} 只有重置会话才能更改。`,
      );
    }
    const how = ctx.override ? tr("The user switched this session to it", "用户为本会话切换到了该模式") : tr("The team file sets it", "来自团队文件");
    return tr(
      `This session is in ${ctx.effective} mode (${how}). ${MODE_HINT[ctx.effective]} The user can switch the mode with the "Mode" button on your chat's composer.`,
      `本会话处于${modeName(ctx.effective)}模式（${how}）。${MODE_HINT[ctx.effective]} 用户可以用对话输入框旁的「模式」按钮切换。`,
    );
  };

  const hint = (ctx: LeadContext): string => {
    const fixed = ctx.team.roles.map((role) => role.name);
    const formed = ctx.sessionRoles.map((role) => role.name);
    return [
      fixed.length ? tr(`Roles: ${fixed.join(", ")}.`, `固定角色：${fixed.join(", ")}。`) : "",
      formed.length ? tr(`Roles you formed: ${formed.join(", ")}.`, `你建的角色：${formed.join(", ")}。`) : "",
      ctx.team.candidates.length
        ? tr(`Candidates, which take work directly: ${ctx.team.candidates.map((candidate) => candidate.name).join(", ")}; or form a narrower role on one with ${L.role}.`, `候选成员（可直接把工作交给它们）：${ctx.team.candidates.map((candidate) => candidate.name).join(", ")}；也可以用 ${L.role} 在某个候选上建更具体的角色。`)
        : tr(`Or "${HELPER}".`, `或者用 "${HELPER}"。`),
    ].filter(Boolean).join(" ");
  };
  const unknownRole = (ctx: LeadContext, role: string) => tr(`Unknown role "${role}". ${hint(ctx)}`, `未知角色「${role}」。${hint(ctx)}`);

  const rosterText = (ctx: LeadContext): string => {
    const { team } = ctx;
    const lines: string[] = [];
    if (team.roles.length) {
      lines.push(tr("Fixed roles:", "固定角色："), tr("| Role | Agent/model | Folders |", "| 角色 | Agent/模型 | 文件夹 |"), "| --- | --- | --- |", ...team.roles.map((role) => `| ${role.name} | ${runtimeLabel(role)} | ${role.folders.length ? role.folders.join(", ") : tr("(any)", "（不限）")} |`));
    }
    if (team.candidates.length) {
      lines.push("", tr("Candidate members (give work to them directly by name, or form a narrower role on one; assign by description, and never give a candidate work its description rules out):", "候选成员（可按名称直接交给它们工作，也可在某个候选上建更具体的角色；按描述分工，描述里排除的工作绝不交给它）："));
      for (const candidate of team.candidates) {
        lines.push(`- ${candidate.name} (${runtimeLabel(candidate)})`, ...(candidate.notes.trim() ? candidate.notes.trim().split("\n").map((line) => `  ${line.trim()}`) : [tr("  (no description)", "  （无描述）")]));
      }
      lines.push("", ctx.sessionRoles.length ? tr("Roles you formed in this session:", "本会话中你建的角色：") : tr("Roles you formed in this session: none.", "本会话中你建的角色：无。"));
      if (ctx.sessionRoles.length) lines.push(tr("| Role | Candidate | Folders | Instructions |", "| 角色 | 候选成员 | 文件夹 | 说明 |"), "| --- | --- | --- | --- |", ...ctx.sessionRoles.map((role) => `| ${role.name} | ${role.candidate} (${runtimeLabel(role)}) | ${role.folders.length ? role.folders.join(", ") : tr("(any)", "（不限）")} | ${excerpt(role.instructions, 120) || "-"} |`));
    } else {
      lines.push(`| ${HELPER} | ${runtimeLabel(team.lead)} | ${tr("(any; delegation only, when no role fits)", "（不限；仅委派模式，没有合适角色时使用）")} |`);
    }
    return lines.join("\n");
  };

  /** The roles of a team run: the given ones, else those its tasks name, else every fixed role, else every formed role. */
  const teamSpecs = (ctx: LeadContext, names: readonly string[] | undefined, tasks: readonly NewTask[]): MemberSpec[] | string => {
    const fromTasks = tasks.map((task) => task.role).filter((role): role is string => !!role);
    const wanted = names?.length ? names : fromTasks.length ? fromTasks : ctx.team.roles.length ? ctx.team.roles.map((role) => role.name) : ctx.sessionRoles.map((role) => role.name);
    if (!wanted.length) return tr(`No roles yet. ${hint(ctx)}`, `还没有角色。${hint(ctx)}`);
    const specs: MemberSpec[] = [];
    for (const name of [...wanted, ...fromTasks]) {
      const spec = roleSpec(ctx, name);
      if (!spec || spec.name === HELPER) return unknownRole(ctx, name);
      if (!specs.some((entry) => key(entry.name) === key(spec.name))) specs.push(spec);
    }
    return specs;
  };

  const planText = (tasks: readonly NewTask[]): string[] =>
    tasks.map((task, index) => `${index + 1}. ${task.title} (${task.role ?? tr("anyone", "任何人")})${task.after?.length ? ` · ${tr("after", "等待")} ${task.after.join(", ")}` : ""}${task.files?.length ? ` · ${tr("files", "文件")}: ${task.files.join(", ")}` : ""}${task.detail ? `\n   ${task.detail}` : ""}`);

  /** What agent-team wait shows the lead, and the last board post it includes. */
  const resultsText = (run: Run): { text: string; readSeq: number } => {
    if (run.mode === "team") {
      const unread = run.posts.filter((post) => post.seq > run.leadReadSeq).length;
      const page = boardPage(run, run.leadReadSeq, BOARD_LIMIT);
      return { text: [runSummary(run), "", tr(`Board since your last read (${unread} posts):`, `你上次读取后的黑板（${unread} 条）：`), page.text, page.more ? tr(`Read the rest with ${L.board}.`, `其余内容用 ${L.board} 读取。`) : ""].filter(Boolean).join("\n"), readSeq: page.lastSeq };
    }
    const state = (member: RunMember) => (zh ? ({ working: "进行中", done: "已完成", attention: "需处理", failed: "失败" } as const)[member.state] : member.state);
    const members = run.members.map((member) => [`## ${member.title} (${member.role}): ${state(member)}`, member.state === "working" || member.state === "attention" ? tr("(no result yet)", "（还没有结果）") : member.result ?? tr("(finished without a final reply)", "（结束时没有最终回复）")].join("\n"));
    return { text: [runSummary(run), "", ...members].join("\n\n"), readSeq: run.leadReadSeq };
  };

  const notInTeam = tr("You are not in a team run right now, so there is no board. Report in your final reply; the lead reads it.", "你现在不在团队运行中，没有黑板。请在最终回复里汇报，协调器会阅读。");

  // ----- Lead tools

  const statusTool = defineTool({
    name: L.status,
    title: tr("Team status", "团队状态"),
    description: tr(
      "The team's roles and candidate members, this session's collaboration mode (team, delegation, auto or none), the roles you formed and the run in progress. Call it before acting on each request.",
      "团队的角色和候选成员、本会话的协作模式（团队、委派、自动或无）、你建的角色以及进行中的运行。处理每个需求前先调用它。",
    ),
    input: z.object({}),
    async execute(_input, { agent }) {
      const ctx = await leadContext(agent);
      const run = store.leadRun(agent.id, false);
      const source = ctx.locked
        ? tr(" (auto settled on it; locked for this session)", "（自动模式已确定，本会话锁定）")
        : ctx.override ? tr(` (switched by the user for this session; the team file says ${ctx.team.mode})`, `（用户为本会话切换；团队文件设置为 ${modeName(ctx.team.mode)}）`) : tr(" (from the team file)", "（来自团队文件）");
      return leadMail(agent.id, ok([
        tr(`Team file: ${ctx.file}`, `团队文件：${ctx.file}`) + (ctx.team.goal.trim() ? tr(` · goal: ${ctx.team.goal.trim()}`, ` · 目标：${ctx.team.goal.trim()}`) : ""),
        tr(`Mode: ${ctx.effective}${source}.`, `模式：${modeName(ctx.effective)}${source}。`),
        MODE_HINT[ctx.effective],
        "",
        rosterText(ctx),
        "",
        run ? runSummary(run) : tr("No run yet.", "还没有运行。"),
      ].join("\n"), { mode: ctx.effective, configured: ctx.team.mode, override: ctx.override, locked: ctx.locked, run: run ? { id: run.id, mode: run.mode, status: run.status, round: run.round, rounds: run.rounds } : null }));
    },
  });

  const roleTool = defineTool({
    name: L.role,
    title: tr("Form a role", "建角色"),
    description: tr(
      "With candidate members: form a narrower role for this session on one candidate (its own instructions and folders, or a second job on the same model), change its candidate, or remove it. Not needed to give work to a candidate: name the candidate as the role. A role can only run on a candidate's agent and model.",
      "有候选成员时：在某个候选上为本会话建一个更具体的角色（有自己的说明和文件夹，或在同一模型上承担第二份工作），更换它的候选，或删除它。只是把工作交给候选的话不需要建角色：直接把候选名当作角色。角色只能运行在候选成员的 agent 和模型上。",
    ),
    input: z.object({
      name: z.string().min(1).describe(tr("Short lowercase role name, such as api or tester", "简短的小写角色名，例如 api 或 tester")),
      candidate: z.string().optional().describe(tr("The candidate member to run it on; required for a new role", "运行它的候选成员；新角色必填")),
      instructions: z.string().optional().describe(tr("What the role does and how; repeated in each task it gets", "这个角色做什么、怎么做；会附在它的每个任务里")),
      folders: z.array(z.string()).optional().describe(tr("Folders the role owns; empty for no limit", "角色负责的文件夹；为空表示不限")),
      remove: z.boolean().optional().describe(tr("Remove the role instead", "改为删除这个角色")),
    }),
    async execute({ name, candidate, instructions, folders, remove }, { agent }) {
      const ctx = await leadContext(agent);
      if (!ctx.team.candidates.length) return fail(tr(`This team has no candidate members, so it uses its fixed roles: ${ctx.team.roles.map((role) => role.name).join(", ")}.`, `这个团队没有候选成员，只用固定角色：${ctx.team.roles.map((role) => role.name).join(", ")}。`));
      const roleName = name.trim();
      if (RESERVED.has(key(roleName))) return fail(tr(`"${roleName}" is reserved; pick another name.`, `「${roleName}」是保留名，请换一个。`));
      if (ctx.team.roles.some((role) => key(role.name) === key(roleName))) return fail(tr(`"${roleName}" is a fixed role of the team; pick another name.`, `「${roleName}」是团队的固定角色，请换一个名字。`));
      if (ctx.team.candidates.some((entry) => key(entry.name) === key(roleName))) return fail(tr(`"${roleName}" is a candidate's name; give the candidate work directly by that name, or pick another name for a narrower role.`, `「${roleName}」是候选成员的名字；直接用这个名字把工作交给它，或为更具体的角色另起名字。`));
      const existing = ctx.sessionRoles.find((role) => key(role.name) === key(roleName));
      const active = store.leadRun(agent.id, true);
      const busy = active?.members.some((member) => !member.retired && key(member.role) === key(roleName) && (member.state === "working" || member.state === "attention"));
      if (remove) {
        if (!existing) return fail(tr(`There is no role "${roleName}" you formed.`, `你没有建过角色「${roleName}」。`));
        if (busy) return fail(tr(`A member of ${roleName} is still working. Run ${L.wait} first.`, `${roleName} 的成员还在工作，请先运行 ${L.wait}。`));
        await store.setSessionRoles(agent.id, ctx.sessionRoles.filter((role) => role !== existing));
        if (active) await store.mutate(active.id, (current) => retireRole(current, roleName, now()));
        return leadMail(agent.id, ok(tr(`Removed ${roleName}.`, `已删除 ${roleName}。`)));
      }
      const pick = candidate ? ctx.team.candidates.find((entry) => key(entry.name) === key(candidate)) : existing ? ctx.team.candidates.find((entry) => key(entry.name) === key(existing.candidate)) : undefined;
      const list = ctx.team.candidates.map((entry) => `${entry.name} (${runtimeLabel(entry)})`).join(", ");
      if (!pick) return fail(candidate ? tr(`There is no candidate "${candidate}". Candidates: ${list}.`, `没有候选成员「${candidate}」。候选成员：${list}。`) : tr(`Pick a candidate for the new role. Candidates: ${list}.`, `请为新角色选择一个候选成员。候选成员：${list}。`));
      const moved = existing !== undefined && (existing.agent !== pick.agent || existing.model !== pick.model || existing.effort !== pick.effort);
      if (moved && busy) return fail(tr(`A member of ${roleName} is still working on ${existing!.candidate}. Run ${L.wait} first.`, `${roleName} 的成员还在 ${existing!.candidate} 上工作，请先运行 ${L.wait}。`));
      const role: SessionRole = {
        name: existing?.name ?? roleName,
        candidate: pick.name,
        agent: pick.agent,
        model: pick.model,
        effort: pick.effort,
        folders: (folders ?? existing?.folders ?? []).map((folder) => folder.trim()).filter(Boolean),
        instructions: (instructions ?? existing?.instructions ?? "").trim(),
        createdAt: existing?.createdAt ?? now(),
      };
      await store.setSessionRoles(agent.id, [...ctx.sessionRoles.filter((entry) => entry !== existing), role]);
      // Moving a role to another model retires its member in a run in progress; open tasks of the role get a new member.
      if (moved && active) {
        await store.mutate(active.id, (current) => retireRole(current, role.name, now()));
        await advance(active.id);
      }
      const where = `${pick.name} (${runtimeLabel(pick)})`;
      return leadMail(agent.id, ok(tr(
        `${existing ? "Updated" : "Formed"} ${role.name} on ${where}${role.folders.length ? `, folders ${role.folders.join(", ")}` : ""}.${moved ? " Its earlier member is retired." : ""}`,
        `已${existing ? "更新" : "建立"}角色 ${role.name}，运行在 ${where}${role.folders.length ? `，文件夹 ${role.folders.join(", ")}` : ""}。${moved ? "它之前的成员已退役。" : ""}`,
      )));
    },
  });

  const delegateTool = defineTool({
    name: L.delegate,
    title: tr("Delegate tasks", "委派任务"),
    description: tr(
      `Delegation mode (${MODE_SPECS.delegation.pattern}): give self-contained tasks to roles. Each member sees only its own task and reports back only to you. Returns at once; then run ${L.wait}.`,
      `委派模式（${MODE_SPECS.delegation.pattern}）：把独立完整的任务交给角色。每个成员只看到自己的任务，只向你汇报。立即返回，之后运行 ${L.wait}。`,
    ),
    input: z.object({
      tasks: z.array(z.object({
        role: z.string().min(1).describe(tr(`A fixed role, a candidate's name (assign by its description), a role you formed, or "${HELPER}" (teams without candidates) when nothing fits`, `固定角色、候选成员名（按其描述分工）、你建的角色，或在都不合适时用 "${HELPER}"（仅限没有候选成员的团队）`)),
        task: z.string().min(1).describe(tr("A self-contained task: context, files, acceptance criteria and what to report back", "独立完整的任务：背景、文件、验收标准，以及要汇报什么")),
      })).min(1).max(8),
      title: z.string().optional().describe(tr("A short title for the user's request", "用户需求的简短标题")),
      reason: z.string().optional().describe(tr("In auto mode: why delegation fits this request", "自动模式下：为什么这个需求适合委派")),
    }),
    async execute({ tasks, title, reason }, { agent }) {
      const ctx = await leadContext(agent);
      if (!allowsMode(ctx.effective, "delegation")) return fail(refusal(ctx));
      // Several tasks for one role go to that role as one task, so its member works through them in order.
      const byRole = new Map<string, { spec: MemberSpec; tasks: string[] }>();
      for (const entry of tasks) {
        const spec = roleSpec(ctx, entry.role);
        if (!spec) return fail(unknownRole(ctx, entry.role));
        const group = byRole.get(key(spec.name)) ?? { spec, tasks: [] };
        group.tasks.push(entry.task.trim());
        byRole.set(key(spec.name), group);
      }
      let run = store.leadRun(agent.id, true);
      if (run && run.mode !== "delegation") {
        const blocked = await closeActive(agent.id, lang);
        if (blocked) return fail(blocked);
        run = undefined;
      }
      if (run) {
        const busy = [...byRole.values()].filter((group) => run!.members.some((member) => key(member.role) === key(group.spec.name) && (member.state === "working" || member.state === "attention")));
        if (busy.length) return fail(tr(`${busy.map((group) => group.spec.name).join(", ")} still work on run ${run.id}. Run ${L.wait} first, or ${L.send} to change their task.`, `${busy.map((group) => group.spec.name).join(", ")} 还在运行 ${run.id} 中工作。请先运行 ${L.wait}，或用 ${L.send} 修改它们的任务。`));
      }
      await lockIfAuto(ctx, agent.id, "delegation");
      if (run) {
        run = await store.mutate(run.id, (current) => ({ ...startBatch(current, now()), title: title?.trim() || current.title, reason: reason?.trim() || current.reason }));
      } else {
        const first = tasks[0]!.task;
        run = await store.create(createRun({ id: store.newId(), leadAgentId: agent.id, workspaceId: ctx.workspaceId, mode: "delegation", title: title?.trim() || excerpt(first, 60), reason, language: lang, now: now() }));
      }
      const overlaps = overlappingRoles([...byRole.values()].map((group) => group.spec));
      const warnings = overlaps.map(([a, b]) => tr(`${a} and ${b} may edit the same files at the same time; make sure their tasks touch different files.`, `${a} 和 ${b} 可能同时改同一批文件，请确保它们的任务涉及不同文件。`));
      // The split is recorded before the packets go out, so the dashboard shows it first.
      run = await store.mutate(run.id, (current) => addBatch(current, { title: title?.trim() || excerpt(tasks[0]!.task, 60), reason: reason?.trim() ?? "", warnings: overlaps.map(([a, b]) => `${a} ↔ ${b}`), followUp: false }, now()));
      const lines: string[] = [];
      for (const { spec, tasks: parts } of byRole.values()) {
        const task = parts.length === 1 ? parts[0]! : parts.map((part, index) => `### ${tr("Part", "第")} ${index + 1}${zh ? " 部分" : ""}\n${part}`).join("\n\n");
        const header = headerFor(spec, lang);
        try {
          const started = await dispatch(ctx, agent.id, spec, P.delegationTaskPrompt(run, header ? `${header}\n\n${task}` : task), lang);
          run = await store.mutate(run.id, (current) => mirrorTask(upsertMember(current, { role: spec.name, agentId: started.agentId, title: started.title, task }, now()), spec.name, started.agentId, started.title, task));
          run = await store.log(run.id, [contextEvent(started.agentId, spec, started.continued)]);
          lines.push(`- ${started.title} (${spec.name}, ${runtimeLabel(spec)}): ${started.continued ? tr("continued", "沿用已有成员") : tr("started", "已启动")}`);
        } catch (error) {
          lines.push(`- ${spec.name}: ${tr("not started", "未启动")}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return ok([
        tr(`Delegation run ${run.id} "${run.title}", batch ${run.round}:`, `委派运行 ${run.id}「${run.title}」，第 ${run.round} 批：`),
        ...lines,
        ...(warnings.length ? ["", tr("Warnings:", "注意："), ...warnings.map((warning) => `- ${warning}`)] : []),
        "",
        tr(`Run ${L.wait} to collect the results.`, `运行 ${L.wait} 收集结果。`),
      ].join("\n"), { runId: run.id, members: run.members.map(({ role, agentId, title: memberTitle, state }) => ({ role, agentId, title: memberTitle, state })) });
    },
  });

  const BriefInput = z.object({
    title: z.string().min(1),
    goal: z.string().min(1),
    requirements: z.array(z.string().min(1)).min(1),
    acceptance: z.array(z.string().min(1)).min(1).describe(tr("Acceptance criteria the result is checked against", "用来检查结果的验收标准")),
    constraints: z.array(z.string()).default([]),
    outOfScope: z.array(z.string()).default([]),
  });

  const PlanTaskInput = z.object({
    title: z.string().min(1),
    detail: z.string().optional().describe(tr("What done means for this task", "这个任务怎样算完成")),
    role: z.string().optional().describe(tr("The role that should do it; omit for anyone", "应该由哪个角色做；不填表示任何人")),
    after: z.array(z.number().int().min(1)).optional().describe(tr("Positions (1-based) of earlier tasks in this list it waits for", "它要等待的、本列表中排在前面的任务序号（从 1 开始）")),
    files: z.array(z.string()).optional().describe(tr("Paths it will change; claimed for its owner while it works", "它会改动的路径；负责人工作期间会被认领")),
  });

  const briefTool = defineTool({
    name: L.brief,
    title: tr("Record the brief", "记录需求简报"),
    description: tr(
      `Team mode (${MODE_SPECS.team.pattern}), end of intake: record the brief and the task plan you are about to show the user. Show them in full and end your turn; once the user confirms in their reply, run ${L.kickoff}. Call it again to replace them after a correction.`,
      `团队模式（${MODE_SPECS.team.pattern}），需求对接的最后一步：记录你要展示给用户的需求简报和任务计划。完整展示后结束本轮；用户回复确认后再运行 ${L.kickoff}。用户修改后再次调用以替换。`,
    ),
    input: z.object({
      brief: BriefInput,
      tasks: z.array(PlanTaskInput).max(30).optional().describe(tr("The work broken into tasks for the shared task board; one task per role when omitted", "拆分到共享任务板上的任务；不填则每个角色一个任务")),
      roles: z.array(z.string().min(1)).optional().describe(tr("The roles taking part; the roles the tasks name when omitted", "参与的角色；不填则为任务中指定的角色")),
      rounds: z.number().int().min(1).max(MAX_ROUNDS).optional().describe(tr("1 = work only; 2 (default) adds a review round in which members check each other's done tasks", "1 = 只做工作；2（默认）增加一轮互评，成员检查彼此已完成的任务")),
      planApproval: z.boolean().optional().describe(tr("Members submit a plan per task and wait for your approval before doing it", "成员每个任务先提交计划，等你批准后再做")),
      reason: z.string().optional().describe(tr("In auto mode: why team mode fits this request", "自动模式下：为什么这个需求适合团队模式")),
    }),
    async execute({ brief, tasks, roles, rounds, planApproval, reason }, { agent }) {
      const ctx = await leadContext(agent);
      if (!allowsMode(ctx.effective, "team")) return fail(refusal(ctx));
      const plan: NewTask[] = (tasks ?? []).map((task) => ({ title: task.title, detail: task.detail, role: task.role?.trim() || null, after: (task.after ?? []).map(String), files: task.files }));
      const specs = teamSpecs(ctx, roles, plan);
      if (typeof specs === "string") return fail(specs);
      const check = addTasks(createRun({ id: "R0", leadAgentId: agent.id, workspaceId: ctx.workspaceId, mode: "team", title: "check", language: lang, now: now() }), plan, "lead", now());
      if (check.errors.length) return fail(`${tr("The task plan has problems:", "任务计划有问题：")}\n${check.errors.map((error) => `- ${error}`).join("\n")}`);
      // Only what the user says after this point can confirm the brief.
      const tail = await orca().readTerminal(agent.id, 400);
      const recorded = { title: brief.title.trim(), goal: brief.goal.trim(), requirements: brief.requirements, acceptance: brief.acceptance, constraints: brief.constraints, outOfScope: brief.outOfScope };
      const pending: PendingBrief & { transcript?: string[] } = { brief: recorded, roles: specs.map((spec) => spec.name), rounds: rounds ?? DEFAULT_TEAM_ROUNDS, reason: reason?.trim() ?? "", tasks: plan, planApproval: planApproval === true, seq: 0, at: now(), transcript: tail };
      await store.setPendingBrief(agent.id, pending);
      return ok([
        tr("Brief recorded. Show it to the user as below, with the task plan and the roles taking part, ask them to confirm or correct it, and end your turn. Don't start members yet.", "需求简报已记录。请把下面的简报、任务计划和参与角色展示给用户，请对方确认或修改，然后结束本轮。先不要启动成员。"),
        "",
        briefText({ ...recorded, userConfirmation: "" }, lang),
        "",
        tr("Task plan:", "任务计划："),
        ...(plan.length ? planText(plan) : pending.roles.map((role, index) => tr(`${index + 1}. ${role}: its part of the brief (${role})`, `${index + 1}. ${role}：简报中属于它的部分（${role}）`))),
        "",
        tr(`Roles: ${pending.roles.join(", ")} · rounds: ${pending.rounds}${pending.planApproval ? " · plans need your approval" : ""}`, `角色：${pending.roles.join(", ")} · 轮数：${pending.rounds}${pending.planApproval ? " · 计划需要你审批" : ""}`),
        "",
        tr(`When they confirm, run ${L.kickoff} with their confirming words. When they correct it, run ${L.brief} again.`, `用户确认后，用其确认原话运行 ${L.kickoff}；用户修改后，再次运行 ${L.brief}。`),
      ].join("\n"));
    },
  });

  const kickoffTool = defineTool({
    name: L.kickoff,
    title: tr("Start a team run", "启动团队运行"),
    description: tr(
      `Team mode (${MODE_SPECS.team.pattern}): start the team on the brief and task plan recorded with ${L.brief}, once the user has confirmed them. Posts the brief, fills the task board and starts the roles together. Returns at once; then run ${L.wait}.`,
      `团队模式（${MODE_SPECS.team.pattern}）：用户确认后，按 ${L.brief} 记录的简报和任务计划启动团队。会发布简报、填好任务板并同时启动各角色。立即返回，之后运行 ${L.wait}。`,
    ),
    input: z.object({
      userConfirmation: z.string().min(1).describe(tr("The user's words confirming the brief, quoted exactly from the message they sent after you showed it", "用户确认简报的原话，必须原样引用你展示简报之后用户发的消息")),
    }),
    async execute({ userConfirmation }, { agent }) {
      const ctx = await leadContext(agent);
      if (!allowsMode(ctx.effective, "team")) return fail(refusal(ctx));
      const pending = store.pendingBrief(agent.id);
      if (!pending) return fail(tr(`No brief is recorded. Finish intake: run ${L.brief} with the brief and task plan, show them to the user and end your turn; start the team after they confirm.`, `还没有记录需求简报。请先完成需求对接：用 ${L.brief} 记录简报和任务计划，展示给用户并结束本轮；用户确认后再启动团队。`));
      if (!(await userConfirmed(agent.id, pending, userConfirmation))) {
        return fail(tr(
          `userConfirmation must quote the user's reply to the brief recorded with ${L.brief}: a message they sent after you showed it. It does not match one. Show the user the brief, end your turn, and call this tool once they confirm. A request, or anything said before the brief, cannot confirm it.`,
          `userConfirmation 必须引用用户对 ${L.brief} 所记录简报的回复，也就是你展示简报之后用户发的消息，现在对不上。请把简报展示给用户并结束本轮，等用户确认后再调用。需求本身或简报之前说的话都不能算确认。`,
        ));
      }
      const tasks = pending.tasks ?? [];
      const specs = teamSpecs(ctx, pending.roles, tasks);
      if (typeof specs === "string") return fail(`${specs} ${tr(`Record the brief again with ${L.brief}.`, `请用 ${L.brief} 重新记录简报。`)}`);
      const blocked = await closeActive(agent.id, lang);
      if (blocked) return fail(blocked);
      await lockIfAuto(ctx, agent.id, "team");
      const full: Brief = { ...pending.brief, userConfirmation: userConfirmation.trim() };
      let run = await store.create(createRun({ id: store.newId(), leadAgentId: agent.id, workspaceId: ctx.workspaceId, mode: "team", title: full.title, reason: pending.reason, rounds: pending.rounds, brief: full, planApproval: pending.planApproval, language: lang, now: now() }));
      await store.setPendingBrief(agent.id, null);
      const plan = tasks.length ? tasks : specs.map((spec) => ({
        title: tr(`${spec.name}: its part of the brief`, `${spec.name}：简报中属于它的部分`),
        detail: tr(`Do the part of the brief that falls to the ${spec.name} role. Split it into further tasks (${MEMBER_TOOLS.task}, action "add") when it is large.`, `完成简报中属于 ${spec.name} 角色的部分。工作量大时拆成更多任务（${MEMBER_TOOLS.task}，action "add"）。`),
        role: spec.name,
      }));
      // Kickoff starts these roles itself; staffing (from a member's first tool call, or the sweep) must not race it.
      const locks = specs.map((spec) => `${run.id}:${key(spec.name)}`);
      for (const lock of locks) staffing.add(lock);
      const lines: string[] = [];
      try {
        run = await store.mutate(run.id, (current) => addTasks(addPost(current, { author: "lead", agentId: agent.id, kind: "brief", text: briefText(full, lang), to: [], files: [] }, now()).run, plan, "lead", now()).run);
        const roster = rosterOf(ctx, run, specs);
        for (const spec of specs) {
          try {
            const started = await dispatch(ctx, agent.id, spec, P.teamKickoffPrompt(run, full, roster, spec, headerFor(spec, lang)), lang);
            run = await store.mutate(run.id, (current) => upsertMember(current, { role: spec.name, agentId: started.agentId, title: started.title, task: "" }, now()));
            lines.push(`- ${started.title} (${spec.name}, ${runtimeLabel(spec)}): ${started.continued ? tr("continued", "沿用已有成员") : tr("started", "已启动")}`);
          } catch (error) {
            lines.push(`- ${spec.name}: ${tr("not started", "未启动")}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        for (const lock of locks) staffing.delete(lock);
      }
      return ok([
        tr(`Team run ${run.id} "${run.title}" started, ${run.rounds} round${run.rounds === 1 ? "" : "s"}${run.planApproval ? ", plans need your approval" : ""}. The brief is post #1 on the board.`, `团队运行 ${run.id}「${run.title}」已启动，共 ${run.rounds} 轮${run.planApproval ? "，计划需要你审批" : ""}。简报是黑板上的第 1 条帖子。`),
        ...lines,
        "",
        taskBoardText(run, lang),
        "",
        tr(`Run ${L.wait}. The plugin hands open tasks to idle members, starts members for roles with work, and runs the review round by itself.`, `运行 ${L.wait}。插件会把待办任务派给空闲成员、为有任务但没有成员的角色启动成员，并自动进行互评轮。`),
      ].join("\n"), { runId: run.id, members: run.members.map(({ role, agentId, title }) => ({ role, agentId, title })) });
    },
  });

  const tasksTool = defineTool({
    name: L.tasks,
    title: tr("Manage the task board", "管理任务板"),
    description: tr(
      "Team mode: add tasks, edit or reassign them (role), reopen a task (state todo; with feedback a done task goes back to its role), drop tasks, and approve or send back plans that wait for your approval. Members take open tasks; idle ones get them handed by the plugin.",
      "团队模式：新增任务、修改或改派任务（role）、重新打开任务（state todo；已完成的任务带 feedback 会退回给原角色）、取消任务，以及批准或打回等你审批的计划。成员会自己领取待办任务，空闲成员由插件派发。",
    ),
    input: z.object({
      add: z.array(z.object({
        title: z.string().min(1),
        detail: z.string().optional(),
        role: z.string().optional().describe(tr("The role that should do it; omit for anyone", "应该由哪个角色做；不填表示任何人")),
        after: z.array(z.string()).optional().describe(tr("Ids of tasks it waits for, such as T2", "它要等待的任务编号，例如 T2")),
        files: z.array(z.string()).optional(),
      })).optional(),
      update: z.array(z.object({
        id: z.string().min(1),
        title: z.string().optional(),
        detail: z.string().optional(),
        role: z.string().nullable().optional().describe(tr("Reassign to a role, or null for anyone", "改派给某个角色，null 表示任何人")),
        state: z.enum(["todo", "dropped"]).optional().describe(tr("todo reopens (a done task needs feedback); dropped cancels", "todo 重新打开（已完成的任务需要 feedback）；dropped 取消")),
        after: z.array(z.string()).optional(),
        feedback: z.string().optional().describe(tr("Why it is reopened or reassigned; the next owner reads it", "为什么重新打开或改派；下一个负责人会看到")),
      })).optional(),
      review: z.array(z.object({
        id: z.string().min(1),
        approve: z.boolean(),
        feedback: z.string().optional().describe(tr("Required when sending a plan back", "打回计划时必填")),
      })).optional(),
    }),
    async execute({ add, update, review }, { agent }) {
      const ctx = await leadContext(agent);
      const run = leadTeamRun(agent.id);
      if (!run || run.status !== "active") return fail(tr(`There is no team run in progress. Start one with ${L.kickoff} after intake.`, `没有进行中的团队运行。完成需求对接后用 ${L.kickoff} 启动。`));
      const anyone = (role: string) => key(role) === "anyone" || role.trim() === "任何人";
      const roleErrors = [...(add ?? []).map((task) => task.role), ...(update ?? []).map((change) => change.role)]
        .filter((role): role is string => typeof role === "string" && role.trim() !== "" && !anyone(role))
        .filter((role) => { const spec = roleSpec(ctx, role); return !spec || spec.name === HELPER; })
        .map((role) => unknownRole(ctx, role));
      if (roleErrors.length) return fail([...new Set(roleErrors)].join("\n"));
      const errors: string[] = [];
      await store.mutate(run.id, (current) => {
        let state = current;
        if (add?.length) {
          const result = addTasks(state, add.map((task) => ({ ...task, role: task.role && !anyone(task.role) ? task.role : null })), "lead", now());
          errors.push(...result.errors);
          state = result.run;
        }
        for (const change of update ?? []) {
          const before = taskOf(state, change.id);
          if (before?.state === "done" && change.state === "todo") {
            const result = rejectTask(state, change.id, change.feedback ?? "", now());
            if (result.error) errors.push(result.error);
            else state = updateTasks(result.run, [{ ...change, state: undefined, feedback: undefined } as TaskChange], now()).run;
            continue;
          }
          const result = updateTasks(state, [{ ...change, role: change.role === undefined ? undefined : change.role && !anyone(change.role) ? change.role : null } as TaskChange], now());
          errors.push(...result.errors);
          state = result.run;
          // A member that loses a task it is working on is told, so it stops instead of doing it twice.
          const after = taskOf(state, change.id);
          if (before?.state === "doing" && before.owner && before.ownerTitle && after?.owner !== before.owner) {
            const reason = change.feedback ? ` (${change.feedback.trim()})` : "";
            const text = zh
              ? `${before.id}「${before.title}」：协调器${after?.state === "dropped" ? "已取消这个任务" : "已把它从你这里收回"}${reason}。请停止这个任务。`
              : `${before.id} "${before.title}": the lead ${after?.state === "dropped" ? "dropped it" : "took it off you"}${reason}. Stop working on it.`;
            state = addPost(state, { author: "lead", agentId: agent.id, kind: "note", text, to: [before.ownerTitle], files: [] }, now()).run;
          }
        }
        // A verdict reaches its owner through the plugin: the next tool result of a working owner, or a wake-up when idle.
        for (const verdict of review ?? []) {
          const result = reviewPlan(state, verdict.id, verdict.approve, verdict.feedback ?? "", now());
          if (result.error) errors.push(result.error);
          else state = result.run;
        }
        return { ...state, status: "active" };
      });
      await advance(run.id);
      const latest = store.get(run.id)!;
      return leadMail(agent.id, ok([
        errors.length ? `${tr("Some changes were not made:", "部分修改没有完成：")}\n${errors.map((error) => `- ${error}`).join("\n")}\n` : tr("Done.", "已完成。"),
        taskBoardText(latest, lang),
        "",
        tr(`Run ${L.wait} for the members.`, `运行 ${L.wait} 等待成员。`),
      ].join("\n")));
    },
  });

  const broadcastTool = defineTool({
    name: L.broadcast,
    title: tr("Post to the team", "发给团队"),
    description: tr(
      "Team mode: post a message from you on the board and send it to the members (all, or the given roles). Use it to settle a contradiction or answer a question; members that finished go back to work on it.",
      "团队模式：以你的名义在黑板上发帖并发给成员（全部，或指定角色）。用于解决分歧或回答问题；已完成的成员会据此继续工作。",
    ),
    input: z.object({
      message: z.string().min(1),
      roles: z.array(z.string().min(1)).optional().describe(tr("Only these roles; every member of the run when omitted", "只发给这些角色；不填则发给本次运行的所有成员")),
    }),
    async execute({ message, roles }, { agent }) {
      await leadContext(agent);
      const run = leadTeamRun(agent.id);
      if (!run) return fail(tr(`There is no team run. Start one with ${L.kickoff} after intake.`, `没有团队运行。完成需求对接后用 ${L.kickoff} 启动。`));
      const wanted = roles?.length ? new Set(roles.map(key)) : null;
      const targets = run.members.filter((member) => member.state !== "failed" && !member.retired && (!wanted || wanted.has(key(member.role))));
      if (!targets.length) return fail(tr(`No member of run ${run.id} matches ${roles?.join(", ")}.`, `运行 ${run.id} 中没有成员匹配 ${roles?.join(", ")}。`));
      let posted = 0;
      let next = await store.mutate(run.id, (current) => {
        const result = addPost({ ...current, status: "active" }, { author: "lead", agentId: agent.id, kind: "note", text: message, to: roles?.length ? roles : [TO_ALL], files: [] }, now());
        posted = result.post.seq;
        return result.run;
      });
      const idle: RunMember[] = [];
      for (const member of targets) {
        // Only an idle member is woken, and its state follows only a send that went through, so no turn is interrupted.
        const unread = inboxOf(store.get(run.id)!, member.agentId);
        const sent = await sendIfIdle(member.agentId, promptsFor(next.language).mentionPrompt(next, unread.length ? unread : next.posts.filter((post) => post.seq === posted))).catch(() => false);
        if (!sent) continue;
        idle.push(member);
        next = await store.mutate(run.id, (current) => markInbox(wakeMembers(current, [member.agentId], now()), member.agentId, Math.max(posted, unread.at(-1)?.seq ?? 0), now()));
      }
      const running = targets.filter((member) => !idle.includes(member));
      return leadMail(agent.id, ok([
        tr(`Posted on the board of run ${run.id} (round ${next.round} of ${next.rounds}).`, `已发到运行 ${run.id} 的黑板（第 ${next.round}/${next.rounds} 轮）。`),
        idle.length ? tr(`Sent to: ${idle.map((member) => member.title).join(", ")}.`, `已发给：${idle.map((member) => member.title).join(", ")}。`) : "",
        running.length ? tr(`Still working, it reaches them with their next tool result: ${running.map((member) => member.title).join(", ")}.`, `仍在工作的成员会在下一次工具返回中收到：${running.map((member) => member.title).join(", ")}。`) : "",
        tr(`Run ${L.wait} for their answers.`, `运行 ${L.wait} 等待他们的回复。`),
      ].filter(Boolean).join("\n")));
    },
  });

  const sendTool = defineTool({
    name: L.send,
    title: tr("Message a member", "发消息给成员"),
    description: tr(
      "Send a follow-up to one member of the current run, for example to fix an incomplete result. The member must have finished its turn.",
      "给当前运行的某个成员发后续消息，例如让它补全不完整的结果。该成员必须已结束本轮。",
    ),
    input: z.object({
      role: z.string().optional().describe(tr("The member's role", "成员的角色")),
      agentId: z.string().optional().describe(tr("The member's agent id, when several members share a role", "成员的 agent id（多个成员共用一个角色时）")),
      message: z.string().min(1),
    }),
    async execute({ role, agentId, message }, { agent }) {
      const ctx = await leadContext(agent);
      const run = store.leadRun(agent.id, false);
      if (!run) return fail(tr(`There is no run yet. Use ${L.delegate} or ${L.kickoff}.`, `还没有运行。请用 ${L.delegate} 或 ${L.kickoff}。`));
      const member = agentId ? memberOf(run, agentId) : [...run.members].reverse().find((entry) => role !== undefined && key(entry.role) === key(role) && !entry.retired);
      if (!member) return fail(tr(`No member of run ${run.id} matches ${agentId ?? role ?? "(no role or agentId given)"}. Members: ${run.members.map((entry) => `${entry.title} (${entry.role})`).join(", ")}.`, `运行 ${run.id} 中没有成员匹配 ${agentId ?? role ?? "（未给出 role 或 agentId）"}。成员：${run.members.map((entry) => `${entry.title}（${entry.role}）`).join(", ")}。`));
      if (!(await isIdleAgent(member.agentId, ctx.lead.workspaceId))) return fail(tr(`${member.title} is still working. Run ${L.wait} first, so the message doesn't interrupt it.`, `${member.title} 还在工作。请先运行 ${L.wait}，以免打断它。`));
      const spec = roleSpec(ctx, member.role);
      const header = spec ? headerFor(spec, run.language) : "";
      const MP = promptsFor(run.language);
      if (run.mode === "team") {
        let posted = 0;
        const withPost = await store.mutate(run.id, (current) => {
          const result = addPost({ ...current, status: "active" }, { author: "lead", agentId: agent.id, kind: "note", text: message, to: [member.title], files: [] }, now());
          posted = result.post.seq;
          return result.run;
        });
        const unread = inboxOf(withPost, member.agentId);
        const sent = await sendIfIdle(member.agentId, MP.mentionPrompt(withPost, unread)).catch(() => false);
        if (!sent) return leadMail(agent.id, fail(tr(`${member.title} just started working; it gets your message with its next tool result.`, `${member.title} 刚开始工作，会在下一次工具返回中收到你的消息。`)));
        await store.mutate(run.id, (current) => markInbox(wakeMembers(current, [member.agentId], now()), member.agentId, Math.max(posted, unread.at(-1)?.seq ?? 0), now()));
      } else {
        const sent = await sendIfIdle(member.agentId, MP.delegationTaskPrompt(run, header ? `${header}\n\n${message}` : message)).catch(() => false);
        if (!sent) return leadMail(agent.id, fail(tr(`${member.title} just started working. Run ${L.wait} first.`, `${member.title} 刚开始工作，请先运行 ${L.wait}。`)));
        await store.mutate(run.id, (current) => {
          const batch = startBatch({ ...current, status: "active" }, now());
          // A follow-up is a packet of its own for one member, in the member's existing context.
          const opened = addBatch(batch, { title: excerpt(message.split("\n").find((line) => line.trim()) ?? message, 60), reason: "", warnings: [], followUp: true }, now());
          return mirrorTask(updateMember(opened, member.agentId, { state: "working", collected: false, task: message, dispatchedAt: now() }, now()), member.role, member.agentId, member.title, message);
        });
        if (spec) await store.log(run.id, [contextEvent(member.agentId, spec, true, member.title)]);
      }
      return leadMail(agent.id, ok(tr(`Sent to ${member.title}. Run ${L.wait} for the result.`, `已发给 ${member.title}。运行 ${L.wait} 等待结果。`)));
    },
  });

  const waitTool = defineTool({
    name: L.wait,
    title: tr("Wait for the team", "等待团队"),
    description: tr(
      `Wait until the current run's members finish (a team run: its last round, with no open task left for an idle member), a member needs attention, a plan waits for your approval, a member writes to you, or the timeout passes; then return their results or the new board posts. At most ${MAX_WAIT_SECONDS} seconds per call; call again while members still work.`,
      `等待当前运行的成员完成（团队运行：最后一轮，且没有可派给空闲成员的待办任务），或有成员需要处理、有计划等你审批、有成员给你发消息、或超时；然后返回结果或黑板上的新帖子。每次最多 ${MAX_WAIT_SECONDS} 秒；成员还在工作时请再次调用。`,
    ),
    input: z.object({ timeoutSeconds: z.number().int().min(5).max(MAX_WAIT_SECONDS).optional().describe(tr(`Default 300, at most ${MAX_WAIT_SECONDS}`, `默认 300，最多 ${MAX_WAIT_SECONDS}`)) }),
    async execute({ timeoutSeconds }, { agent, signal }) {
      const ctx = await leadContext(agent);
      const first = store.leadRun(agent.id, false);
      if (!first) return fail(tr(`There is no run yet. Use ${L.delegate} or ${L.kickoff}.`, `还没有运行。请用 ${L.delegate} 或 ${L.kickoff}。`));
      const deadline = Date.now() + (timeoutSeconds ?? 300) * 1000;
      // Things already known when the wait began were reported before; only new ones end the wait early.
      const known = new Set(first.members.filter((member) => member.state === "attention").map((member) => member.agentId));
      const knownPlans = new Set(pendingPlans(first).map((task) => task.id));
      const mailFrom = first.posts.at(-1)?.seq ?? 0;
      let lastCheck = 0;
      // A run isn't finished while the plugin is starting members for roles that have work.
      const finished = (run: Run) => runFinished(run) && !isStaffing(run.id) && (run.mode !== "team" || !staffableRoles(ctx, run).length);
      for (;;) {
        const run = store.get(first.id)!;
        const final = finished(run);
        const attention = run.members.some((member) => member.state === "attention" && !known.has(member.agentId));
        const plans = pendingPlans(run).some((task) => !knownPlans.has(task.id));
        const mail = leadInbox(run).some((post) => post.seq > mailFrom);
        const stalled = run.members.length === 0 || (!run.members.some((member) => member.state === "working") && !nextStepPending(run) && !isStaffing(run.id));
        if (final || attention || plans || mail || stalled || Date.now() >= deadline || signal.aborted) break;
        if (Date.now() - lastCheck > 10_000) {
          lastCheck = Date.now();
          await reconcile(run.id).catch((error) => console.error(`[agent-team] reconcile ${run.id} failed`, error));
          continue;
        }
        await sleep(2000, signal);
      }
      const run = store.get(first.id)!;
      const final = finished(run);
      const { text, readSeq } = resultsText(run);
      await store.mutate(run.id, (current) => ({ ...markCollected(current, now(), readSeq), notifiedRound: final ? Math.max(current.notifiedRound, current.round) : current.notifiedRound }));
      const head = final
        ? run.mode === "team"
          ? tr("The team run has finished. Check the done tasks against the brief's acceptance criteria, send back what misses them, and report to the user.", "团队运行已结束。请对照简报的验收标准检查已完成的任务，把不达标的打回，然后向用户汇报。")
          : tr("Every member has finished.", "所有成员都已完成。")
        : pendingPlans(run).length
          ? tr(`Plans wait for your approval: review them with ${L.tasks}.`, `有计划等你审批：用 ${L.tasks} 审批。`)
          : run.members.some((member) => member.state === "attention")
            ? tr("A member needs attention (a permission prompt or an error): tell the user which one. Others may still work.", "有成员需要处理（权限请求或出错）：告诉用户是哪一个。其他成员可能还在工作。")
            : tr(`Members are still working. Run ${L.wait} again, or answer the user meanwhile; the plugin tells you when the run has finished.`, `成员还在工作。请再次运行 ${L.wait}，或先回复用户；运行结束时插件会通知你。`);
      return leadMail(agent.id, ok(`${head}\n\n${text}`, { runId: run.id, final, members: run.members.map(({ role, title, state }) => ({ role, title, state })) }));
    },
  });

  const boardTool = defineTool({
    name: L.board,
    title: tr("Read the team board", "读取团队黑板"),
    description: tr("Team mode: read the shared board of the current team run: the task board, the brief and every member's posts.", "团队模式：读取当前团队运行的共享黑板：任务板、需求简报和每个成员的帖子。"),
    input: z.object({ since: z.number().int().min(0).optional().describe(tr("Only posts after this number", "只读取这个编号之后的帖子")) }),
    async execute({ since }, { agent }) {
      await leadContext(agent);
      const run = leadTeamRun(agent.id);
      if (!run) return fail(tr("There is no team run.", "没有团队运行。"));
      const page = boardPage(run, since ?? 0, BOARD_LIMIT);
      await store.mutate(run.id, (current) => ({ ...current, leadReadSeq: Math.max(current.leadReadSeq, page.lastSeq) }));
      return leadMail(agent.id, ok(`${runSummary(run)}\n\n${page.text}`));
    },
  });

  const closeTool = defineTool({
    name: L.close,
    title: tr("Close the run", "结束运行"),
    description: tr(
      "End the current run once the user accepted its result: it is closed, file claims are released, and with closeMembers the members' terminals are closed. A new run also closes the previous one.",
      "用户接受结果后结束当前运行：运行关闭、释放文件认领；设置 closeMembers 时会关闭成员的终端。启动新运行也会关闭上一次运行。",
    ),
    input: z.object({
      closeMembers: z.boolean().optional().describe(tr("Close the members' terminals; they are started again when needed", "关闭成员的终端；需要时会重新启动")),
      archiveMembers: z.boolean().optional().describe(tr("Same as closeMembers", "同 closeMembers")),
      note: z.string().optional().describe(tr("A closing note for the board", "写在黑板上的结束说明")),
    }),
    async execute({ closeMembers, archiveMembers: legacyArchive, note }, { agent }) {
      const archiveMembers = closeMembers ?? legacyArchive;
      await leadContext(agent);
      const run = store.leadRun(agent.id, true);
      if (!run) return ok(tr("No run is in progress.", "没有进行中的运行。"));
      const working = workingMembers(run);
      if (working.length) return fail(tr(`${working.map((member) => member.title).join(", ")} still work. Run ${L.wait} first.`, `${working.map((member) => member.title).join(", ")} 还在工作，请先运行 ${L.wait}。`));
      await store.mutate(run.id, (current) => {
        const noted = note?.trim() && current.mode === "team" ? addPost(current, { author: "lead", agentId: agent.id, kind: "note", text: note.trim(), to: [], files: [] }, now()).run : current;
        return { ...noted, status: "closed", claims: [], updatedAt: now() };
      });
      let archived = 0;
      if (archiveMembers) {
        for (const member of run.members) {
          if (!(await isIdleAgent(member.agentId, store.lead(agent.id)?.workspaceId ?? null))) continue;
          await orca().closeTerminal(member.agentId).then(() => { archived += 1; }, () => undefined);
        }
      }
      const open = run.tasks.filter((task) => task.state === "todo" || task.state === "doing");
      const ids = open.map((task) => task.id).join(", ");
      return ok(zh
        ? `已结束运行 ${run.id}「${run.title}」。${archiveMembers ? `已关闭 ${archived} 个成员的终端。` : ""}${open.length ? `还有 ${open.length} 个任务未完成：${ids}。` : ""}`
        : `Closed run ${run.id} "${run.title}".${archiveMembers ? ` Closed ${archived} member terminal${archived === 1 ? "" : "s"}.` : ""}${open.length ? ` ${open.length} task${open.length === 1 ? " was" : "s were"} still open: ${ids}.` : ""}`);
    },
  });

  // ----- Member tools

  const readTool = defineTool({
    name: MEMBER_TOOLS.read,
    title: tr("Read the team board", "读取团队黑板"),
    description: tr("Read your team run's shared board: the brief the user agreed, the task board, claimed files and every member's posts.", "读取你所在团队运行的共享黑板：用户确认的需求简报、任务板、已认领的文件和每个成员的帖子。"),
    input: z.object({ since: z.number().int().min(0).optional().describe(tr("Only posts after this number; all posts and the brief when omitted", "只读取这个编号之后的帖子；不填则读取全部帖子和简报")) }),
    async execute({ since }, { agent }) {
      await store.load();
      const found = await memberTeamRun(agent.id);
      if (!found) return fail(notInTeam);
      const { run, member } = found;
      const claims = run.claims.length ? `\n\n${tr("Claimed paths", "已认领的路径")}: ${run.claims.map((claim) => `${claim.path || "."} (${claim.role})`).join(", ")}` : "";
      const page = boardPage(run, since ?? 0, BOARD_LIMIT);
      const ready = run.tasks.filter((task) => taskReady(run, task) && mayTake(member, task)).map((task) => task.id);
      await store.mutate(run.id, (current) => markInbox(updateMember(current, agent.id, { readSeq: Math.max(memberOf(current, agent.id)?.readSeq ?? 0, page.lastSeq) }, now()), agent.id, page.lastSeq, now()));
      return withMail(run.id, agent.id, ok([
        tr(`Team run ${run.id}, round ${run.round} of ${run.rounds}. You are ${member.title} (${member.role}).`, `团队运行 ${run.id}，第 ${run.round}/${run.rounds} 轮。你是 ${member.title}（${member.role}）。`) + (member.retired ? tr(" You were replaced in this run: take no more tasks.", "你在这次运行中已被替换：不要再领取任务。") : ""),
        "",
        taskBoardText(run, lang),
        ready.length ? tr(`Ready for you: ${ready.join(", ")}.`, `你可以领取：${ready.join(", ")}。`) : tr("No task is ready for you.", "现在没有你可以领取的任务。"),
        "",
        page.text + claims,
      ].join("\n")));
    },
  });

  const postTool = defineTool({
    name: MEMBER_TOOLS.post,
    title: tr("Post to the team board", "在团队黑板发帖"),
    description: tr(
      `Post on your team run's shared board. Kinds: update (a decision others depend on), finding (a problem in someone's work), question (set "to"), answer, done (your part is finished: what changed and how you checked it). Address roles, "lead" or "${TO_ALL}" with "to"; addressed members get it in their next tool result, and are woken when idle.`,
      `在团队运行的共享黑板上发帖。kind：update（别人依赖的决定）、finding（别人工作中的问题）、question（需设置 "to"）、answer、done（你的部分完成了：改了什么、怎么验证的）。用 "to" 指定角色、成员名、"lead" 或 "${TO_ALL}"；收件成员会在下一次工具返回中收到，空闲时会被唤醒。`,
    ),
    input: z.object({
      kind: z.enum(MEMBER_POST_KINDS),
      text: z.string().min(1),
      to: z.array(z.string().min(1)).optional().describe(tr(`Role names, a member's title, "lead", or "${TO_ALL}"`, `角色名、成员名、"lead" 或 "${TO_ALL}"`)),
      files: z.array(z.string().min(1)).optional().describe(tr("Files the post is about", "帖子涉及的文件")),
    }),
    async execute({ kind, text, to, files }, { agent }) {
      await store.load();
      const found = await memberTeamRun(agent.id);
      if (!found) return fail(notInTeam);
      const { member } = found;
      const recipients = [...new Set((to ?? []).map((name) => name.trim()).filter(Boolean))];
      let posted = 0;
      const run = await store.mutate(found.run.id, (current) => {
        const result = addPost(current, { author: member.role, agentId: agent.id, kind, text, to: recipients, files: files ?? [] }, now());
        posted = result.post.seq;
        return result.run;
      });
      const notes: string[] = [];
      const everyone = recipients.some((name) => key(name) === TO_ALL);
      if (recipients.some((name) => key(name) === "lead")) {
        const message = zh
          ? `${PLUGIN_MESSAGE_PREFIX} ${member.title}（${member.role}）在团队运行 ${run.id} 的黑板上给你留言（#${posted}，${kind}）：\n${text}\n\n用 ${L.broadcast} 或 ${L.send} 回复；如果涉及需求变更，先问用户。请用中文回复。`
          : `${PLUGIN_MESSAGE_PREFIX} ${member.title} (${member.role}) wrote to you on the board of team run ${run.id} (#${posted}, ${kind}):\n${text}\n\nAnswer with ${L.broadcast} or ${L.send}; ask the user first when it changes the requirement.`;
        const sent = await sendIfIdle(run.leadAgentId, message).catch(() => false);
        if (sent) await store.mutate(run.id, (current) => markInbox(current, "lead", posted, now()));
        notes.push(sent ? tr("The lead was told.", "已通知协调器。") : tr("The lead gets it with its next tool result.", "协调器会在下一次工具返回中收到。"));
      }
      const targets = run.members.filter((entry) => entry.agentId !== agent.id && !entry.retired && entry.state !== "failed" && (everyone || recipients.some((name) => key(name) === key(entry.role) || key(name) === key(entry.title))));
      for (const name of recipients) {
        if (key(name) !== "lead" && key(name) !== TO_ALL && !run.members.some((entry) => key(entry.role) === key(name) || key(entry.title) === key(name))) notes.push(tr(`No member of this run has the role or title "${name}".`, `本次运行中没有角色或成员名为「${name}」的成员。`));
      }
      for (const target of targets) {
        if (target.state === "working" || target.state === "attention") {
          notes.push(tr(`${target.title} gets it with its next tool result.`, `${target.title} 会在下一次工具返回中收到。`));
        } else if (target.state === "done" && target.nudges < MAX_NUDGES && run.status === "active") {
          const unread = inboxOf(store.get(run.id)!, target.agentId);
          const sent = await sendIfIdle(target.agentId, promptsFor(run.language).mentionPrompt(run, unread)).catch(() => false);
          if (sent) await store.mutate(run.id, (current) => markInbox(updateMember(current, target.agentId, { state: "working", nudges: target.nudges + 1, collected: false, dispatchedAt: now() }, now()), target.agentId, unread.at(-1)?.seq ?? posted, now()));
          notes.push(sent ? tr(`${target.title} was woken to answer.`, `已唤醒 ${target.title} 来回复。`) : tr(`${target.title} will see it on the board.`, `${target.title} 会在黑板上看到。`));
        } else {
          notes.push(tr(`${target.title} will see it on the board.`, `${target.title} 会在黑板上看到。`));
        }
      }
      return withMail(run.id, agent.id, ok([tr(`Posted #${posted}.`, `已发帖 #${posted}。`), ...notes, kind === "done" ? tr("Your claims are released. End your turn now unless a task is ready for you.", "你的认领已释放。如果没有可领取的任务，请现在结束本轮。") : ""].filter(Boolean).join(" ")));
    },
  });

  const claimTool = defineTool({
    name: MEMBER_TOOLS.claim,
    title: tr("Claim files", "认领文件"),
    description: tr(
      "Claim the files or folders you are about to edit, so no other member edits them at the same time; or release them. Nothing is claimed when another member holds an overlapping path. Claiming a task already claims its files.",
      "认领你要修改的文件或文件夹，避免其他成员同时修改；也可以释放。别人持有重叠路径时不会认领任何路径。领取任务时已经一并认领了它的文件。",
    ),
    input: z.object({
      paths: z.array(z.string()).min(1).describe(tr('Repository-relative files or folders; "." is the whole repository', '仓库内的相对路径（文件或文件夹）；"." 表示整个仓库')),
      release: z.boolean().optional().describe(tr("Release these paths instead of claiming them", "改为释放这些路径")),
    }),
    async execute({ paths, release }, { agent }) {
      await store.load();
      const found = await memberTeamRun(agent.id);
      if (!found) return fail(notInTeam);
      if (release) {
        await store.mutate(found.run.id, (current) => releaseClaims(current, agent.id, paths));
        return withMail(found.run.id, agent.id, ok(tr(`Released ${paths.join(", ")}.`, `已释放 ${paths.join(", ")}。`)));
      }
      let conflicts: ReturnType<typeof claimPaths>["conflicts"] = [];
      await store.mutate(found.run.id, (current) => {
        const result = claimPaths(current, agent.id, paths, now());
        conflicts = result.conflicts;
        return result.run;
      });
      if (conflicts.length) {
        await store.log(found.run.id, [{ component: "claims", action: "conflict", direction: "in", from: agent.id, to: [...new Set(conflicts.map((conflict) => conflict.heldBy))], subject: conflicts.map((conflict) => conflict.path).join(", "), note: conflicts.map((conflict) => `${conflict.held} (${conflict.heldBy})`).join(", ") }]);
        return withMail(found.run.id, agent.id, fail(zh
          ? `没有认领任何路径：${conflicts.map((conflict) => `${conflict.path} 与 ${conflict.held} 重叠（被 ${conflict.heldBy} 持有）`).join("；")}。请在黑板上问对方（${MEMBER_TOOLS.post}，kind "question"，设置 "to"），不要直接修改。`
          : `Nothing claimed: ${conflicts.map((conflict) => `${conflict.path} overlaps ${conflict.held}, held by ${conflict.heldBy}`).join("; ")}. Ask them on the board (${MEMBER_TOOLS.post} kind "question" with "to") instead of editing it.`));
      }
      return withMail(found.run.id, agent.id, ok(tr(`Claimed ${paths.join(", ")}. Your claims are released when you post "done" or your turn ends.`, `已认领 ${paths.join(", ")}。发 "done" 帖子或本轮结束时会自动释放。`)));
    },
  });

  const taskTool = defineTool({
    name: MEMBER_TOOLS.task,
    title: tr("Work with the task board", "操作任务板"),
    description: tr(
      'Your team run\'s task board. action "claim": take a ready task (the given id, or the next ready one for you); "done": finish your task with a result (what you changed and how you checked it); "release": put your task back; "add": add a task for work you found (title, detail, role, after, files); "plan": submit your plan for a task when the run needs plan approval; "reject": send another member\'s done task back to its role with a reason (review).',
      '你所在团队运行的任务板。action "claim"：领取一个可做的任务（指定 id，或领取下一个适合你的）；"done"：带 result 完成你的任务（改了什么、怎么验证的）；"release"：把任务放回任务板；"add"：为你发现的工作新增任务（title、detail、role、after、files）；"plan"：需要计划审批时提交任务计划；"reject"：带理由把别的成员已完成的任务打回给原角色（评审）。',
    ),
    input: z.object({
      action: z.enum(["claim", "done", "release", "add", "plan", "reject"]),
      id: z.string().optional().describe(tr("The task, such as T3", "任务编号，例如 T3")),
      result: z.string().optional().describe(tr('For "done": what you changed and how you checked it', '"done" 用：改了什么、怎么验证的')),
      text: z.string().optional().describe(tr('For "plan": what you will change and how you will check it', '"plan" 用：准备改什么、怎么验证')),
      reason: z.string().optional().describe(tr('For "reject": what is wrong', '"reject" 用：问题是什么')),
      title: z.string().optional().describe(tr('For "add"', '"add" 用')),
      detail: z.string().optional().describe(tr('For "add": what done means', '"add" 用：怎样算完成')),
      role: z.string().optional().describe(tr('For "add": the role that should do it; omit for anyone', '"add" 用：应由哪个角色做；不填表示任何人')),
      after: z.array(z.string()).optional().describe(tr('For "add": ids of tasks it waits for', '"add" 用：它要等待的任务编号')),
      files: z.array(z.string()).optional().describe(tr('For "add": paths it will change', '"add" 用：它会改动的路径')),
    }),
    async execute(input, { agent }) {
      await store.load();
      const found = await memberTeamRun(agent.id);
      if (!found) return fail(notInTeam);
      const { member } = found;
      const runId = found.run.id;
      const need = (value: string | undefined, what: string) => (value?.trim() ? null : tr(`Give ${what}.`, `请提供${what}。`));
      let error: string | undefined;
      let reply = "";
      if (input.action === "claim") {
        if (member.retired) return withMail(runId, agent.id, fail(tr("You were replaced in this run; take no more tasks. End your turn.", "你在这次运行中已被替换，不要再领取任务。请结束本轮。")));
        let task: BoardTask | undefined;
        await store.mutate(runId, (current) => { const result = claimTask(current, agent.id, input.id, now()); error = result.error; task = result.task; return result.run; });
        if (task) {
          reply = [
            tr(`${task.id} is yours: ${task.title}`, `${task.id} 归你了：${task.title}`),
            task.detail,
            task.files.length ? tr(`Files (claimed for you): ${task.files.join(", ")}`, `文件（已为你认领）：${task.files.join(", ")}`) : "",
            task.feedback ? tr(`Sent back before: ${task.feedback}`, `之前被打回的原因：${task.feedback}`) : "",
            found.run.planApproval ? tr(`Submit your plan (action "plan") and end your turn; work once it is approved.`, `先提交计划（action "plan"）并结束本轮，批准后再动手。`) : tr(`When it is finished, mark it done (action "done").`, `完成后标记为完成（action "done"）。`),
          ].filter(Boolean).join("\n");
        }
      } else if (input.action === "done") {
        error = need(input.id, tr("the task id", "任务编号")) ?? need(input.result, tr("a result: what you changed and how you checked it", "结果：改了什么、怎么验证的")) ?? undefined;
        if (!error) await store.mutate(runId, (current) => { const result = completeTask(current, agent.id, input.id!, input.result!, now()); error = result.error; return result.run; });
        if (!error) {
          const run = store.get(runId)!;
          const ready = run.tasks.filter((task) => taskReady(run, task) && mayTake(member, task)).map((task) => task.id);
          const id = input.id!.toUpperCase();
          reply = ready.length
            ? tr(`${id} is done. Ready for you next: ${ready.join(", ")} (action "claim").`, `${id} 已完成。接下来你可以领取：${ready.join(", ")}（action "claim"）。`)
            : tr(`${id} is done. No task is ready for you: post "done" with a summary and end your turn; you are woken when one opens up.`, `${id} 已完成。现在没有你可以领取的任务：发一条 "done" 帖子总结后结束本轮，有新任务时会唤醒你。`);
        }
      } else if (input.action === "release") {
        error = need(input.id, tr("the task id", "任务编号")) ?? undefined;
        if (!error) await store.mutate(runId, (current) => { const result = releaseTask(current, agent.id, input.id!, now()); error = result.error; return result.run; });
        if (!error) reply = tr(`${input.id!.toUpperCase()} is back on the board. Say why on the board (${MEMBER_TOOLS.post}).`, `${input.id!.toUpperCase()} 已放回任务板。请在黑板上说明原因（${MEMBER_TOOLS.post}）。`);
      } else if (input.action === "add") {
        error = need(input.title, tr("a title", "标题")) ?? undefined;
        const role = input.role?.trim() && key(input.role) !== "anyone" && input.role.trim() !== "任何人" ? input.role.trim() : null;
        if (!error && role) {
          const run = store.get(runId)!;
          const ctx = await leadContext({ id: run.leadAgentId, workspaceId: run.workspaceId }).catch(() => null);
          const spec = ctx ? roleSpec(ctx, role) : null;
          const roles = run.members.filter((entry) => !entry.retired).map((entry) => entry.role).join(", ");
          if (!spec || spec.name === HELPER) error = tr(`Unknown role "${role}". Roles in this run: ${roles}; ask the lead for another.`, `未知角色「${role}」。本次运行中的角色：${roles}；需要其他角色请问协调器。`);
        }
        if (!error) {
          let added: BoardTask[] = [];
          await store.mutate(runId, (current) => { const result = addTasks(current, [{ title: input.title!, detail: input.detail, role, after: input.after, files: input.files }], member.role, now()); error = result.errors[0]; added = result.added; return result.run; });
          if (!error) reply = tr(`Added ${added.map((task) => task.id).join(", ")}. It goes to ${role ?? "anyone"} once it is ready.`, `已新增 ${added.map((task) => task.id).join(", ")}。可以开始时会交给 ${role ?? "任何人"}。`);
        }
      } else if (input.action === "plan") {
        error = need(input.id, tr("the task id", "任务编号")) ?? need(input.text, tr("the plan", "计划内容")) ?? undefined;
        if (!error) await store.mutate(runId, (current) => { const result = submitPlan(current, agent.id, input.id!, input.text!, now()); error = result.error; return result.run; });
        if (!error) reply = tr(`Plan for ${input.id!.toUpperCase()} submitted. End your turn now; you are woken when the lead approves it or sends it back.`, `${input.id!.toUpperCase()} 的计划已提交。请现在结束本轮；协调器批准或打回时会唤醒你。`);
      } else {
        error = need(input.id, tr("the task id", "任务编号")) ?? need(input.reason, tr("the reason", "理由")) ?? undefined;
        const task = input.id ? taskOf(store.get(runId)!, input.id) : undefined;
        if (!error && task?.owner === agent.id) error = tr("That is your own task; fix it yourself.", "这是你自己的任务，请自己修正。");
        if (!error) {
          let rejected: BoardTask | undefined;
          await store.mutate(runId, (current) => {
            const result = rejectTask(current, input.id!, input.reason!, now());
            error = result.error;
            rejected = result.task;
            if (!result.task) return result.run;
            const text = zh ? `已打回 ${result.task.id}「${result.task.title}」：${input.reason!.trim()}` : `Sent ${result.task.id} "${result.task.title}" back: ${input.reason!.trim()}`;
            return addPost(result.run, { author: member.role, agentId: agent.id, kind: "finding", text, to: result.task.role ? [result.task.role] : [TO_ALL], files: result.task.files }, now()).run;
          });
          if (rejected) reply = tr(`${rejected.id} goes back to ${rejected.role ?? "anyone"} with your reason.`, `${rejected.id} 已带着你的理由退回给 ${rejected.role ?? "任何人"}。`);
        }
      }
      if (error) return withMail(runId, agent.id, fail(error));
      await advance(runId);
      return withMail(runId, agent.id, ok(reply));
    },
  });

  const reportTool = defineTool({
    name: MEMBER_TOOLS.report,
    title: tr("Report your result", "汇报结果"),
    description: tr(
      "Hand your result to the lead: what you changed (files), how you checked it, and anything left or blocked. In a delegation run it finishes your task at once; in a team run it posts \"done\" with it. End your turn after it.",
      "把结果交给协调器：改了哪些文件、怎么验证的、还有什么没完成或受阻。委派运行中会立即完成你的任务；团队运行中会以 \"done\" 帖子发出。之后结束本轮。",
    ),
    input: z.object({ result: z.string().min(1).describe(tr("Your report, at most 300 words", "你的汇报，不超过 500 字")) }),
    async execute({ result }, { agent }) {
      await store.load();
      const run = store.memberRun(agent.id);
      const member = run ? memberOf(run, agent.id) : undefined;
      if (!run || !member) return fail(notInTeam);
      if (run.mode === "team") {
        await store.mutate(run.id, (current) => addPost(touchMember(current, agent.id, now()), { author: member.role, agentId: agent.id, kind: "done", text: result, to: [], files: [] }, now()).run);
        await advance(run.id);
        return withMail(run.id, agent.id, ok(tr("Posted as done. End your turn unless a task is ready for you.", "已作为 done 帖子发出。如果没有可领取的任务，请结束本轮。")));
      }
      if (member.state === "working" || member.state === "attention") {
        await store.mutate(run.id, (current) => finishMember(current, agent.id, "completed", result, now()));
        await advance(run.id);
      } else {
        // Already counted as finished (its turn looked over): the report replaces what was taken from its screen.
        await store.mutate(run.id, (current) => amendReport(current, agent.id, result), { trace: false });
      }
      return ok(tr("The lead has your report. End your turn now.", "协调器已收到你的汇报。请现在结束本轮。"));
    },
  });

  // Changes a tool makes are the lead's or the calling member's in the data flow.
  const as = (tool: ToolDef, actorOf: (agentId: string) => FlowParty): ToolDef => ({
    ...tool,
    execute: (input, context) => asActor(actorOf(context.agent.id), () => Promise.resolve(tool.execute(input, context))),
  });
  return {
    lead: [statusTool, roleTool, delegateTool, briefTool, kickoffTool, tasksTool, broadcastTool, sendTool, waitTool, boardTool, closeTool].map((tool) => as(tool, () => "lead")),
    member: [readTool, taskTool, postTool, claimTool, reportTool].map((tool) => as(tool, (agentId) => agentId)),
  };
}

const TOOLSETS: Record<PromptLanguage, { lead: ToolDef[]; member: ToolDef[] }> = { en: buildTools("en"), zh: buildTools("zh") };

/** The tools of the given language; English when an agent carries no language label. */
export function toolsFor(language: string | null | undefined): { lead: ToolDef[]; member: ToolDef[] } {
  return TOOLSETS[isPromptLanguage(language) ? language : "en"];
}


// ---------------------------------------------------------------------------------------------------------------------
// The `agent-team` command

/** The fields of a command, one per line, for `agent-team help <command>`. */
function fieldsOf(schema: z.ZodTypeAny): string[] {
  try {
    const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as { properties?: Record<string, any>; required?: string[] };
    return Object.entries(json.properties ?? {}).map(([field, spec]) => {
      const type = spec.type === "array" ? `${spec.items?.type === "object" ? "object" : spec.items?.type ?? "any"}[]` : spec.enum ? spec.enum.map((value: unknown) => JSON.stringify(value)).join(" | ") : spec.type ?? "any";
      const items = spec.type === "array" && spec.items?.properties ? ` of { ${Object.keys(spec.items.properties).join(", ")} }` : spec.type === "object" && spec.properties ? ` { ${Object.keys(spec.properties).join(", ")} }` : "";
      return `  ${field}${json.required?.includes(field) ? "" : "?"}: ${type}${items}${spec.description ? `  ${spec.description}` : ""}`;
    });
  } catch {
    return [];
  }
}

const shown = new Set<string>();

/** Runs one `agent-team` command for the terminal that sent it. */
export async function handleShim(request: ShimRequest): Promise<ShimResponse> {
  await store.load();
  const terminalId = request.terminalId;
  if (!terminalId) return { isError: true, text: "agent-team runs only inside an Orca terminal (ORCA_TERMINAL_HANDLE is not set)." };
  orca().learnProfile(request.userDataPath);
  // Any Orca terminal (the planner, a person) may check a team file.
  if (request.command.trim().toLowerCase() === "check-team") {
    const given = String((request.input as { text?: unknown; file?: unknown })?.file ?? (request.input as { text?: unknown })?.text ?? "").trim();
    if (!given) return { isError: true, text: "Usage: agent-team check-team <path to a .team.json file>" };
    const path = isAbsolute(given) ? given : join(request.cwd, given);
    const parsed = parseTeam(await readFile(path, "utf8").catch(() => ""));
    return parsed.ok ? { isError: false, text: `OK: ${given} is a valid team (${parsed.team.roles.length} roles, ${parsed.team.candidates.length} candidates, mode ${parsed.team.mode}).` } : { isError: true, text: `${given} has problems:\n${parsed.errors.map((error) => `- ${error}`).join("\n")}` };
  }
  const lead = store.lead(terminalId);
  const member = store.member(terminalId);
  const memberLead = member ? store.lead(member.leadTerminalId) : undefined;
  const lang: PromptLanguage = lead?.language ?? memberLead?.language ?? "en";
  const tools = lead ? TOOLSETS[lang].lead : member ? TOOLSETS[lang].member : [];
  if (!tools.length) {
    return { isError: true, text: lang === "zh" ? "这个终端不属于任何智能体团队。请在「智能体团队」面板里启动团队会话，或在新 agent 的第一条消息开头写 @team。" : "This terminal is not part of an agent team. Start a team session from the Agent Team panel, or begin a new agent's first prompt with @team." };
  }
  noteAgentWorking(terminalId);
  const name = request.command.trim().toLowerCase();
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const topic = typeof (request.input as { command?: unknown })?.command === "string" ? String((request.input as { command: string }).command) : "";
    const tool = topic ? tools.find((entry) => entry.name === `${TEAM_BIN} ${topic}` || entry.name === topic) : undefined;
    if (tool) return { isError: false, text: [`${tool.name}: ${tool.title}`, tool.description, "", lang === "zh" ? "字段（JSON）：" : "Fields (JSON):", ...fieldsOf(tool.input)].join("\n") };
    return { isError: false, text: [lang === "zh" ? "命令（`agent-team <命令> '<json>'`，长文本用 stdin）：" : "Commands (`agent-team <command> '<json>'`, or the JSON on stdin):", ...tools.map((entry) => `  ${entry.name.replace(`${TEAM_BIN} `, "")}  ${entry.title}`), "", lang === "zh" ? "`agent-team help <命令>` 查看字段。" : "`agent-team help <command>` shows its fields."].join("\n") };
  }
  const tool = tools.find((entry) => entry.name === `${TEAM_BIN} ${name}`);
  if (!tool) return { isError: true, text: `${lang === "zh" ? "未知命令" : "Unknown command"} "${name}". ${lang === "zh" ? "可用命令" : "Commands"}: ${tools.map((entry) => entry.name.replace(`${TEAM_BIN} `, "")).join(", ")}.` };
  const parsed = tool.input.safeParse(request.input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ");
    return { isError: true, text: `${tool.name}: ${issues}\n${lang === "zh" ? "字段" : "Fields"}:\n${fieldsOf(tool.input).join("\n")}` };
  }
  const controller = new AbortController();
  const actor = lead ? "lead" : terminalId;
  try {
    const result = await asActor(actor, () => tool.execute(parsed.data, { agent: { id: terminalId, workspaceId: request.workspaceId }, signal: controller.signal }));
    let text = result.text ?? "";
    // The lead's standing instructions, once per session (agents without a system prompt get them only this way).
    if (lead && tool.name === LEAD_TOOLS.status && (!shown.has(terminalId) || (request.input as { instructions?: unknown })?.instructions === true)) {
      shown.add(terminalId);
      const ctx = await leadContext({ id: terminalId });
      text = `${promptsFor(lang).orchestratorPrompt(ctx.team, ctx.file)}\n\n---\n\n${text}`;
    }
    return { isError: result.isError === true, text };
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

export { advance, leadContext, reconcile, sendIfIdle, userConfirmed };
export type { LeadContext };
