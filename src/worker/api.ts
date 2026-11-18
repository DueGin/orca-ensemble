// What the panel, the team editor and the run report ask the worker for (`plugin.request`).
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { excerpt, taskOf, type Run } from "../shared/collab";
import { effectiveMode, isPromptLanguage, isTeamMode, languageFromLocale, PLUGIN_MESSAGE_PREFIX, type PromptLanguage, type TeamMode } from "../shared/modes";
import { promptsFor } from "../shared/prompts";
import { plannerPrompt } from "../shared/planner";
import { teamFileName, TEAMS_DIR } from "../shared/team";
import { blankTeam, checkTeam, EFFORTS, KNOWN_AGENTS, MODEL_SUGGESTIONS, newPresetId, teamTitle, type Preset, type Team } from "../shared/team";
import type { AppState, LeadView, PendingBriefView, ProjectView, RunDetail, RunView, StartInput } from "../shared/views";
import type { OrcaAdapter } from "./adapter";
import { surfaceOf, type Surface } from "../shared/agents";
import { LaunchRefused } from "./adapter";
import { advance, resolveModel } from "./collab";
import { newLaunchId, type LeadSession, type Store, type TeamSource } from "./store";
import { readPresets, saveTeamFile, teamFiles, teamOfLead, writePresets } from "./teams";

export interface ApiDeps {
  /** An agent's state, events first, then a probe of its terminal. */
  live?: (terminalId: string) => string | null;
  adapter: OrcaAdapter;
  store: Store;
  settings(): Promise<AppState["settings"]>;
  locale(): string;
  problems(): string[];
}

export function runView(run: Run): RunView {
  return {
    id: run.id,
    mode: run.mode,
    title: run.title,
    status: run.status,
    round: run.round,
    rounds: run.rounds,
    planApproval: run.planApproval,
    language: run.language,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    brief: run.brief ? { title: run.brief.title, goal: run.brief.goal, acceptance: run.brief.acceptance } : null,
    members: run.members.map((member) => ({ role: member.role, agentId: member.agentId, title: member.title, state: member.state, task: excerpt(member.task, 280), retired: member.retired })),
    tasks: run.tasks.map((task) => ({ id: task.id, title: excerpt(task.title, 160), role: task.role, state: task.state, ownerTitle: task.ownerTitle, waitingOn: task.state === "todo" ? task.deps.filter((dep) => taskOf(run, dep)?.state !== "done") : [], plan: task.plan?.status ?? null, sentBack: task.feedback !== "" && task.state !== "done" })),
    posts: run.posts.slice(-40).map((post) => ({ seq: post.seq, round: post.round, author: post.author, kind: post.kind, text: excerpt(post.text, 600), to: post.to, at: post.at })),
    postCount: run.posts.length,
    claims: run.claims.map((claim) => ({ role: claim.role, path: claim.path || "." })),
    events: run.events.slice(-60),
    batches: run.batches.map((batch) => ({ round: batch.round, title: excerpt(batch.title, 120), packets: batch.taskIds.length, warnings: batch.warnings.length, followUp: batch.followUp, summarized: batch.summaryAt !== null })),
  };
}

function detailView(run: Run, deps: ApiDeps): RunDetail {
  return {
    id: run.id,
    leadAgentId: run.leadAgentId,
    mode: run.mode,
    title: run.title,
    reason: run.reason,
    status: run.status,
    round: run.round,
    rounds: run.rounds,
    planApproval: run.planApproval,
    language: run.language,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    brief: run.brief,
    leadReadSeq: run.leadReadSeq,
    members: run.members.map((member) => {
      const record = deps.store.member(member.agentId);
      return { role: member.role, agentId: member.agentId, title: member.title, state: member.state, task: excerpt(member.task, 6000), result: member.result, collected: member.collected, readSeq: member.readSeq, inboxSeq: member.inboxSeq, retired: member.retired, dispatchedAt: member.dispatchedAt, agent: record?.agent ?? null, model: record?.model ?? null, live: deps.adapter.stateOf(member.agentId) };
    }),
    tasks: run.tasks.map((task) => ({ id: task.id, title: task.title, detail: task.detail, role: task.role, deps: task.deps, waitingOn: task.state === "todo" ? task.deps.filter((dep) => taskOf(run, dep)?.state !== "done") : [], files: task.files, state: task.state, owner: task.owner, ownerTitle: task.ownerTitle, result: task.result, plan: task.plan ? { text: task.plan.text, status: task.plan.status, feedback: task.plan.feedback, delivered: task.plan.delivered } : null, feedback: task.feedback, createdBy: task.createdBy, updatedAt: task.updatedAt })),
    posts: run.posts.slice(-300).map((post) => ({ ...post, text: excerpt(post.text, 6000) })),
    claims: run.claims.map((claim) => ({ ...claim, path: claim.path || "." })),
    events: run.events,
    batches: run.batches.map((batch) => ({ ...batch })),
  };
}

function pendingView(lead: LeadSession): PendingBriefView | null {
  const pending = lead.brief;
  if (!pending) return null;
  return {
    brief: pending.brief,
    roles: pending.roles,
    rounds: pending.rounds,
    planApproval: pending.planApproval,
    tasks: (pending.tasks ?? []).map((task) => ({ title: task.title, detail: task.detail ?? "", role: task.role ?? null, after: task.after ?? [], files: task.files ?? [] })),
    at: pending.at,
    confirmed: pending.confirmedBy === "panel",
  };
}

const sourceText = (lead: LeadSession) => (lead.source.kind === "file" ? lead.source.file : lead.source.kind === "preset" ? "preset" : "inline");

async function leadView(deps: ApiDeps & { live: (terminalId: string) => string | null }, lead: LeadSession): Promise<LeadView> {
  const { team, source } = await teamOfLead(deps.adapter.orca, lead);
  const run = deps.store.leadRun(lead.terminalId, false);
  const state = (lead.endedAt ? "ended" : deps.live(lead.terminalId) ?? "unknown") as LeadView["state"];
  const name = lead.path.split("/").pop() ?? lead.path;
  return {
    terminalId: lead.terminalId,
    workspaceId: lead.workspaceId,
    workspaceName: name,
    path: lead.path,
    teamTitle: teamTitle(team, source),
    source: sourceText(lead),
    team,
    language: lead.language,
    configured: team.mode,
    override: lead.mode,
    locked: lead.locked,
    effective: effectiveMode(team.mode, lead.mode, lead.locked),
    state,
    createdAt: lead.createdAt,
    ended: lead.endedAt !== null,
    roles: lead.roles.map((role) => ({ name: role.name, candidate: role.candidate, agent: role.agent, model: role.model })),
    members: deps.store.members().filter((member) => member.leadTerminalId === lead.terminalId).map((member) => ({ terminalId: member.terminalId, role: member.role, title: member.title, agent: member.agent, model: member.model, state: deps.live(member.terminalId) ?? "unknown" })),
    pendingBrief: pendingView(lead),
    run: run ? runView(run) : null,
    runCount: deps.store.allRuns().filter((entry) => entry.leadAgentId === lead.terminalId).length,
  };
}

/** Writes the small file the run report opens on, in the lead's checkout, and returns its path there. */
async function runReportFile(lead: LeadSession, runId: string): Promise<string> {
  const relative = `.agents/runs/${runId}.team-run.json`;
  await mkdir(join(lead.path, ".agents", "runs"), { recursive: true });
  const ignore = join(lead.path, ".agents", ".gitignore");
  if (!existsSync(ignore)) await writeFile(ignore, "# Ensemble plugin: run report links are local; team files are shared.\nruns/\n").catch(() => undefined);
  await writeFile(join(lead.path, relative), JSON.stringify({ agentTeamRun: runId, note: "Opens the Ensemble run report. The run itself is kept by the plugin." }, null, 2) + "\n");
  return relative;
}

const toLanguage = (value: unknown, fallback: PromptLanguage): PromptLanguage => (isPromptLanguage(value) ? value : fallback);

export function createApi(deps: ApiDeps) {
  const { adapter, store } = deps;
  const orca = adapter.orca;

  async function projects(): Promise<ProjectView[]> {
    const [list, workspaces] = await Promise.all([
      orca.host.call<{ projects: { id: string; name: string; kind: "git" | "folder"; hostId: string; path: string; hidden?: boolean }[] }>("project.list", {}).then((result) => result.projects).catch(() => []),
      adapter.listWorkspaces().catch(() => []),
    ]);
    const views: ProjectView[] = [];
    for (const project of list.filter((entry) => !entry.hidden && entry.hostId === "local")) {
      // Team files come from the project's main checkout.
      const root = workspaces.find((workspace) => workspace.projectId === project.id && workspace.path === project.path)?.path ?? project.path;
      const files = await teamFiles(root);
      views.push({ id: project.id, name: project.name, path: project.path, kind: project.kind, hostId: project.hostId, teams: files.map((file) => ({ file: file.file, title: file.title, errors: file.errors, mode: file.team?.mode ?? null })) });
    }
    return views;
  }

  /** Agent states by workspace from Orca, at most every 10 s per workspace; a restarted worker has none yet. */
  const refreshedAt = new Map<string, number>();
  async function refreshStates(workspaces: { id: string; path: string }[]): Promise<void> {
    const wanted = new Set<string>();
    for (const lead of store.leads().filter((entry) => !entry.endedAt)) {
      const row = workspaces.find((entry) => entry.path === lead.path);
      if (row) wanted.add(row.id);
      if (!lead.workspaceId && row) await store.patchLead(lead.terminalId, { workspaceId: row.id });
    }
    await Promise.all([...wanted].filter((id) => Date.now() - (refreshedAt.get(id) ?? 0) > 10_000).map(async (id) => {
      refreshedAt.set(id, Date.now());
      for (const row of await adapter.listAgents(id)) {
        if (!row.terminalId) continue;
        const was = adapter.agents.get(row.terminalId);
        if (!was || Date.now() - was.at > 10_000) adapter.agents.set(row.terminalId, { ...(was ?? {}), ...row, terminalId: row.terminalId, workspaceId: was?.workspaceId ?? id, at: Date.now() });
      }
    }));
  }

  /** Fills in states no event reported yet, for the sessions the panel shows. */
  async function probeStates(): Promise<void> {
    const terminals = [...store.leads().filter((lead) => !lead.endedAt).map((lead) => lead.terminalId), ...store.members().filter((member) => !store.lead(member.leadTerminalId)?.endedAt).map((member) => member.terminalId)];
    const probed = await Promise.all(terminals.filter((id) => !adapter.stateOf(id)).slice(0, 12).map(async (id) => [id, await adapter.probeState(id)] as const));
    probeCache = new Map(probed);
  }
  let probeCache = new Map<string, string | null>();
  const liveState = (terminalId: string) => adapter.stateOf(terminalId) ?? probeCache.get(terminalId) ?? null;

  async function state(): Promise<AppState> {
    await store.load();
    const settings = await deps.settings();
    const context = await adapter.focusedWorkspace().catch(() => null);
    const focusedId = context?.workspaceId ?? null;
    const workspaces = await adapter.listWorkspaces().catch(() => []);
    await refreshStates(workspaces).catch(() => undefined);
    await probeStates().catch(() => undefined);
    const focusedRow = focusedId ? workspaces.find((row) => row.id === focusedId || focusedId.endsWith(`::${row.path}`)) : undefined;
    const focusedPath = focusedRow?.path ?? (focusedId?.includes("::") ? focusedId.slice(focusedId.indexOf("::") + 2) : null);
    const projectList = await projects();
    const focusedProject = projectList.find((project) => project.id === focusedRow?.projectId) ?? projectList.find((project) => focusedPath === project.path);
    const agents = focusedId ? await adapter.listAgents(focusedId) : [];
    for (const row of agents) if (row.terminalId && !adapter.agents.has(row.terminalId)) adapter.agents.set(row.terminalId, { ...row, terminalId: row.terminalId, workspaceId: focusedId, at: Date.now() });
    const leads = await Promise.all(store.leads().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40).map((lead) => leadView({ ...deps, live: liveState }, lead)));
    const inFocus = (lead: LeadView) => (focusedPath ? lead.path === focusedPath : false);
    leads.sort((a, b) => Number(inFocus(b)) - Number(inFocus(a)) || Number(a.ended) - Number(b.ended) || b.createdAt.localeCompare(a.createdAt));
    return {
      focused: context ? {
        workspaceId: focusedId,
        name: context.displayName,
        branch: context.branch,
        path: focusedPath,
        projectId: focusedProject?.id ?? null,
        projectPath: focusedProject?.path ?? null,
        projectName: focusedProject?.name ?? null,
        projectKind: focusedProject?.kind ?? null,
        agents: agents.filter((row) => row.terminalId).map((row) => ({ terminalId: row.terminalId!, title: row.title, agent: row.agent, state: row.state, role: store.lead(row.terminalId) ? "lead" : store.member(row.terminalId) ? "member" : null })),
      } : null,
      leads,
      planners: store.planners().filter((job) => job.root === focusedPath).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5),
      projects: projectList,
      presets: await readPresets(orca),
      settings,
      locale: deps.locale(),
      pluginReady: { cli: adapter.cliPath !== null, problems: deps.problems() },
    };
  }

  /**
   * Starts the lead in a terminal or a chat, as its team says; a chat Orca refuses here falls back to a terminal. Orca's
   * launch takes the model; where it refuses one for an agent, the terminal launch's hook adds the CLI's own flags.
   */
  async function startLead(input: { path: string; team: Team; prompt: string }): Promise<{ terminalId: string; surface: Surface }> {
    const lead = input.team.lead;
    const wanted = surfaceOf(lead);
    const model = lead.model && lead.agent === "pi" ? await resolveModel(lead.model) : lead.model;
    const prompt = input.prompt;
    try {
      return await adapter.launch({ path: input.path, agent: lead.agent, model, effort: lead.effort, prompt, focus: true, surface: wanted });
    } catch (error) {
      if (!(error instanceof LaunchRefused) || wanted !== "chat") throw error;
      return adapter.launch({ path: input.path, agent: lead.agent, model, effort: lead.effort, prompt, focus: true, surface: "terminal" });
    }
  }

  /** Starts a lead in a workspace (existing, or a new worktree of a project) on a team, with the user's request. */
  async function start(input: StartInput): Promise<{ terminalId: string; workspaceId: string | null; path: string }> {
    const settings = await deps.settings();
    const picked = await resolveTeam(input.team);
    let team = picked.team;
    const source = picked.source;
    const override = input.mode && isTeamMode(input.mode) && input.mode !== team.mode ? input.mode : null;
    const language = toLanguage(input.language ?? team.language, settings.language === "auto" ? languageFromLocale(deps.locale()) : settings.language);
    team = { ...team, language };
    const P = promptsFor(language);
    const launchId = newLaunchId();
    const sourceLabel = source.kind === "file" ? source.file : source.kind === "preset" ? `the preset "${teamTitle(team)}"` : "the team chosen at start";
    const prompt = P.leadStartPrompt(team, sourceLabel, input.request);
    const systemPrompt = P.orchestratorPrompt(team, sourceLabel);
    const chatMarked = `${promptsFor(language).chatNote(adapter.teamBin)}\n\n${prompt}`;
    const base = { projectId: null, projectName: "", source, team, language, mode: override, locked: null, roles: [], brief: null };
    const wanted = surfaceOf(team.lead);
    const model = team.lead.model && team.lead.agent === "pi" ? await resolveModel(team.lead.model) : team.lead.model;
    const marked = wanted === "chat" ? chatMarked : `[ensemble:${launchId}]\n${prompt}`;
    if (input.newWorkspace && input.projectPath) {
      await store.addLaunch({ id: launchId, kind: "lead", prompt, systemPrompt, lead: { ...base, workspaceId: null, path: "" }, createdAt: new Date().toISOString() });
      const made = await adapter.createWorkspace({ projectPath: input.projectPath, name: input.newWorkspace.name, baseBranch: input.newWorkspace.baseBranch, agent: team.lead.agent, model, effort: team.lead.effort, prompt: marked, surface: wanted }).catch(async (error: unknown) => {
        if (!(error instanceof LaunchRefused) || wanted !== "chat") throw error;
        return adapter.createWorkspace({ projectPath: input.projectPath!, name: input.newWorkspace!.name, baseBranch: input.newWorkspace!.baseBranch, agent: team.lead.agent, model, effort: team.lead.effort, prompt: `[ensemble:${launchId}]\n${prompt}`, surface: "terminal" });
      });
      await store.updateIndex((index) => {
        const lead = index.leads[made.terminalId];
        index.leads[made.terminalId] = { ...(lead ?? { ...base, terminalId: made.terminalId, agentSessionId: null, createdAt: new Date().toISOString(), endedAt: null }), workspaceId: lead?.workspaceId ?? made.workspaceId, path: made.path, projectName: input.projectPath!.split("/").pop() ?? "" } as LeadSession;
      });
      return { terminalId: made.terminalId, workspaceId: made.workspaceId, path: made.path };
    }
    const path = input.workspacePath ?? input.projectPath;
    if (!path) throw new Error("Pick a workspace or a project.");
    await store.addLaunch({ id: launchId, kind: "lead", prompt, systemPrompt, lead: { ...base, workspaceId: null, path }, createdAt: new Date().toISOString() });
    const { terminalId } = await startLead({ path, team, prompt: marked });
    await store.updateIndex((index) => {
      const lead = index.leads[terminalId];
      index.leads[terminalId] = { ...(lead ?? { ...base, terminalId, workspaceId: null, agentSessionId: null, createdAt: new Date().toISOString(), endedAt: null }), path, projectName: path.split("/").pop() ?? "" } as LeadSession;
    });
    return { terminalId, workspaceId: store.lead(terminalId)?.workspaceId ?? null, path };
  }

  /** Makes an agent already running in the focused workspace a team's lead. */
  async function adopt(input: { terminalId: string; workspaceId: string | null; path: string; team: StartInput["team"]; mode?: TeamMode; language?: PromptLanguage }): Promise<{ ok: true }> {
    const settings = await deps.settings();
    const picked = await resolveTeam(input.team);
    let team = picked.team;
    const override = input.mode && input.mode !== team.mode ? input.mode : null;
    const language = toLanguage(input.language ?? team.language, settings.language === "auto" ? languageFromLocale(deps.locale()) : settings.language);
    team = { ...team, language };
    await store.setLead({ terminalId: input.terminalId, workspaceId: input.workspaceId, path: input.path, projectId: null, projectName: input.path.split("/").pop() ?? "", source: picked.source, team, language, mode: override, locked: null, roles: [], brief: null, agentSessionId: null, createdAt: new Date().toISOString(), endedAt: null });
    const label = picked.source.kind === "file" ? picked.source.file : `the team "${teamTitle(team)}"`;
    const sent = await adapter.sendIfIdle(input.terminalId, promptsFor(language).leadStartPrompt(team, label, ""));
    if (!sent) await adapter.send(input.terminalId, promptsFor(language).leadStartPrompt(team, label, ""));
    return { ok: true };
  }

  async function resolveTeam(choice: StartInput["team"]): Promise<{ team: Team; source: TeamSource }> {
    if (choice.kind === "file") {
      const found = (await teamFiles(choice.root)).find((entry) => entry.file === choice.file);
      if (!found?.team) throw new Error(`The team file ${choice.file} could not be read.`);
      return { team: found.team, source: { kind: "file", file: choice.file } };
    }
    if (choice.kind === "preset") {
      const preset = (await readPresets(orca)).find((entry) => entry.id === choice.presetId);
      if (!preset) throw new Error("The preset was not found.");
      return { team: { ...preset.team, preset: { id: preset.id, name: teamTitle(preset.team) } }, source: { kind: "preset", presetId: preset.id } };
    }
    const checked = checkTeam(choice.team);
    if (!checked.ok) throw new Error(checked.errors.join("\n"));
    return { team: checked.team, source: { kind: "inline" } };
  }

  async function setMode(input: { terminalId: string; mode: TeamMode }): Promise<{ ok: boolean; error?: string; notified?: boolean }> {
    const lead = store.lead(input.terminalId);
    if (!lead) return { ok: false, error: "That session is gone." };
    if (lead.locked) return { ok: false, error: lead.language === "zh" ? `本会话已锁定为${lead.locked === "team" ? "团队" : "委派"}模式。` : `This session is locked to ${lead.locked} mode.` };
    const { team } = await teamOfLead(orca, lead);
    const next = input.mode === team.mode ? null : input.mode;
    await store.setSessionMode(input.terminalId, next);
    const notified = await adapter.sendIfIdle(input.terminalId, promptsFor(lead.language).modeChangedPrompt(next, team.mode));
    return { ok: true, notified };
  }

  async function confirmBrief(input: { terminalId: string }): Promise<{ ok: boolean; notified: boolean }> {
    const lead = store.lead(input.terminalId);
    if (!lead?.brief) return { ok: false, notified: false };
    await store.setPendingBrief(input.terminalId, { ...lead.brief, confirmedBy: "panel" });
    const text = lead.language === "zh"
      ? `${PLUGIN_MESSAGE_PREFIX} 用户在「智能体团队」面板里确认了需求简报和任务计划。现在运行 agent-team kickoff，userConfirmation 填 "confirmed in panel"。`
      : `${PLUGIN_MESSAGE_PREFIX} The user confirmed the brief and task plan in the Ensemble panel. Run agent-team kickoff now, with userConfirmation "confirmed in panel".`;
    const notified = await adapter.send(input.terminalId, text);
    return { ok: true, notified };
  }

  async function openReport(input: { runId: string }): Promise<{ ok: boolean; error?: string }> {
    const run = store.get(input.runId);
    const lead = run ? store.lead(run.leadAgentId) : undefined;
    if (!run || !lead) return { ok: false, error: "The run was not found." };
    const file = await runReportFile(lead, run.id);
    const workspaces = await adapter.listWorkspaces().catch(() => []);
    const ids = [...new Set([workspaces.find((row) => row.path === lead.path)?.id, lead.workspaceId].filter((id): id is string => !!id))];
    for (const workspaceId of ids) {
      try {
        await adapter.openFile(workspaceId, file);
        return { ok: true };
      } catch {
        // Try the next id form.
      }
    }
    return { ok: false, error: "Orca could not open the run report." };
  }

  /** Opens a file of the checkout at `root` in Orca (a team file opens in the team editor). */
  async function openFileAt(root: string, file: string): Promise<{ ok: boolean; error?: string }> {
    const workspaces = await adapter.listWorkspaces().catch(() => []);
    const row = workspaces.find((entry) => entry.path === root);
    if (!row) return { ok: false, error: "That checkout is not a workspace in Orca." };
    try {
      await adapter.openFile(row.id, file);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    state,
    openTeamFile: async ({ root, file }: { root: string; file: string }) => openFileAt(root, file),
    /** Starts a planner agent that reads the project and writes a team file, opened in the team editor when done. */
    planTeam: async ({ root, goal, name, language, agent, model }: { root: string; goal: string; name: string; language?: PromptLanguage; agent?: string; model?: string }) => {
      const settings = await deps.settings();
      const lang = toLanguage(language, settings.language === "auto" ? languageFromLocale(deps.locale()) : settings.language);
      let file = `${TEAMS_DIR}/${teamFileName(name || "team")}`;
      for (let index = 2; existsSync(join(root, file)); index += 1) file = `${TEAMS_DIR}/${teamFileName(`${name || "team"}-${index}`)}`;
      const launchId = newLaunchId();
      const prompt = plannerPrompt(goal, file, lang);
      await store.addLaunch({ id: launchId, kind: "planner", prompt, systemPrompt: "", planner: { root, file, goal }, createdAt: new Date().toISOString() });
      const { terminalId } = await adapter.launch({ path: root, agent: agent || "claude", model, prompt: `[ensemble:${launchId}]\n${prompt}`, focus: false });
      if (!store.planner(terminalId)) await store.setPlanner({ terminalId, root, file, goal, status: "planning", errors: [], startedAt: new Date().toISOString(), endedAt: null });
      return { terminalId, file };
    },
    createTeam: async ({ root, name, presetId }: { root: string; name: string; presetId?: string }) => {
      const preset = presetId ? (await readPresets(orca)).find((entry) => entry.id === presetId) : undefined;
      const team: Team = preset ? { ...structuredClone(preset.team), name: name.trim() || teamTitle(preset.team), preset: { id: preset.id, name: teamTitle(preset.team) } } : { ...blankTeam(name.trim()), language: undefined };
      const file = await saveTeamFile(root, team);
      const opened = await openFileAt(root, file);
      return { file, opened: opened.ok, error: opened.error };
    },
    session: async ({ terminalId }: { terminalId: string }) => {
      const lead = store.lead(terminalId);
      return lead ? leadView({ ...deps, live: liveState }, lead) : null;
    },
    runDetail: async ({ runId }: { runId: string }) => {
      await store.load();
      const run = store.get(runId);
      return run ? detailView(run, deps) : null;
    },
    leadRuns: async ({ terminalId }: { terminalId: string }) => store.allRuns().filter((run) => run.leadAgentId === terminalId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(runView),
    setMode,
    confirmBrief,
    openReport,
    start,
    adopt,
    focus: async ({ terminalId }: { terminalId: string }) => {
      await adapter.focusTerminal(terminalId);
      return { ok: true };
    },
    endSession: async ({ terminalId }: { terminalId: string }) => {
      await store.patchLead(terminalId, { endedAt: new Date().toISOString() });
      return { ok: true };
    },
    nudge: async ({ runId }: { runId: string }) => {
      await advance(runId);
      return { ok: true };
    },
    catalog: async () => {
      // Agents and models the host can run: pi's own list (as provider/id) joins the built-in suggestions.
      const pi = await adapter.piModels().catch(() => [] as string[]);
      return { agents: [...KNOWN_AGENTS], models: pi.length ? { ...MODEL_SUGGESTIONS, pi } : MODEL_SUGGESTIONS, efforts: [...EFFORTS] };
    },
    validateTeam: async ({ team }: { team: unknown }) => {
      const checked = checkTeam(team);
      return checked.ok ? { ok: true as const, team: checked.team } : { ok: false as const, errors: checked.errors };
    },
    saveTeam: async ({ root, team, file }: { root: string; team: Team; file?: string }) => ({ file: await saveTeamFile(root, team, file) }),
    teamFiles: async ({ root }: { root: string }) => teamFiles(root),
    presets: async () => readPresets(orca),
    savePreset: async ({ preset }: { preset: { id?: string; team: Team } }) => {
      const checked = checkTeam(preset.team);
      if (!checked.ok) return { ok: false as const, errors: checked.errors };
      const list = await readPresets(orca);
      // Saving a team as a preset again updates the preset of the same name.
      const id = preset.id ?? list.find((item) => teamTitle(item.team).toLowerCase() === teamTitle(checked.team).toLowerCase())?.id ?? newPresetId();
      const entry: Preset = { id, team: checked.team, updatedAt: new Date().toISOString() };
      await writePresets(orca, list.some((item) => item.id === id) ? list.map((item) => (item.id === id ? entry : item)) : [...list, entry]);
      return { ok: true as const, id };
    },
    renamePreset: async ({ id, name }: { id: string; name: string }) => {
      const title = name.trim();
      if (!title) return { ok: false as const, error: "empty" as const };
      const list = await readPresets(orca);
      const preset = list.find((item) => item.id === id);
      if (!preset) return { ok: false as const, error: "missing" as const };
      if (list.some((item) => item.id !== id && teamTitle(item.team).toLowerCase() === title.toLowerCase())) return { ok: false as const, error: "taken" as const };
      await writePresets(orca, list.map((item) => (item.id === id ? { ...item, team: { ...item.team, name: title }, updatedAt: new Date().toISOString() } : item)));
      return { ok: true as const };
    },
    deletePreset: async ({ id }: { id: string }) => {
      await writePresets(orca, (await readPresets(orca)).filter((item) => item.id !== id));
      return { ok: true };
    },
  };
}

export type Api = ReturnType<typeof createApi>;
