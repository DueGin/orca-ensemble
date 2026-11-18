// How Orca runs each agent: as a chat (Orca's own graphical client) or in a terminal, which model ids it takes, and how
// a chat is named. Orca 1.4.261 opens claude, codex, pi, opencode and grok as chats; cursor, kimi and copilot have a chat
// client too but need their CLI on the host. Other agents (gemini, qwen-code, droid, ...) only run in a terminal.

/** Where an agent runs: Orca's chat (graphical) client, or its CLI in a terminal. */
export const SURFACES = ["chat", "terminal"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * Agents whose chat is both offered by Orca and working: a team runs them as chats unless it says otherwise. A launch
 * Orca refuses as a chat falls back to a terminal. pi, opencode and the rest can still be asked for as chats, but they
 * default to terminals: a pi chat starts and stays idle (Orca 1.4.261), so work given to it never runs.
 */
export const CHAT_AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "grok", "cursor", "kimi", "copilot"]);

export const canChat = (agent: string): boolean => CHAT_AGENTS.has(agent.trim());

/** Agents Orca can open as a chat at all, whether or not its chat works for them: the editor offers the choice for these. */
export const CHAT_OFFERED: ReadonlySet<string> = new Set([...CHAT_AGENTS, "pi", "opencode"]);

/** Where an agent runs: a chat when the team asks for one, else its choice, else a chat when its chat works, else a terminal. */
export function surfaceOf(runtime: { agent: string; surface?: Surface | null }): Surface {
  if (runtime.surface === "chat") return "chat";
  if (!canChat(runtime.agent)) return "terminal";
  return runtime.surface ?? "chat";
}

// ----- Chats as Orca names them

/** The handle Orca gives a chat: `structured-agent-session-<Orca session id>`. */
export const CHAT_HANDLE_PREFIX = "structured-agent-session-";

export const isChatHandle = (handle: string | null | undefined): boolean => !!handle && handle.startsWith(CHAT_HANDLE_PREFIX);

/** The Orca session id of a chat handle (what its agent's `ORCA_AGENT_SESSION_ID` says). */
export const chatSessionId = (handle: string): string => handle.slice(CHAT_HANDLE_PREFIX.length);

/** A chat's handle from the pane key of its status events (`<handle>:<pane>`); status events of a chat carry no terminal id. */
export function chatHandleFromPaneKey(paneKey: string | null | undefined): string | null {
  if (!paneKey || !paneKey.startsWith(CHAT_HANDLE_PREFIX)) return null;
  const at = paneKey.indexOf(":");
  return at < 0 ? paneKey : paneKey.slice(0, at);
}

/** Who is calling `agent-team`: the terminal it runs in, or the chat whose shell it runs in. */
export function callerHandle(env: Record<string, string | undefined>): string | null {
  if (env.ORCA_TERMINAL_HANDLE) return env.ORCA_TERMINAL_HANDLE;
  if (env.ORCA_AGENT_SESSION_ID) return `${CHAT_HANDLE_PREFIX}${env.ORCA_AGENT_SESSION_ID}`;
  return null;
}

// ----- Models an agent's own command line takes, for an Orca that won't pass one

/**
 * The flags an agent's CLI takes for its model and reasoning effort. Orca 1.4.259 refuses any model for pi ("does not
 * support launch-time model selection"); the plugin then starts pi in a terminal and adds these to its command line.
 */
export const CLI_MODEL_FLAGS: Readonly<Record<string, { model: string; effort?: string }>> = {
  pi: { model: "--model", effort: "--thinking" },
};

/** The words to add to an agent's command line for its model and effort, or null when its CLI flags are unknown. */
export function cliModelArgs(agent: string, model: string | undefined, effort: string | undefined): string[] | null {
  const flags = CLI_MODEL_FLAGS[agent.trim()];
  if (!flags || !model) return null;
  return [flags.model, model, ...(effort && flags.effort ? [flags.effort, effort] : [])];
}

// ----- pi's models

/** pi's models as `provider/id`, from the table `pi --list-models` prints. */
export function parsePiModels(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2 || columns[0] === "provider") continue;
    const [provider, model] = columns as [string, string];
    if (!provider || !model || /\s/.test(provider) || /\s/.test(model)) continue;
    models.push(`${provider}/${model}`);
  }
  return [...new Set(models)];
}

export type PiModelChoice = { ok: true; model: string } | { ok: false; error: string; matches: string[] };

/**
 * The `provider/id` model pi should run for what a team says. Orca (1.4.261) passes pi only a `provider/id` model, while
 * a team may name just the model (`deepseek-v4.1-flash`): a model id that one provider has is completed to that provider.
 * `known` empty (pi's list unreadable) leaves the model as it is.
 */
export function resolvePiModel(model: string, known: readonly string[]): PiModelChoice {
  const wanted = model.trim();
  if (!known.length) return { ok: true, model: wanted };
  const lower = wanted.toLowerCase();
  const exact = known.find((entry) => entry.toLowerCase() === lower);
  if (exact) return { ok: true, model: exact };
  const byId = known.filter((entry) => entry.slice(entry.indexOf("/") + 1).toLowerCase() === lower);
  if (byId.length === 1) return { ok: true, model: byId[0]! };
  if (byId.length > 1) return { ok: false, error: "ambiguous", matches: byId };
  // A provider/id pi doesn't list may still be one it reaches (a provider added since): let pi decide.
  if (wanted.includes("/")) return { ok: true, model: wanted };
  const near = known.filter((entry) => entry.toLowerCase().includes(lower)).slice(0, 8);
  return { ok: false, error: "unknown", matches: near };
}
