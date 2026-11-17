// Teams: files in the project (`.agents/teams/*.team.json`) and presets in the plugin's storage.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toJson } from "../shared/json";
import { checkTeam, parseTeam, PresetSchema, serializeTeam, teamFileName, teamTitle, TEAM_SUFFIX, TEAMS_DIR, type Preset, type Team } from "../shared/team";
import type { OrcaWorker } from "./adapter";
import type { LeadSession, TeamSource } from "./store";

export interface TeamFile {
  /** Relative to the workspace root, such as `.agents/teams/web.team.json`. */
  file: string;
  title: string;
  team: Team | null;
  errors: string[];
}

/** The team files in a checkout. */
export async function teamFiles(root: string): Promise<TeamFile[]> {
  const dir = join(root, TEAMS_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: TeamFile[] = [];
  for (const name of names.filter((entry) => entry.endsWith(TEAM_SUFFIX)).sort()) {
    const file = `${TEAMS_DIR}/${name}`;
    const parsed = parseTeam(await readFile(join(dir, name), "utf8").catch(() => ""));
    files.push(parsed.ok ? { file, title: teamTitle(parsed.team, file), team: parsed.team, errors: [] } : { file, title: name.slice(0, -TEAM_SUFFIX.length), team: null, errors: parsed.errors });
  }
  return files;
}

async function ensureIgnored(root: string): Promise<void> {
  const ignore = join(root, ".agents", ".gitignore");
  if (!existsSync(ignore)) await writeFile(ignore, "# Ensemble plugin: run report links are local; team files are shared.\nruns/\n").catch(() => undefined);
}

/** Writes a team into a checkout; a new file gets a name from the team's title. Returns the relative path. */
export async function saveTeamFile(root: string, team: Team, file?: string): Promise<string> {
  const checked = checkTeam(team);
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  await mkdir(join(root, TEAMS_DIR), { recursive: true });
  await ensureIgnored(root);
  let relative = file;
  if (!relative) {
    const base = teamFileName(teamTitle(checked.team));
    relative = `${TEAMS_DIR}/${base}`;
    for (let index = 2; existsSync(join(root, relative)); index += 1) relative = `${TEAMS_DIR}/${base.slice(0, -TEAM_SUFFIX.length)}-${index}${TEAM_SUFFIX}`;
  }
  await writeFile(join(root, relative), serializeTeam(checked.team));
  return relative;
}

// ----- Presets

const PRESETS_KEY = "presets";

export async function readPresets(orca: OrcaWorker): Promise<Preset[]> {
  const value = await orca.storage.get(PRESETS_KEY).catch(() => null);
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((entry) => {
    const parsed = PresetSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function writePresets(orca: OrcaWorker, presets: readonly Preset[]): Promise<void> {
  await orca.storage.set(PRESETS_KEY, toJson(presets.map((preset) => PresetSchema.parse(preset))));
}

/** A lead's team: its file read again (so edits apply), its preset, else the copy taken when it started. */
export async function teamOfLead(orca: OrcaWorker, lead: LeadSession): Promise<{ team: Team; source: string }> {
  const source: TeamSource = lead.source;
  if (source.kind === "file") {
    const parsed = parseTeam(await readFile(join(lead.path, source.file), "utf8").catch(() => ""));
    if (parsed.ok) return { team: parsed.team, source: source.file };
    return { team: lead.team, source: `${source.file} (unreadable now; using the copy taken when the session started)` };
  }
  if (source.kind === "preset") {
    const preset = (await readPresets(orca)).find((entry) => entry.id === source.presetId);
    if (preset) return { team: { ...preset.team, preset: { id: preset.id, name: teamTitle(preset.team) } }, source: `the preset "${teamTitle(preset.team)}"` };
    return { team: lead.team, source: "a preset that was deleted (using the copy taken when the session started)" };
  }
  return { team: lead.team, source: "the team chosen when the session started" };
}

/** The team a native `@team` start names: a team file of the checkout or a preset by title, else the only or default one. */
export async function resolveNamedTeam(orca: OrcaWorker, root: string, name: string, defaultTeam: string): Promise<{ team: Team; source: TeamSource } | null> {
  const files = (await teamFiles(root)).filter((entry) => entry.team);
  const presets = await readPresets(orca);
  const wanted = (name || defaultTeam).trim().toLowerCase();
  const match = (title: string, file?: string) => title.toLowerCase() === wanted || (file ?? "").toLowerCase().endsWith(`/${wanted}${TEAM_SUFFIX}`);
  if (wanted) {
    const file = files.find((entry) => match(entry.title, entry.file));
    if (file) return { team: file.team!, source: { kind: "file", file: file.file } };
    const preset = presets.find((entry) => match(teamTitle(entry.team)) || entry.id === wanted);
    if (preset) return { team: { ...preset.team, preset: { id: preset.id, name: teamTitle(preset.team) } }, source: { kind: "preset", presetId: preset.id } };
    if (name) return null;
  }
  if (files.length === 1) return { team: files[0]!.team!, source: { kind: "file", file: files[0]!.file } };
  if (!files.length && presets.length === 1) return { team: { ...presets[0]!.team, preset: { id: presets[0]!.id, name: teamTitle(presets[0]!.team) } }, source: { kind: "preset", presetId: presets[0]!.id } };
  return null;
}
