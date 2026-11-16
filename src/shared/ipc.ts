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
}

export interface ShimResponse {
  text: string;
  isError: boolean;
}
