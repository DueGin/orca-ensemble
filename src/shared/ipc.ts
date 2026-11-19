// What passes between the `agent-team` command, the panels and the worker.

/** A command from an agent's shell. Its identity is the Orca terminal it runs in. */
export interface ShimRequest {
  command: string;
  /** The JSON argument, already parsed; `{}` when none. */
  input: unknown;
  terminalId: string | null;
  workspaceId: string | null;
  /** The Orca profile the agent runs under; lets the worker reach the same Orca from its CLI. */
  userDataPath: string | null;
  cwd: string;
  /**
   * 2: the command can run Orca's CLI for the worker while the request is handled (see `ShimExec`), so launches and
   * messages go out as the calling agent. Absent: one request, one reply.
   */
  protocol?: number;
}

export interface ShimResponse {
  text: string;
  isError: boolean;
}

/** Worker → command, protocol 2: run `orca <args> --json` in your shell and answer with a `ShimExecResult`. */
export interface ShimExec {
  kind: "exec";
  id: number;
  args: string[];
  timeoutMs?: number;
}

/** Command → worker: what that `orca` call answered. */
export interface ShimExecResult {
  kind: "exec-result";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

/** Worker → command, protocol 2: the answer; the connection ends after it. */
export interface ShimReply extends ShimResponse {
  kind: "reply";
}
