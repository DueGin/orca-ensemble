// A stand-in for Orca's frame shell, for opening the team editor in a plain browser (dev/team-harness.html).
// Query: ?locale=zh-CN|en-US  &theme=light|dark  &file=rich|notes|broken|invalid|empty  &ro=1  &session=0 (fallback API)
//        &nofocus=1 (no focused workspace)  &fail=start (api.start rejects)
// Inspect from the page: window.__edits (texts the editor sent), window.__calls (worker requests),
// window.__outside(text) (an outside change), window.__lastTeam() (the last edit, parsed).
(function () {
  const params = new URLSearchParams(location.search);
  const locale = params.get("locale") || "en-US";
  document.documentElement.className = params.get("theme") || "dark";

  // Orca's design tokens (neutral theme), as the shell injects them.
  const tokens = {
    light: { background: "#fff", foreground: "#0a0a0a", card: "#fff", "card-foreground": "#0a0a0a", popover: "#fff", "popover-foreground": "#0a0a0a", primary: "#171717", "primary-foreground": "#fafafa", secondary: "#f5f5f5", "secondary-foreground": "#171717", muted: "#f5f5f5", "muted-foreground": "#696969", accent: "#f5f5f5", "accent-foreground": "#171717", destructive: "#e40014", "destructive-foreground": "#fff", border: "#e5e5e5", input: "#e5e5e5", ring: "#a1a1a1", radius: "0.625rem" },
    dark: { background: "#0a0a0a", foreground: "#f0f0f0", card: "#171717", "card-foreground": "#f0f0f0", popover: "#171717", "popover-foreground": "#f0f0f0", primary: "#e5e5e5", "primary-foreground": "#171717", secondary: "#262626", "secondary-foreground": "#f0f0f0", muted: "#262626", "muted-foreground": "#acacac", accent: "#404040", "accent-foreground": "#f0f0f0", destructive: "#e40014", "destructive-foreground": "#fff", border: "#ffffff12", input: "#ffffff26", ring: "#737373", radius: "0.625rem" },
  };
  const css = Object.entries(tokens).map(([theme, vars]) => `html.${theme}{${Object.entries(vars).map(([key, value]) => `--orca-${key}:${value}`).join(";")}}`).join("\n");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const FILES = {
    notes: "{\n  \"version\": 1,\n  \"name\": \"notes\",\n  \"goal\": \"A tiny notes folder used to test the agent team plugin\",\n  \"mode\": \"delegation\",\n  \"lead\": { \"agent\": \"claude\", \"model\": \"haiku\" },\n  \"roles\": [\n    { \"name\": \"writer\", \"agent\": \"claude\", \"model\": \"haiku\", \"folders\": [\"notes\"], \"instructions\": \"Writes short text files in notes/. Keep every file under 5 lines.\" },\n    { \"name\": \"checker\", \"agent\": \"claude\", \"model\": \"haiku\", \"folders\": [\"checks\"], \"instructions\": \"Writes short check files in checks/. Keep every file under 5 lines.\" }\n  ],\n  \"candidates\": []\n}\n",
    rich: JSON.stringify({
      version: 1,
      name: "Web app",
      goal: "Ship features in the web app end to end: API, UI and tests, with a reviewer checking every change.",
      mode: "auto",
      lead: { agent: "claude", model: "opus", effort: "high" },
      roles: [
        { name: "frontend", agent: "claude", model: "sonnet", folders: ["web/src", "web/public"], instructions: "Builds the React UI. Uses the design system in web/src/ui; no new dependencies without asking the lead." },
        { name: "backend", agent: "codex", model: "gpt-5.5-codex", effort: "medium", folders: ["api"], instructions: "Owns the HTTP API and the database migrations. Every endpoint gets a test." },
        { name: "reviewer", agent: "claude", model: "opus", folders: [], instructions: "" },
      ],
      candidates: [
        { name: "", agent: "gemini", model: "gemini-2.5-flash", notes: "Good at / suited for: quick research and reading large files\nCost or speed: cheap and fast\nDo not give it: changes to the API" },
        { name: "scout", agent: "claude", model: "haiku", notes: "" },
      ],
      language: "en",
      x_note: "unknown fields are kept",
    }, null, 2) + "\n",
    broken: "{\n  \"version\": 1,\n  \"name\": \"half written\",\n  \"roles\": [\n",
    invalid: JSON.stringify({ version: 1, name: "odd", mode: "swarm", lead: { agent: "claude" }, roles: "frontend", candidates: [] }, null, 2) + "\n",
    empty: JSON.stringify({ version: 1, name: "", lead: { agent: "claude" }, roles: [], candidates: [] }, null, 2) + "\n",
  };

  const readOnly = params.get("ro") === "1";
  let doc = { version: 1, readOnly, content: { kind: "text", text: FILES[params.get("file") || "rich"] ?? FILES.rich } };
  const docListeners = new Set();
  window.__edits = [];
  window.__calls = [];
  window.__lastTeam = () => (window.__edits.length ? JSON.parse(window.__edits[window.__edits.length - 1]) : null);

  function applyEdit(edit) {
    if (doc.readOnly) return Promise.reject(Object.assign(new Error("read only"), { code: "read_only" }));
    if (edit.baseVersion !== doc.version) return Promise.reject(Object.assign(new Error("conflict"), { code: "conflict" }));
    window.__edits.push(edit.content.text);
    doc = { ...doc, content: edit.content };
    return Promise.resolve({ ok: true });
  }

  // Orca's document session, reduced: debounced edits, outside changes replace an idle draft.
  function session(options) {
    const decode = options.decode || ((content) => content.text);
    const encode = options.encode || ((value) => ({ kind: "text", text: String(value) }));
    const debounceMs = options.debounceMs ?? 250;
    let value = decode(doc.content);
    let dirty = false;
    let timer = null;
    const replaced = new Set();
    docListeners.add((next) => {
      if (dirty) return;
      value = decode(next.content);
      replaced.forEach((fn) => fn(value));
    });
    const send = () => {
      timer = null;
      if (!dirty) return Promise.resolve();
      dirty = false;
      return applyEdit({ baseVersion: doc.version, content: encode(value) });
    };
    return Promise.resolve({
      get value() { return value; },
      get readOnly() { return doc.readOnly; },
      change(next) {
        if (doc.readOnly) return;
        value = next;
        dirty = true;
        clearTimeout(timer);
        timer = setTimeout(send, debounceMs);
      },
      flush() { clearTimeout(timer); return send(); },
      onReplace(fn) { replaced.add(fn); return { dispose: () => replaced.delete(fn) }; },
      dispose() {},
    });
  }

  window.__outside = (text) => {
    doc = { ...doc, version: doc.version + 1, content: { kind: "text", text } };
    docListeners.forEach((fn) => fn(doc));
  };

  const focused = params.get("nofocus") === "1" ? null : { workspaceId: "ws-1", name: "proj", branch: "main", path: "/private/tmp/orca-new/proj", agents: [] };
  const fixtures = {
    "api.catalog": () => ({ agents: ["claude", "codex", "gemini"], models: {}, efforts: ["low", "medium", "high", "xhigh", "max"] }),
    "api.state": () => ({
      focused,
      leads: [],
      projects: [
        { id: "p1", name: "proj", path: "/private/tmp/orca-new/proj", kind: "git", hostId: "local", teams: [] },
        { id: "p2", name: "web-app", path: "/Users/me/code/web-app", kind: "git", hostId: "local", teams: [] },
      ],
      presets: [],
      settings: { language: "auto", directive: true, defaultTeam: "" },
      locale,
      pluginReady: { cli: true, problems: [] },
    }),
    "api.savePreset": () => ({ ok: true, id: "p-0a1b2c3d" }),
    "api.start": (input) => {
      if (params.get("fail") === "start") throw new Error("Orca could not launch claude.");
      return { terminalId: "term-1", workspaceId: "ws-1", path: input.workspacePath ?? `/Users/me/orca/workspaces/proj/${input.newWorkspace?.name}` };
    },
  };

  const document_ = {
    get: () => Promise.resolve(doc),
    onDidChange(fn) {
      docListeners.add(fn);
      return { dispose: () => docListeners.delete(fn) };
    },
    applyEdit,
  };
  if (params.get("session") !== "0") document_.session = session;

  window.orca = Object.freeze({
    api: { major: 1, minor: 0 },
    locale,
    host: { call: () => Promise.resolve({}), has: () => false },
    plugin: {
      request(name, input) {
        window.__calls.push({ name, input });
        const fixture = fixtures[name];
        return new Promise((resolve, reject) => setTimeout(() => {
          try {
            fixture ? resolve(fixture(input)) : reject(new Error(`no fixture for ${name}`));
          } catch (error) {
            reject(error);
          }
        }, name === "api.start" ? 500 : 120));
      },
      on: () => ({ dispose() {} }),
    },
    on: () => ({ dispose() {} }),
    document: document_,
  });
})();
