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

describe("renaming a preset", () => {
  it("changes its name, refuses an empty name or one another preset has, and keeps the stored value plain JSON", async () => {
    const { createApi } = await import("../src/worker/api");
    const { OrcaAdapter } = await import("../src/worker/adapter");
    const { Store } = await import("../src/worker/store");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    let stored: unknown = null;
    const worker = {
      api: { major: 1, minor: 9 },
      host: { call: async () => ({}), has: () => true },
      commands: { register: () => ({ dispose() {} }) },
      events: { on: () => ({ dispose() {} }) },
      hooks: { on: () => ({ dispose() {} }) },
      panels: { handle: () => ({ dispose() {} }), post() {} },
      storage: {
        get: async () => stored,
        set: async (_key: string, value: unknown) => {
          if (!orcaJson.safeParse(value).success) throw new Error("value: Invalid input");
          stored = value;
        },
      },
      settings: { get: async () => null },
      log() {},
    } as unknown as OrcaWorker;
    const api = createApi({ adapter: new OrcaAdapter(worker), store: new Store(mkdtempSync(join(tmpdir(), "ensemble-presets-"))), settings: async () => ({ language: "auto", directive: true, defaultTeam: "" }), locale: () => "zh-CN", problems: () => [] } as never);
    const team = (name: string) => ({ ...draft, name });
    expect((await api.savePreset({ preset: { team: team("common") as never } })).ok).toBe(true);
    expect((await api.savePreset({ preset: { team: team("GPT领导") as never } })).ok).toBe(true);
    const [common] = await api.presets();
    expect(await api.renamePreset({ id: common!.id, name: "  Claude领导 " })).toEqual({ ok: true });
    expect((await api.presets()).map((preset) => preset.team.name)).toEqual(["Claude领导", "GPT领导"]);
    expect(await api.renamePreset({ id: common!.id, name: "gpt领导" })).toEqual({ ok: false, error: "taken" });
    expect(await api.renamePreset({ id: common!.id, name: "  " })).toEqual({ ok: false, error: "empty" });
    expect(await api.renamePreset({ id: "p-missing", name: "x" })).toEqual({ ok: false, error: "missing" });
  });
});
