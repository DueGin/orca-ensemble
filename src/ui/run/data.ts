// The full run from the worker, refreshed when the worker reports a change and polled while the run is active.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDetail } from "../../shared/views";
import { call, onChanged } from "../orca";

export interface RunDetailState {
  run: RunDetail | null;
  loading: boolean;
  error: string | null;
  /** When the run was last read; 0 before the first read. */
  loadedAt: number;
  refresh(): Promise<void>;
}

export function useRunDetail(runId: string | null, pollMs = 3000): RunDetailState {
  const [state, setState] = useState<Omit<RunDetailState, "refresh">>({ run: null, loading: true, error: null, loadedAt: 0 });
  const current = useRef(runId);
  const busy = useRef(false);
  const again = useRef(false);
  current.current = runId;

  const load = useCallback(async () => {
    if (!runId) return;
    // One read at a time; a change during a read reads once more after it.
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const run = await call("runDetail", { runId });
      if (current.current === runId) setState({ run: run ?? null, loading: false, error: null, loadedAt: Date.now() });
    } catch (error) {
      if (current.current === runId) setState((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [runId]);

  useEffect(() => {
    setState({ run: null, loading: true, error: null, loadedAt: 0 });
    void load();
    return onChanged((runs) => {
      if (!runs.length || (runId && runs.includes(runId))) void load();
    });
  }, [load, runId]);

  const active = state.run?.status === "active";
  useEffect(() => {
    if (!active || !pollMs) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [active, load, pollMs]);

  return { ...state, refresh: load };
}
