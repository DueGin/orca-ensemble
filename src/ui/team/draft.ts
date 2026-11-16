// The editor's draft of a team file: what the user is editing, which may be invalid for a while (an empty role name,
// two roles with one name). Decoding never throws, so a broken file still opens; encoding writes the draft as the same
// pretty JSON `serializeTeam` writes, keeping fields the editor doesn't know.
import { isPromptLanguage, isTeamMode, type PromptLanguage, type TeamMode } from "../../shared/modes";
import { candidateHandle, TeamSchema } from "../../shared/team";

export interface RuntimeDraft {
  agent: string;
  model?: string;
  effort?: string;
}

export interface RoleDraft extends RuntimeDraft {
  name: string;
  folders: string[];
  instructions: string;
}

export interface CandidateDraft extends RuntimeDraft {
  /** Empty: the handle comes from the model or agent. */
  name: string;
  notes: string;
}

export interface TeamDraft {
  version: 1;
  name: string;
  goal: string;
  mode: TeamMode;
  lead: RuntimeDraft;
  roles: RoleDraft[];
  candidates: CandidateDraft[];
  language?: PromptLanguage;
  preset?: { id: string; name: string };
}

/** What the document session holds: a team to edit, or a file that can't be read as one (kept as it is). */
export type Draft = { kind: "team"; team: TeamDraft } | { kind: "broken"; text: string; problems: string[]; salvage: TeamDraft | null };

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, lost: string[], path: string, fallback = ""): string => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  lost.push(path);
  return fallback;
};
const optional = (value: unknown, lost: string[], path: string): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  lost.push(path);
  return undefined;
};

function runtimeOf(raw: Obj, lost: string[], path: string): RuntimeDraft {
  return { agent: text(raw.agent, lost, `${path}.agent`), model: optional(raw.model, lost, `${path}.model`), effort: optional(raw.effort, lost, `${path}.effort`) };
}

function listOf(value: unknown, lost: string[], path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  lost.push(path);
  return [];
}

/**
 * The draft for a parsed file, keeping unknown fields and the file's key order. `lost` names the fields whose values
 * had the wrong type and were dropped.
 */
export function toDraft(raw: Obj): { team: TeamDraft; lost: string[] } {
  const lost: string[] = [];
  if (raw.version !== undefined && raw.version !== 1) lost.push("version");
  const mode = raw.mode === undefined ? "auto" : isTeamMode(raw.mode) ? raw.mode : (lost.push("mode"), "auto");
  const language = raw.language === undefined || raw.language === null ? undefined : isPromptLanguage(raw.language) ? raw.language : (lost.push("language"), undefined);
  const lead = isObject(raw.lead) ? { ...raw.lead, ...runtimeOf(raw.lead, lost, "lead") } : (lost.push("lead"), { agent: "claude" });
  const roles = listOf(raw.roles, lost, "roles").flatMap((entry, index): RoleDraft[] => {
    if (!isObject(entry)) return (lost.push(`roles.${index}`), []);
    const folders = listOf(entry.folders, lost, `roles.${index}.folders`).filter((folder): folder is string => typeof folder === "string" || (lost.push(`roles.${index}.folders`), false));
    return [{ ...entry, name: text(entry.name, lost, `roles.${index}.name`), ...runtimeOf(entry, lost, `roles.${index}`), folders, instructions: text(entry.instructions, lost, `roles.${index}.instructions`) }];
  });
  const candidates = listOf(raw.candidates, lost, "candidates").flatMap((entry, index): CandidateDraft[] => {
    if (!isObject(entry)) return (lost.push(`candidates.${index}`), []);
    return [{ ...entry, name: text(entry.name, lost, `candidates.${index}.name`), ...runtimeOf(entry, lost, `candidates.${index}`), notes: text(entry.notes, lost, `candidates.${index}.notes`) }];
  });
  const preset = isObject(raw.preset) && typeof raw.preset.id === "string" && typeof raw.preset.name === "string" ? { id: raw.preset.id, name: raw.preset.name } : raw.preset === undefined ? undefined : (lost.push("preset"), undefined);
  const team: TeamDraft = { ...raw, version: 1, name: text(raw.name, lost, "name"), goal: text(raw.goal, lost, "goal"), mode, lead, roles, candidates, language, preset };
  return { team, lost: [...new Set(lost)] };
}

/** Problems with a file's shape, as `path: message`; the editor shows them when the draft would lose something. */
function shapeProblems(value: unknown): string[] {
  const result = TeamSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.filter((issue) => issue.code !== "custom" && issue.code !== "too_small").map((issue) => `${issue.path.join(".") || "team"}: ${issue.message}`);
}

export function decodeTeam(content: { kind: "text"; text: string } | { kind: string; text?: string }): Draft {
  const source = typeof content.text === "string" ? content.text : "";
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { kind: "broken", text: source, problems: [`json: ${(error as Error).message}`], salvage: null };
  }
  if (!isObject(raw)) return { kind: "broken", text: source, problems: ["object"], salvage: null };
  const { team, lost } = toDraft(raw);
  if (!lost.length) return { kind: "team", team };
  const problems = shapeProblems(raw);
  return { kind: "broken", text: source, problems: problems.length ? problems : lost.map((path) => `${path}: unreadable value`), salvage: team };
}

/** The draft as file text: `serializeTeam`'s format, the draft's own key order. A broken file is written back as it was. */
export function encodeTeam(draft: Draft): { kind: "text"; text: string } {
  if (draft.kind === "broken") return { kind: "text", text: draft.text };
  return { kind: "text", text: JSON.stringify(draft.team, null, 2) + "\n" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Three-way merge of an outside change into unsaved edits: whatever only one side changed wins; where both changed
// the same value, the editor's edit wins.

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeValue(base: unknown, outside: unknown, mine: unknown): unknown {
  if (same(mine, base)) return outside;
  if (same(outside, base) || same(outside, mine)) return mine;
  if (isObject(base) && isObject(outside) && isObject(mine)) {
    const keys = [...new Set([...Object.keys(mine), ...Object.keys(outside), ...Object.keys(base)])];
    const merged: Obj = {};
    for (const key of keys) {
      const value = mergeValue(base[key], outside[key], mine[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  if (Array.isArray(base) && Array.isArray(outside) && Array.isArray(mine) && base.length === outside.length && base.length === mine.length) {
    return mine.map((entry, index) => mergeValue(base[index], outside[index], entry));
  }
  return mine;
}

export function mergeTeams(base: Draft, outside: Draft, mine: Draft): Draft {
  if (mine.kind === "broken") return outside;
  if (outside.kind === "broken" || base.kind === "broken") return mine;
  const merged = mergeValue(base.team, outside.team, mine.team);
  return isObject(merged) ? { kind: "team", team: toDraft(merged).team } : mine;
}

// ---------------------------------------------------------------------------------------------------------------------
// Editing helpers.

/** `base`, else `base-2`, `base-3`… not in `taken` (case-insensitive). */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  const stem = base.replace(/-\d+$/, "");
  for (let index = 2; ; index += 1) if (!used.has(`${stem}-${index}`.toLowerCase())) return `${stem}-${index}`;
}

/** Every name in the team, roles and candidates (candidates by their handle). */
export function takenNames(team: TeamDraft): string[] {
  return [...team.roles.map((role) => role.name), ...team.candidates.map((candidate) => candidate.name || candidateHandle(candidate))];
}

export function newRole(team: TeamDraft): RoleDraft {
  return { name: uniqueName("role", takenNames(team)), agent: team.lead.agent || "claude", model: undefined, effort: undefined, folders: [], instructions: "" };
}

export function newCandidate(team: TeamDraft): CandidateDraft {
  return { name: "", agent: team.lead.agent || "claude", model: undefined, effort: undefined, notes: "" };
}

/** A runtime with empty model and effort dropped, so they are left out of the file. */
export function cleanRuntime<T extends RuntimeDraft>(runtime: T): T {
  return { ...runtime, model: runtime.model?.trim() ? runtime.model : undefined, effort: runtime.effort?.trim() ? runtime.effort : undefined };
}
