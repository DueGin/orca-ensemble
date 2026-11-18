// Orca's hooks: every agent Orca starts gets the `agent-team` command on its PATH; a launch the plugin started gets its
// real prompt and, for Claude, its standing instructions as an appended system prompt; and a new agent whose first
// prompt starts with `@team` becomes a team's lead, which is how a native "new session" turns into a team session.
import { join } from "node:path";
import { cliModelArgs } from "../shared/agents";
import { isTeamMode, languageFromLocale, PLUGIN_MESSAGE_PREFIX, type TeamMode } from "../shared/modes";
import { ENV } from "../shared/paths";
import { promptsFor } from "../shared/prompts";
import { blankTeam, teamTitle, type Team } from "../shared/team";
import type { OrcaWorker } from "./adapter";
import type { LeadSession, Store, TeamSource } from "./store";
import { resolveNamedTeam } from "./teams";

/** Splits a POSIX shell command into words (quotes and backslashes as a shell reads them). */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && index + 1 < command.length && '"\\$`\n'.includes(command[index + 1]!)) current += command[++index];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      has = true;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
      has = true;
    } else if (/\s/.test(char)) {
      if (has || current) words.push(current);
      current = "";
      has = false;
    } else {
      current += char;
      has = true;
    }
  }
  if (has || current) words.push(current);
  return words;
}

/** Quotes a word for a POSIX shell, as Orca does. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export const LAUNCH_MARKER = /^\[ensemble:(L[0-9A-F]{8})\]\n?/;
/** `@team [name] [mode]` on the first line of a new agent's first prompt. */
export const TEAM_DIRECTIVE = /^@team(?:[ \t]+([^\n]*))?(?:\n|$)/i;

export function parseDirective(prompt: string): { name: string; mode: TeamMode | null; request: string } | null {
  const match = prompt.match(TEAM_DIRECTIVE);
  if (!match) return null;
  const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const mode = words.length && isTeamMode(words.at(-1)!.toLowerCase()) ? (words.pop()!.toLowerCase() as TeamMode) : null;
  return { name: words.join(" "), mode, request: prompt.slice(match[0].length).trim() };
}

export interface HookDeps {
  orca: OrcaWorker;
  store: Store;
  pluginRoot: string;
  socket: string;
  nodeBin: string;
  settings(): Promise<{ directive: boolean; defaultTeam: string; language: string }>;
  locale(): string;
}

/** A workspace id from a hook (`<projectId>::<path>`) as its parts. */
function workspaceParts(workspaceId: string | null): { projectId: string | null; path: string | null } {
  if (!workspaceId) return { projectId: null, path: null };
  const at = workspaceId.indexOf("::");
  return at < 0 ? { projectId: null, path: null } : { projectId: workspaceId.slice(0, at), path: workspaceId.slice(at + 2) };
}

/** The lead session a native `@team` start makes, or why it can't. */
export async function nativeLead(deps: HookDeps, input: { terminalId: string; workspaceId: string | null; path: string; agent: string; directive: { name: string; mode: TeamMode | null } }): Promise<{ session: LeadSession; note: string } | null> {
  const settings = await deps.settings();
  const found = await resolveNamedTeam(deps.orca, input.path, input.directive.name, settings.defaultTeam);
  let team: Team;
  let source: TeamSource;
  let note = "";
  if (found) {
    team = found.team;
    source = found.source;
  } else {
    // No team file or preset fits: a team of one candidate, the agent the user started.
    team = { ...blankTeam(input.directive.name || "ad hoc"), lead: { agent: input.agent, model: undefined, effort: undefined }, candidates: [{ name: input.agent, agent: input.agent, model: undefined, effort: undefined, notes: "" }] };
    source = { kind: "inline" };
    note = input.directive.name ? `No team or preset named "${input.directive.name}" was found; the lead works with one candidate, ${input.agent}.` : "No team was chosen (this project has no single team file and no default team); the lead works with one candidate.";
  }
  const override = input.directive.mode && input.directive.mode !== team.mode ? input.directive.mode : null;
  const language = team.language ?? (settings.language === "zh" || settings.language === "en" ? settings.language : languageFromLocale(deps.locale()));
  const parts = workspaceParts(input.workspaceId);
  const session: LeadSession = {
    terminalId: input.terminalId,
    workspaceId: input.workspaceId,
    path: input.path,
    projectId: parts.projectId,
    projectName: input.path.split("/").pop() ?? "",
    source,
    team,
    language,
    mode: override,
    locked: null,
    roles: [],
    brief: null,
    agentSessionId: null,
    createdAt: new Date().toISOString(),
    endedAt: null,
  };
  return { session, note };
}

const sourceText = (session: LeadSession) => (session.source.kind === "file" ? session.source.file : session.source.kind === "preset" ? `the preset "${teamTitle(session.team)}"` : "the team chosen at start");

/** Rewrites an agent launch; returns the changed event, or null to leave it as it is. */
export async function onAgentLaunch(deps: HookDeps, event: { agent: string; workspaceId: string | null; terminalId?: string; command: string; env: Record<string, string> }): Promise<typeof event> {
  const bin = join(deps.pluginRoot, "bin");
  const env = { ...event.env, [ENV.socket]: deps.socket, [ENV.bin]: bin, [ENV.node]: deps.nodeBin, PATH: `${bin}:${event.env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}` };
  let words: string[];
  try {
    words = shellWords(event.command);
  } catch {
    return { ...event, env };
  }
  const promptIndex = words.findIndex((word, index) => index > 0 && (LAUNCH_MARKER.test(word) || TEAM_DIRECTIVE.test(word)));
  if (promptIndex < 0 || !event.terminalId) return { ...event, env };
  const word = words[promptIndex]!;
  let prompt = word;
  let systemPrompt = "";
  const marker = word.match(LAUNCH_MARKER);
  let cliArgs: string[] = [];
  if (marker) {
    const launch = deps.store.takeLaunch(marker[1]!);
    prompt = word.replace(LAUNCH_MARKER, "");
    // Orca passes most agents their model; for one whose CLI flags are known (pi), the model goes on its command line
    // here when a launch couldn't take it there.
    cliArgs = cliModelArgs(event.agent, launch?.model, launch?.effort) ?? [];
    if (launch) {
      systemPrompt = launch.systemPrompt;
      if (launch.kind === "member" && launch.member) await deps.store.setMember({ terminalId: event.terminalId, ...launch.member, createdAt: new Date().toISOString() });
      if (launch.kind === "lead" && launch.lead) await deps.store.setLead({ terminalId: event.terminalId, ...launch.lead, agentSessionId: null, createdAt: new Date().toISOString(), endedAt: null });
      if (launch.kind === "planner" && launch.planner) await deps.store.setPlanner({ terminalId: event.terminalId, ...launch.planner, status: "planning", errors: [], startedAt: new Date().toISOString(), endedAt: null });
    }
  } else {
    const settings = await deps.settings();
    const directive = settings.directive ? parseDirective(word) : null;
    const parts = workspaceParts(event.workspaceId);
    if (directive && parts.path) {
      const made = await nativeLead(deps, { terminalId: event.terminalId, workspaceId: event.workspaceId, path: parts.path, agent: event.agent, directive });
      if (made) {
        await deps.store.setLead(made.session);
        const P = promptsFor(made.session.language);
        prompt = P.leadStartPrompt(made.session.team, sourceText(made.session), directive.request) + (made.note ? `\n\n${PLUGIN_MESSAGE_PREFIX} ${made.note}` : "");
        systemPrompt = P.orchestratorPrompt(made.session.team, sourceText(made.session));
      }
    }
  }
  const next = [...words];
  next.splice(promptIndex, 0, ...cliArgs);
  next[promptIndex + cliArgs.length] = prompt;
  if (systemPrompt && event.agent === "claude" && !next.includes("--append-system-prompt")) next.splice(promptIndex, 0, "--append-system-prompt", systemPrompt);
  return { ...event, env, command: next.map((entry, index) => (index === 0 && /^[A-Za-z0-9._/-]+$/.test(entry) ? entry : shellQuote(entry))).join(" ") };
}

/** A prompt to an agent that starts with `@team` (a native launch whose prompt came after start). */
export async function onAgentPrompt(deps: HookDeps, event: { agent: string | null; terminalId: string; prompt: string; inputKind: string }, lookup: (terminalId: string) => Promise<{ workspaceId: string | null; path: string } | null>): Promise<typeof event | null> {
  if (deps.store.lead(event.terminalId) || deps.store.member(event.terminalId)) return null;
  const settings = await deps.settings();
  const directive = settings.directive ? parseDirective(event.prompt) : null;
  if (!directive) return null;
  const place = await lookup(event.terminalId);
  if (!place) return null;
  const made = await nativeLead(deps, { terminalId: event.terminalId, workspaceId: place.workspaceId, path: place.path, agent: event.agent ?? "claude", directive });
  if (!made) return null;
  await deps.store.setLead(made.session);
  const P = promptsFor(made.session.language);
  // No system prompt here: the lead reads its standing instructions from `agent-team status`.
  return { ...event, prompt: P.leadStartPrompt(made.session.team, sourceText(made.session), directive.request) + (made.note ? `\n\n${PLUGIN_MESSAGE_PREFIX} ${made.note}` : "") };
}
