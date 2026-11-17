// Orca checks what crosses to the host with z.json(): a panel request's input, a worker's answer, stored values.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJson } from "../src/shared/json";
import { checkTeam } from "../src/shared/team";
import type { OrcaWorker } from "../src/worker/adapter";
import { readPresets, writePresets } from "../src/worker/teams";

const orcaJson = z.json();

/** A team as the editor holds it: a new candidate with its model and effort unset, the language following Orca. */
const draft = {
  version: 1,
  name: "web",
  goal: "",
  mode: "auto",
  language: undefined,
  lead: { agent: "claude", model: "opus", effort: undefined },
  roles: [],
  candidates: [{ name: "", agent: "codex", model: undefined, effort: undefined, notes: "" }],
} as const;

describe("values that cross to Orca", () => {
  it("are plain JSON once unset fields are dropped, as Orca requires", () => {
    const input = { preset: { team: draft }, locale: "zh-CN" };
    expect(orcaJson.safeParse(input).success).toBe(false);
    const sent = toJson(input);
    expect(orcaJson.safeParse(sent).success).toBe(true);
    expect(sent.preset.team.candidates[0]).toEqual({ name: "", agent: "codex", notes: "" });
    expect(toJson(undefined)).toBeUndefined();
  });

  it("saves a preset whose team has unset fields, and reads it back", async () => {
    let stored: unknown = null;
    const orca = {
      storage: {
        get: async () => stored,
        set: async (_key: string, value: unknown) => {
          // Orca's storage.set: { value: z.json() }.
          if (!orcaJson.safeParse(value).success) throw new Error("value: Invalid input");
          stored = value;
        },
      },
    } as unknown as OrcaWorker;
    const checked = checkTeam(draft);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    await writePresets(orca, [{ id: "p-1", team: checked.team, updatedAt: "now" }]);
    const presets = await readPresets(orca);
    expect(presets.map((preset) => [preset.id, preset.team.candidates[0]!.agent, preset.team.candidates[0]!.notes])).toEqual([["p-1", "codex", ""]]);
  });
});
