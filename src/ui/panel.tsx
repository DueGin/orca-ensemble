// The Ensemble panel in Orca's right sidebar: the focused workspace's team session (mode, brief to confirm, members,
// the run's data flow and its components), starting a session, and the project's teams and presets.
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../shared/views";
import { t } from "./i18n";
import { Button, Icon, Segmented, Spinner } from "./kit";
import { call, onChanged, orca } from "./orca";
import { SessionTab } from "./panel/session";
import { StartTab } from "./panel/start";
import { TeamsTab } from "./panel/teams";

type Tab = "session" | "start" | "teams";

/** The app state from the worker, refreshed on its change posts, on focus moves and every few seconds. */
function useAppState(): { state: AppState | null; error: string | null; refresh(): void } {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const refresh = useCallback(() => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    call("state", {} as never, 30_000)
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        busy.current = false;
        if (again.current) {
          again.current = false;
          refresh();
        }
      });
  }, []);
  useEffect(() => {
    refresh();
    const off = onChanged(() => refresh());
    const timer = setInterval(refresh, 5000);
    const focus = (() => {
      try {
        return orca().on("workspace.changed", () => refresh());
      } catch {
        return null;
      }
    })();
    return () => {
      off();
      clearInterval(timer);
      focus?.dispose();
    };
  }, [refresh]);
  return { state, error, refresh };
}

function App() {
  const { state, error, refresh } = useAppState();
  const [tab, setTab] = useState<Tab>("session");
  const [selected, setSelected] = useState<string | null>(null);
  const focusedPath = state?.focused?.path ?? null;
  const here = useMemo(() => (state?.leads ?? []).filter((lead) => lead.path === focusedPath), [state, focusedPath]);
  // A workspace without a session opens on Start.
  const opened = useRef(false);
  useEffect(() => {
    if (!state || opened.current) return;
    opened.current = true;
    if (!here.length && !state.leads.some((lead) => !lead.ended)) setTab("start");
  }, [state, here]);

  if (!state) {
    return (
      <div className="pad row">
        {error ? (
          <div className="stack">
            <span className="bad">{t("app.error", { error })}</span>
            <Button icon="refresh" onClick={refresh}>{t("app.retry")}</Button>
          </div>
        ) : (
          <>
            <Spinner />
            <span className="muted">{t("app.loading")}</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="stack" style={{ "--gap": "0px", minHeight: "100vh" } as React.CSSProperties}>
      <div className="stick pad stack" style={{ "--gap": "10px", paddingBottom: 8, borderBottom: "1px solid var(--border)" } as React.CSSProperties}>
        <div className="row between">
          <div className="row">
            <span className="tile" style={{ "--tone": "var(--primary)" } as React.CSSProperties}><Icon name="users" /></span>
            <div className="stack" style={{ "--gap": "0px" } as React.CSSProperties}>
              <span className="h2">{t("app.title")}</span>
              {state.focused ? <span className="tiny muted ellipsis">{state.focused.projectName ? `${state.focused.projectName} · ` : ""}{state.focused.name}{state.focused.branch ? ` · ${state.focused.branch}` : ""}</span> : null}
            </div>
          </div>
          <Button icon="refresh" variant="ghost" size="sm" title={t("app.retry")} onClick={refresh} />
        </div>
        <Segmented<Tab>
          stretch
          value={tab}
          onChange={setTab}
          options={[
            { value: "session", label: <span className="row" style={{ "--gap": "5px", justifyContent: "center" } as React.CSSProperties}>{t("app.tabs.session")}{state.leads.some((lead) => lead.pendingBrief && !lead.pendingBrief.confirmed && !lead.ended) ? <span className="dot live" style={{ "--tone": "var(--c-brief)" } as React.CSSProperties} /> : null}</span> },
            { value: "start", label: t("app.tabs.start") },
            { value: "teams", label: t("app.tabs.teams") },
          ]}
        />
        {state.pluginReady.problems.length ? (
          <div className="callout small" style={{ "--tone": "var(--bad)" } as React.CSSProperties}>
            <div className="strong">{t("app.problems")}</div>
            {state.pluginReady.problems.map((problem) => <div key={problem}>{problem}</div>)}
          </div>
        ) : null}
      </div>
      <div className="pad">
        {tab === "session" ? <SessionTab state={state} selected={selected} onSelect={setSelected} onStart={() => setTab("start")} refresh={refresh} /> : null}
        {tab === "start" ? <StartTab state={state} onStarted={(terminalId) => { setSelected(terminalId); setTab("session"); refresh(); }} /> : null}
        {tab === "teams" ? <TeamsTab state={state} refresh={refresh} /> : null}
      </div>
    </div>
  );
}

const theme = () => {
  try {
    orca().on("theme", ({ colorScheme }: { colorScheme: string }) => {
      document.documentElement.classList.toggle("light", colorScheme === "light");
      document.documentElement.classList.toggle("dark", colorScheme !== "light");
    });
  } catch {
    // Older frames set the class themselves.
  }
};
theme();
createRoot(document.getElementById("root")!).render(<App />);
