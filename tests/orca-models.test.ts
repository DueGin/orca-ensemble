import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelChoices } from "../src/worker/model-choices";
import { modelListOf, OrcaModels, RUNTIME_FILE, runtimeOf, socketTrusted, type OrcaModelList } from "../src/worker/orca-models";

// What Orca 1.4.274 answered for `agentSession.modelCatalog` (trimmed): ids are what `--model` takes.
const CLAUDE = {
  origin: "probe",
  fetchedAt: 1795626928429,
  listingNamesConfiguredModel: false,
  models: [
    { id: "group/auto-claude-opus[1m]", label: "Claude Opus · routing group", isDefault: false, efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High" }, { value: "max", label: "Max" }] },
    { id: "sidrune/claude-haiku-4-5", label: "Claude Haiku 4.5 (latest) · Sidrune", isDefault: true, efforts: [] },
    { id: "token/x", label: "Token X", isDefault: false, effortsKnown: false, efforts: [] },
    { id: "", label: "Model not reported", isDefault: false, efforts: [] },
    { id: "group/auto-claude-opus[1m]", label: "again", isDefault: false, efforts: [] },
  ],
};

describe("Orca's answer to a model list read", () => {
  it("keeps each model once with its label and efforts, and drops rows without an id", () => {
    expect(modelListOf(CLAUDE)).toEqual({
      listing: false,
      models: [
        { id: "group/auto-claude-opus[1m]", label: "Claude Opus · routing group", isDefault: false, efforts: ["low", "high", "max"] },
        { id: "sidrune/claude-haiku-4-5", label: "Claude Haiku 4.5 (latest) · Sidrune", isDefault: true, efforts: [] },
        // Efforts Orca says it doesn't know are unknown, not none.
        { id: "token/x", label: "Token X", isDefault: false, efforts: null },
      ],
    });
  });

  it("knows an empty answer, a list still being made, and something that isn't an answer", () => {
    expect(modelListOf({ origin: "unknown" })).toEqual({ models: [], listing: false });
    expect(modelListOf({ origin: "probe", listingInProgress: true, models: [{ id: "a", label: "A", isDefault: false, efforts: [] }] })).toMatchObject({ listing: true, models: [{ id: "a" }] });
    expect(modelListOf(null)).toBeNull();
    expect(modelListOf("no")).toBeNull();
  });
});

describe("finding Orca's runtime in its profile", () => {
  let profile: string;
  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), "orca-profile-"));
  });
  afterEach(() => {
    rmSync(profile, { recursive: true, force: true });
  });
  const write = (meta: unknown) => writeFileSync(join(profile, RUNTIME_FILE), JSON.stringify(meta));

  it("takes the local socket and its token, never the websocket", () => {
    write({ runtimeId: "r", transports: [{ kind: "websocket", endpoint: "ws://127.0.0.1:6768" }, { kind: "unix", endpoint: "/x/o.sock" }], authToken: "secret" });
    expect(runtimeOf(profile, () => true)).toEqual({ endpoint: "/x/o.sock", token: "secret" });
    // An older file names one transport.
    write({ transport: { kind: "unix", endpoint: "/y/o.sock" }, authToken: "t" });
    expect(runtimeOf(profile, () => true)).toEqual({ endpoint: "/y/o.sock", token: "t" });
  });

  it("finds none without a file, a token, a local socket or a socket it may trust", () => {
    expect(runtimeOf(profile, () => true)).toBeNull();
    write({ transports: [{ kind: "unix", endpoint: "/x/o.sock" }], authToken: null });
    expect(runtimeOf(profile, () => true)).toBeNull();
    write({ transports: [{ kind: "websocket", endpoint: "ws://127.0.0.1:1" }], authToken: "t" });
    expect(runtimeOf(profile, () => true)).toBeNull();
    write({ transports: [{ kind: "unix", endpoint: "/x/o.sock" }], authToken: "t" });
    expect(runtimeOf(profile, () => false)).toBeNull();
  });

  it("trusts only this user's socket, and in /tmp only inside this user's private folders", async () => {
    const socketPath = join(profile, "o.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(socketTrusted(socketPath)).toBe(true);
      // Someone else's socket.
      expect(socketTrusted(socketPath, (process.getuid?.() ?? 0) + 1)).toBe(false);
      // Not a socket at all.
      writeFileSync(join(profile, "plain"), "");
      expect(socketTrusted(join(profile, "plain"))).toBe(false);
      expect(socketTrusted(join(profile, "missing.sock"))).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("reading Orca's model lists over its socket", () => {
  let profile: string;
  let server: Server;
  let seen: { method: string; params: Record<string, unknown>; authToken: string }[];
  let answer: (params: Record<string, unknown>) => unknown;

  beforeEach(async () => {
    profile = mkdtempSync(join(tmpdir(), "orca-runtime-"));
    chmodSync(profile, 0o700);
    seen = [];
    const socketPath = join(profile, "o.sock");
    server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const at = buffer.indexOf("\n");
        if (at < 0) return;
        const request = JSON.parse(buffer.slice(0, at));
        seen.push({ method: request.method, params: request.params, authToken: request.authToken });
        const reply = answer(request.params);
        socket.write(`${JSON.stringify({ _keepalive: true })}\n`);
        socket.write(`${JSON.stringify(reply instanceof Error ? { id: request.id, ok: false, error: { code: "invalid_params", message: reply.message } } : { id: request.id, ok: true, result: reply, _meta: { runtimeId: "r" } })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    writeFileSync(join(profile, RUNTIME_FILE), JSON.stringify({ runtimeId: "r", transports: [{ kind: "unix", endpoint: socketPath }], authToken: "tok" }));
  });
  afterEach(() => {
    server.close();
    rmSync(profile, { recursive: true, force: true });
  });

  it("reads the saved list first, sending only the model list read with Orca's token", async () => {
    answer = () => CLAUDE;
    const list = await new OrcaModels(() => profile).list("claude");
    expect(list?.models.map((model) => model.id)).toEqual(["group/auto-claude-opus[1m]", "sidrune/claude-haiku-4-5", "token/x"]);
    expect(seen).toEqual([{ method: "agentSession.modelCatalog", params: { agent: "claude", savedOnly: true }, authToken: "tok" }]);
  });

  it("asks Orca to list the models only when asked to wait and it has none saved", async () => {
    answer = (params) => (params.waitForListing ? CLAUDE : { origin: "unknown" });
    const models = new OrcaModels(() => profile);
    expect((await models.list("claude"))?.models).toEqual([]);
    expect(seen.map((request) => request.params)).toEqual([{ agent: "claude", savedOnly: true }]);
    expect((await models.list("claude", true))?.models).toHaveLength(3);
    expect(seen.map((request) => request.params).slice(1)).toEqual([{ agent: "claude", savedOnly: true }, { agent: "claude", waitForListing: true }]);
    // Kept for a while: no new read.
    await models.list("claude", true);
    expect(seen).toHaveLength(3);
  });

  it("falls back to a plain read on an Orca that refuses savedOnly", async () => {
    answer = (params) => ("savedOnly" in params ? new Error("Unrecognized key: savedOnly") : CLAUDE);
    expect((await new OrcaModels(() => profile).list("codex"))?.models).toHaveLength(3);
    expect(seen.map((request) => request.params)).toEqual([{ agent: "codex", savedOnly: true }, { agent: "codex" }]);
  });

  it("gives null when Orca can't be reached, and refuses agent names that aren't ids", async () => {
    expect(await new OrcaModels(() => join(profile, "nowhere")).list("claude")).toBeNull();
    expect(await new OrcaModels(() => profile).list("../etc")).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("the models the editor offers", () => {
  const list = (ids: string[], listing = false): OrcaModelList => ({ listing, models: ids.map((id) => ({ id, label: id.toUpperCase(), isDefault: false, efforts: ["low"] })) });

  it("prefers Orca's list, then the agent's CLI (pi, omp), then the built-in suggestions", async () => {
    const none = { orca: async () => null, cli: async () => [] as string[] };
    expect(await modelChoices("claude", false, { ...none, orca: async () => list(["a/b"]) })).toEqual({ source: "orca", listing: false, models: [{ id: "a/b", label: "A/B", isDefault: false, efforts: ["low"] }] });
    expect(await modelChoices("pi", false, { orca: async () => list([], true), cli: async () => ["deepseek/v4"] })).toEqual({ source: "cli", listing: true, models: [{ id: "deepseek/v4", label: "deepseek/v4", isDefault: false, efforts: null }] });
    expect((await modelChoices("codex", false, none)).source).toBe("builtin");
    expect((await modelChoices("codex", false, none)).models.map((model) => model.id)).toContain("gpt-5.5");
    // The CLI is asked only for agents that print their models.
    let asked = false;
    await modelChoices("gemini", false, { orca: async () => null, cli: async () => ((asked = true), ["x"]) });
    expect(asked).toBe(false);
  });

  it("survives a failing source", async () => {
    const choices = await modelChoices("omp", true, { orca: async () => Promise.reject(new Error("down")), cli: async () => Promise.reject(new Error("no omp")) });
    expect(choices).toEqual({ source: "builtin", listing: false, models: [] });
  });
});
