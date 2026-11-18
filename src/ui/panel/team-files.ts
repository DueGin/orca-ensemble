// The team files of the focused checkout, for the Teams and Start tabs. The team editor's edits reach the file when the
// user saves it in Orca, so the list is read again: every few seconds while the panel is visible, every 15 seconds
// otherwise, and when it gets focus. A team renamed or changed in the editor shows here once it is saved.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Team } from "../../shared/team";
import { call } from "../orca";

export type TeamFileEntry = { file: string; title: string; team: Team | null; errors: string[] };

const RELOAD = "ensemble:team-files";

/** Reads the team files again now, wherever they are shown; the panel's refresh button calls it. */
export function reloadTeamFiles(): void {
  window.dispatchEvent(new Event(RELOAD));
}

export function useTeamFiles(root: string | null | undefined, intervalMs = 3000, hiddenIntervalMs = 15_000): { files: TeamFileEntry[] | null; reload(): void } {
  const [files, setFiles] = useState<TeamFileEntry[] | null>(null);
  const shown = useRef("");
  const current = useRef(root);
  current.current = root;
  const reload = useCallback(() => {
    if (!root) {
      shown.current = "";
      setFiles([]);
      return;
    }
    void call("teamFiles", { root }).then(
      (next) => {
        // A reply for a checkout the panel has left, or the same list again, changes nothing.
        if (current.current !== root) return;
        const text = JSON.stringify(next);
        if (text === shown.current) return;
        shown.current = text;
        setFiles(next);
      },
      () => setFiles((previous) => previous ?? []),
    );
  }, [root]);
  useEffect(() => {
    shown.current = "";
    setFiles(null);
    reload();
    // Often while the panel can be seen; now and then otherwise, since a frame may report itself hidden while shown.
    let last = Date.now();
    const tick = () => {
      const every = document.visibilityState === "visible" ? intervalMs : hiddenIntervalMs;
      if (Date.now() - last < every) return;
      last = Date.now();
      reload();
    };
    const now = () => {
      last = Date.now();
      reload();
    };
    const timer = setInterval(tick, Math.min(intervalMs, 1000));
    window.addEventListener("focus", now);
    window.addEventListener(RELOAD, now);
    const onVisible = () => {
      if (document.visibilityState === "visible") now();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", now);
      window.removeEventListener(RELOAD, now);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, intervalMs, hiddenIntervalMs]);
  return { files, reload };
}
