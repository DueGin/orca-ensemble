// Orca's own model lists, the ones its model picker shows for each agent (Claude, Codex, pi, OpenCode…), as Orca has
// them set up: the models of the account or gateway each agent runs on, with the efforts each model takes.
//
// Orca offers plugins no host method for these, so the worker reads them the way Orca's own `orca` CLI talks to Orca:
// the runtime file in Orca's profile names a local socket and its token, and the worker sends one read,
// `agentSession.modelCatalog`. It is an Orca-internal method, so any failure (an Orca that no longer answers it, a
// profile it can't find) leaves the editor on the plugin's own suggestions. Only that read is ever sent; the token is
// read for each request and never kept, logged or sent anywhere but Orca's own socket.
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

/** A model as Orca lists it: the id `orca agent launch --model` takes, its label, and its efforts (null: unknown). */
export type OrcaModel = { id: string; label: string; isDefault: boolean; efforts: string[] | null; defaultEffort?: string };

/** An agent's models; `listing`: Orca is still listing them, so a later read may hold more. */
export type OrcaModelList = { models: OrcaModel[]; listing: boolean };

/** The file Orca writes in its profile while it runs, naming its runtime's socket. */
export const RUNTIME_FILE = "orca-runtime.json";
/** Where Orca moves a socket whose path would be too long; it must then sit in this user's private folders. */
const SHORT_SOCKET_DIR = "/tmp/.orca-daemon-";
const MAX_ANSWER = 8 * 1024 * 1024;
/** How long Orca waits for a listing it started (its model picker's wait), with some room. */
const LISTING_WAIT_MS = 40_000;
const READ_MS = 10_000;

type Runtime = { endpoint: string; token: string };

/** Whether a socket Orca named can be sent its token: this user's socket, in this user's private folders when in /tmp. */
export function socketTrusted(endpoint: string, uid: number | undefined = process.getuid?.()): boolean {
  if (uid === undefined) return true;
  try {
    const socket = lstatSync(endpoint);
    if (!socket.isSocket() || socket.uid !== uid) return false;
    if (endpoint.startsWith(`${SHORT_SOCKET_DIR}${uid}/`)) {
      for (const dir of [dirname(endpoint), dirname(dirname(endpoint))]) {
        const entry = lstatSync(dir);
        if (!entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o077) !== 0) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Orca's local runtime from its profile: its socket (or Windows pipe) and token; null when there is none to trust. */
export function runtimeOf(profile: string, trusted: (endpoint: string) => boolean = socketTrusted): Runtime | null {
  let meta: { transports?: unknown; transport?: unknown; authToken?: unknown } | null;
  try {
    meta = JSON.parse(readFileSync(join(profile, RUNTIME_FILE), "utf8"));
  } catch {
    return null;
  }
  const transports: unknown[] = Array.isArray(meta?.transports) ? meta.transports : meta?.transport ? [meta.transport] : [];
  const local = transports.find((entry): entry is { kind: string; endpoint: string } => {
    const transport = entry as { kind?: unknown; endpoint?: unknown } | null;
    return (transport?.kind === "unix" || transport?.kind === "named-pipe") && typeof transport.endpoint === "string" && transport.endpoint.length > 0;
  });
  if (!local || typeof meta?.authToken !== "string" || !meta.authToken) return null;
  if (local.kind === "unix" && !trusted(local.endpoint)) return null;
  return { endpoint: local.endpoint, token: meta.authToken };
}

/** One `agentSession.modelCatalog` read, sent as Orca's CLI sends a request: one JSON line, answered by JSON lines. */
function readCatalog(runtime: Runtime, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(runtime.endpoint);
    let buffer = "";
    let done = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Orca did not answer in time.")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_ANSWER) return finish(new Error("Orca's answer was too large."));
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let frame: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; _keepalive?: unknown };
        try {
          frame = JSON.parse(line);
        } catch {
          return finish(new Error("Orca sent an answer that is not JSON."));
        }
        if (frame._keepalive === true || frame.id !== id) continue;
        if (frame.ok === true) return finish(null, frame.result);
        const message = typeof frame.error?.message === "string" ? frame.error.message : "Orca refused the request.";
        return finish(Object.assign(new Error(message), { code: typeof frame.error?.code === "string" ? frame.error.code : undefined }));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Orca closed the connection.")));
    socket.write(`${JSON.stringify({ id, authToken: runtime.token, method: "agentSession.modelCatalog", params })}\n`);
  });
}

/** The models of an answer to `agentSession.modelCatalog`, without rows it can't use; null when it isn't one. */
export function modelListOf(answer: unknown): OrcaModelList | null {
  if (!answer || typeof answer !== "object") return null;
  const raw = answer as { models?: unknown; listingInProgress?: unknown };
  const listing = raw.listingInProgress === true;
  if (!Array.isArray(raw.models)) return { models: [], listing };
  const seen = new Set<string>();
  const models: OrcaModel[] = [];
  for (const row of raw.models as { id?: unknown; label?: unknown; isDefault?: unknown; efforts?: unknown; effortsKnown?: unknown; defaultEffort?: unknown }[]) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : id;
    const efforts =
      row.effortsKnown === false || !Array.isArray(row.efforts)
        ? null
        : (row.efforts as { value?: unknown }[]).flatMap((effort) => (typeof effort?.value === "string" && effort.value ? [effort.value] : []));
    const defaultEffort = typeof row.defaultEffort === "string" && row.defaultEffort ? row.defaultEffort : undefined;
    models.push({ id, label, isDefault: row.isDefault === true, efforts, ...(defaultEffort ? { defaultEffort } : {}) });
  }
  return { models, listing };
}

/** Agent ids Orca takes: a short lowercase name. */
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Orca's model lists per agent. A plain read answers from the lists Orca has saved and starts nothing. With `wait`, when
 * Orca has none yet, it asks Orca to list them, as Orca's model picker does when opened: Orca then runs the agent's CLI
 * and answers within its picker's wait.
 */
export class OrcaModels {
  private readonly lists = new Map<string, { at: number; list: OrcaModelList }>();

  constructor(
    private readonly profile: () => string,
    private readonly read: (runtime: Runtime, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown> = readCatalog,
    private readonly runtime: (profile: string) => Runtime | null = runtimeOf,
  ) {}

  async list(agent: string, wait = false): Promise<OrcaModelList | null> {
    const name = agent.trim();
    if (!AGENT_ID.test(name)) return null;
    const kept = this.lists.get(name);
    if (kept && kept.list.models.length && !kept.list.listing && Date.now() - kept.at < 60_000) return kept.list;
    const runtime = this.runtime(this.profile());
    if (!runtime) return null;
    const ask = (params: Record<string, unknown>, timeoutMs: number) => this.read(runtime, { agent: name, ...params }, timeoutMs).then(modelListOf, () => null);
    // An Orca from before saved-only reads refuses the key (its params are strict); a plain read starts no wait there.
    let list = (await ask({ savedOnly: true }, READ_MS)) ?? (await ask({}, READ_MS));
    if (wait && (!list || !list.models.length || list.listing)) list = (await ask({ waitForListing: true }, LISTING_WAIT_MS)) ?? list;
    if (list) this.lists.set(name, { at: Date.now(), list });
    return list;
  }
}
