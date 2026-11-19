// A team: the lead (an agent CLI and model), fixed roles and a pool of candidate members, a collaboration mode and the
// language the agents work in. Teams live in the project as `.agents/teams/<name>.team.json`, shared through git and
// readable by the agents; the plugin's own editor opens them. Presets are teams kept by the plugin for every project.
import { z } from "zod";
import { SURFACES } from "./agents";
import { PROMPT_LANGUAGES, TEAM_MODES } from "./modes";

/** Where a project keeps its teams, and the suffix that opens a file in the team editor. */
export const TEAMS_DIR = ".agents/teams";
export const TEAM_SUFFIX = ".team.json";

/** Agent CLIs Orca launches; a role names one, and may name a model and effort for it. */
export const KNOWN_AGENTS = [
  "claude", "codex", "omp", "gemini", "opencode", "pi", "copilot", "cursor", "kimi", "qwen-code", "droid", "grok", "kiro", "hermes", "codebuddy",
] as const;

/** Model suggestions per agent; any model id the agent accepts works. */
export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  claude: ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: ["gpt-5.5", "gpt-5.5-codex", "o4-mini"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const name = z.string().trim().min(1);
const optionalText = z.string().trim().optional().transform((value) => (value ? value : undefined));

/**
 * How an agent runs: the CLI Orca starts, optionally the model and reasoning effort it uses, and whether it opens as a
 * chat (Orca's graphical client) or in a terminal. Without `surface`, an agent that can be a chat is one (see agents.ts).
 */
export const RuntimeSchema = z.object({
  agent: name,
  model: optionalText,
  effort: optionalText,
  surface: z.enum(SURFACES).optional(),
});

export const RoleSchema = RuntimeSchema.extend({
  name,
  folders: z.array(z.string().trim().min(1)).default([]),
  instructions: z.string().default(""),
});

/**
 * A candidate member: an agent and model the lead may give work to during a session, guided by its description. A
 * candidate is not a role: the lead decides who does what from the descriptions.
 */
export const CandidateSchema = RuntimeSchema.extend({
  /** A short handle the lead picks it by; derived from the model or agent when left empty. */
  name,
  /** What it is good at and suited for, its cost or speed, and work it must not be given. */
  notes: z.string().default(""),
});

/** A handle for a candidate without a name: its model without a provider prefix, else its agent. */
export function candidateHandle(runtime: { agent?: unknown; model?: unknown }): string {
  const model = typeof runtime.model === "string" ? runtime.model.trim().split("/").pop() ?? "" : "";
  const base = (model || (typeof runtime.agent === "string" ? runtime.agent : "")).replace(/^claude-/, "");
  return base.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "candidate";
}

/** Fills empty candidate names from their models, keeping given names and making every name unique. */
export function fillCandidateNames(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const named = (entry: unknown) => (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string" ? (entry as { name: string }).name.trim() : "");
  const taken = new Set(value.map(named).filter(Boolean).map((entry) => entry.toLowerCase()));
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || named(entry)) return entry;
    const base = candidateHandle(entry as { agent?: unknown; model?: unknown });
    let handle = base;
    for (let index = 2; taken.has(handle.toLowerCase()); index += 1) handle = `${base}-${index}`;
    taken.add(handle.toLowerCase());
    return { ...entry, name: handle };
  });
}

export const CandidatesSchema = z.preprocess(fillCandidateNames, z.array(CandidateSchema));

export const TeamSchema = z
  .object({
    version: z.literal(1),
    /** Shown in pickers; the file name when empty. */
    name: z.string().default(""),
    goal: z.string().default(""),
    /** How the lead runs a request: a fixed collaboration mode, "auto" to pick one per request, or "none". */
    mode: z.enum(TEAM_MODES).default("auto"),
    lead: RuntimeSchema,
    /** Fixed roles. May be empty when the team has candidate members. */
    roles: z.array(RoleSchema).default([]),
    /** The pool of models the lead gives work to by their descriptions. */
    candidates: CandidatesSchema.default([]),
    /** The language of the agents' instructions and replies; the app's when unset. */
    language: z.enum(PROMPT_LANGUAGES).optional(),
    /** The preset the team was made from; a copy, so later edits of the preset don't change it. */
    preset: z.object({ id: z.string(), name: z.string() }).optional(),
  })
  .superRefine((team, ctx) => {
    const roleNames = new Set<string>();
    team.roles.forEach((role, index) => {
      const key = role.name.toLowerCase();
      if (roleNames.has(key)) ctx.addIssue({ code: "custom", path: ["roles", index, "name"], message: `duplicate role name "${role.name}"` });
      roleNames.add(key);
    });
    const candidateNames = new Set<string>();
    team.candidates.forEach((candidate, index) => {
      const key = candidate.name.toLowerCase();
      if (candidateNames.has(key)) ctx.addIssue({ code: "custom", path: ["candidates", index, "name"], message: `duplicate candidate name "${candidate.name}"` });
      if (roleNames.has(key)) ctx.addIssue({ code: "custom", path: ["candidates", index, "name"], message: `candidate "${candidate.name}" has the name of a role` });
      candidateNames.add(key);
    });
    if (!team.roles.length && !team.candidates.length) ctx.addIssue({ code: "custom", path: ["roles"], message: "a team needs at least one role or one candidate member" });
  });

export type Team = z.output<typeof TeamSchema>;
export type Role = z.output<typeof RoleSchema>;
export type Candidate = z.output<typeof CandidateSchema>;
export type Runtime = z.output<typeof RuntimeSchema>;

export type ParseResult = { ok: true; team: Team } | { ok: false; errors: string[] };

export function checkTeam(value: unknown): ParseResult {
  const result = TeamSchema.safeParse(value);
  if (result.success) return { ok: true, team: result.data };
  return { ok: false, errors: result.error.issues.map((issue) => `${issue.path.join(".") || "team"}: ${issue.message}`) };
}

export function parseTeam(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`team file is not valid JSON: ${(error as Error).message}`] };
  }
  return checkTeam(value);
}

export function serializeTeam(team: Team): string {
  return JSON.stringify(team, null, 2) + "\n";
}

/** A runtime as `agent/model · effort`, for prompts and the dashboard. */
export function runtimeLabel(runtime: { agent: string; model?: string; effort?: string }): string {
  return `${runtime.agent}${runtime.model ? `/${runtime.model}` : ""}${runtime.effort ? ` · ${runtime.effort}` : ""}`;
}

/** The team's display name: its own, else the file name without the suffix. */
export function teamTitle(team: Team, file?: string): string {
  if (team.name.trim()) return team.name.trim();
  const base = (file ?? "").split("/").pop() ?? "";
  return base.endsWith(TEAM_SUFFIX) ? base.slice(0, -TEAM_SUFFIX.length) : base || "team";
}

/** A file name for a new team: its name in kebab case. */
export function teamFileName(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "team";
  return `${slug}${TEAM_SUFFIX}`;
}

/** An empty team to start editing from. */
export function blankTeam(name = ""): Team {
  return { version: 1, name, goal: "", mode: "auto", lead: { agent: "claude", model: undefined, effort: undefined }, roles: [], candidates: [{ name: "claude", agent: "claude", model: undefined, effort: undefined, notes: "" }] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Presets: teams the plugin keeps for every project.

export const PresetSchema = z.object({
  id: name,
  team: TeamSchema,
  updatedAt: z.string().default(""),
});
export type Preset = z.output<typeof PresetSchema>;

/** A new preset id such as `p-3f2a90c1`; `random` returns 0..1. */
export function newPresetId(random: () => number = Math.random): string {
  return `p-${Math.floor(random() * 0x100000000).toString(16).padStart(8, "0")}`;
}

/** A team copied from a preset, remembering where it came from. */
export function teamFromPreset(preset: Preset): Team {
  return { ...structuredClone(preset.team), preset: { id: preset.id, name: teamTitle(preset.team) } };
}
