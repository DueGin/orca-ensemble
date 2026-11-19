// Who is calling the plugin right now: the agent whose `agent-team` command is being handled. Its command runs in
// that agent's own shell, so it can run Orca's CLI as that agent: a launch it makes shows in the agent's chat as a
// handoff ("handed off to an agent"), and Orca's orchestration knows the agent as the sender without `--from` (which a
// chat can't be named in). Work the plugin does on its own (a sweep, a status event) has no caller and uses the
// plugin's own CLI.
import { AsyncLocalStorage } from "node:async_hooks";

export interface Caller {
  /** The terminal's or chat's handle the request came from. */
  handle: string;
  /** Runs `orca <args> --json` in the caller's shell; resolves with its `result`, rejects with its error (and code). */
  exec<T = any>(args: string[], timeoutMs?: number): Promise<T>;
}

const callers = new AsyncLocalStorage<Caller>();

export function asCaller<T>(caller: Caller | null, work: () => Promise<T>): Promise<T> {
  return caller ? callers.run(caller, work) : work();
}

/** The agent whose command is being handled, when it can run Orca's CLI for the plugin. */
export function currentCaller(): Caller | null {
  return callers.getStore() ?? null;
}

/** The caller, when it is this agent: launches and messages for a lead's team go out as the lead only. */
export function callerIs(handle: string | null | undefined): Caller | null {
  const caller = currentCaller();
  return caller && handle && caller.handle === handle ? caller : null;
}
