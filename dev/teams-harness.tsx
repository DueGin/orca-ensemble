// The panel's Teams tab at sidebar width, against a fake worker: one team file and two presets. Rename the file's team
// with window.__renameFile("New name") to see the list follow without a reload; presets rename through the real UI.
// Build with `node dev/build-teams-harness.mjs`, then open dev/teams-harness.html.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppState } from "../src/shared/views";
import { TeamsTab } from "../src/ui/panel/teams";

const team = (name: string) => ({ version: 1, name, goal: "", mode: "auto", lead: { agent: "claude" }, roles: [], candidates: [{ name: "claude", agent: "claude", model: "sonnet", notes: "" }] });
const store = {
  files: [{ file: ".agents/teams/common.team.json", title: "common", team: team(""), errors: [] as string[] }],
  presets: [{ id: "p-1", team: team("common"), updatedAt: "" }, { id: "p-2", team: team("GPT领导"), updatedAt: "" }],
};
const listeners = new Set<() => void>();
(window as unknown as { __renameFile(name: string): void }).__renameFile = (name: string) => {
  store.files = store.files.map((entry) => ({ ...entry, title: name, team: team(name) }));
};

(window as unknown as { orca: unknown }).orca = {
  api: { major: 1, minor: 9 },
  locale: new URLSearchParams(location.search).get("locale") ?? "zh-CN",
  host: { call: async () => ({}), has: () => false },
  on: () => ({ dispose() {} }),
  plugin: {
    on: () => ({ dispose() {} }),
    request: async (name: string, input: { id?: string; name?: string }) => {
      if (name === "api.teamFiles") return JSON.parse(JSON.stringify(store.files));
      if (name === "api.renamePreset") {
        const title = (input.name ?? "").trim();
        if (!title) return { ok: false, error: "empty" };
        if (store.presets.some((preset) => preset.id !== input.id && preset.team.name.toLowerCase() === title.toLowerCase())) return { ok: false, error: "taken" };
        store.presets = store.presets.map((preset) => (preset.id === input.id ? { ...preset, team: { ...preset.team, name: title } } : preset));
        listeners.forEach((listener) => listener());
        return { ok: true };
      }
      return { ok: true };
    },
  },
};

function App() {
  const [presets, setPresets] = useState(store.presets);
  listeners.clear();
  listeners.add(() => setPresets(store.presets));
  const state = { focused: { path: "/proj", name: "main", projectName: "TERALEMO-CODE" }, presets, planners: [] } as unknown as AppState;
  return (
    <div style={{ width: 380, padding: 12 }}>
      <TeamsTab state={state} refresh={() => setPresets(store.presets)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
