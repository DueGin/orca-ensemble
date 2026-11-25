// The models the team editor offers for an agent: Orca's own list for it first (what Orca's model picker shows), else
// the list its CLI prints (pi and omp), else the plugin's built-in suggestions.
import { MODEL_SUGGESTIONS } from "../shared/team";
import type { OrcaModelList } from "./orca-models";

/** A model to pick: the id the team file keeps, a label to show, and the efforts it takes (null: unknown). */
export type ModelChoice = { id: string; label: string; isDefault: boolean; efforts: string[] | null; defaultEffort?: string };

/** Where the list came from: Orca, the agent's CLI, or the plugin's suggestions. */
export type ModelSource = "orca" | "cli" | "builtin";

/** `listing`: Orca is still listing this agent's models, so asking again (with `wait`) may give its list. */
export type ModelChoices = { source: ModelSource; models: ModelChoice[]; listing: boolean };

/** Agents whose CLI lists its models (`<agent> --list-models`). */
const CLI_LISTS: ReadonlySet<string> = new Set(["pi", "omp"]);

export async function modelChoices(
  agent: string,
  wait: boolean,
  sources: { orca(agent: string, wait: boolean): Promise<OrcaModelList | null>; cli(agent: "pi" | "omp"): Promise<string[]> },
): Promise<ModelChoices> {
  const name = agent.trim();
  const fromOrca = name ? await sources.orca(name, wait).catch(() => null) : null;
  if (fromOrca?.models.length) return { source: "orca", models: fromOrca.models, listing: fromOrca.listing };
  const listing = fromOrca?.listing ?? false;
  if (CLI_LISTS.has(name)) {
    const ids = await sources.cli(name as "pi" | "omp").catch(() => [] as string[]);
    if (ids.length) return { source: "cli", models: ids.map((id) => ({ id, label: id, isDefault: false, efforts: null })), listing };
  }
  return { source: "builtin", models: (MODEL_SUGGESTIONS[name] ?? []).map((id) => ({ id, label: id, isDefault: false, efforts: null })), listing };
}
