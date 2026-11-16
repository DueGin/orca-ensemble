// A stand-in for Orca's frame API (window.orca) for the static harnesses: ?run=<id>&lang=en|zh&theme=dark|light.
// Theme colors are Orca's own (out/renderer client CSS); run fixtures come from dev/fixtures.js, shifted in time so the
// newest event happened a few seconds ago and the diagram shows live flows.
(function () {
  const params = new URLSearchParams(location.search);
  const lang = params.get("lang") || "en";
  const theme = params.get("theme") || "dark";
  const THEMES = {
    dark: { background: "#0a0a0a", foreground: "#fafafa", card: "#171717", "card-foreground": "#fafafa", popover: "#171717", primary: "#e5e5e5", "primary-foreground": "#171717", secondary: "#262626", "secondary-foreground": "#fafafa", muted: "#262626", "muted-foreground": "#a1a1a1", accent: "#404040", border: "#ffffff12", input: "#ffffff26", ring: "#737373", destructive: "#ff6467", radius: "10px" },
    light: { background: "#ffffff", foreground: "#0a0a0a", card: "#ffffff", "card-foreground": "#0a0a0a", popover: "#ffffff", primary: "#171717", "primary-foreground": "#fafafa", secondary: "#f5f5f5", "secondary-foreground": "#171717", muted: "#f5f5f5", "muted-foreground": "#737373", accent: "#f5f5f5", border: "#e5e5e5", input: "#e5e5e5", ring: "#a1a1a1", destructive: "#e7000b", radius: "10px" },
  };
  window.__setTheme = (name) => {
    document.documentElement.className = name;
    for (const [key, value] of Object.entries(THEMES[name])) document.documentElement.style.setProperty(`--orca-${key}`, value);
  };
  window.__setTheme(theme);

  const fixtures = JSON.parse(JSON.stringify(window.__FIXTURES || {}));
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
  const shift = (value, offset) => {
    if (typeof value === "string") return iso.test(value) ? new Date(Date.parse(value) + offset).toISOString() : value;
    if (Array.isArray(value)) return value.map((entry) => shift(entry, offset));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shift(entry, offset)]));
    return value;
  };
  const ago = Number(params.get("ago") || 6) * 1000;
  for (const [id, run] of Object.entries(fixtures)) {
    const newest = Math.max(Date.parse(run.updatedAt), ...run.events.map((event) => Date.parse(event.at)));
    fixtures[id] = shift(run, Date.now() - ago - newest);
  }
  const runId = params.get("run") || Object.keys(fixtures)[0];
  window.__focused = [];
  window.orca = Object.freeze({
    api: { major: 1, minor: 0 },
    locale: lang === "zh" ? "zh-CN" : "en-US",
    host: { call: async () => ({}), has: () => false },
    plugin: {
      request: async (name, input) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (name === "api.runDetail") return fixtures[input.runId] ? JSON.parse(JSON.stringify(fixtures[input.runId])) : null;
        if (name === "api.focus") { window.__focused.push(input.terminalId); return { ok: true }; }
        throw new Error(`fake orca: no handler for ${name}`);
      },
      on: () => ({ dispose() {} }),
    },
    on: () => ({ dispose() {} }),
    document: {
      get: async () => ({ version: 1, readOnly: false, content: { kind: "text", text: params.get("doc") ?? JSON.stringify({ agentTeamRun: runId, note: "Opens the Ensemble run report." }) } }),
      onDidChange: () => ({ dispose() {} }),
      applyEdit: async () => { throw new Error("the run report must not edit its document"); },
    },
  });
})();
