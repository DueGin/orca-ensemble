// The Teams tab: the team files of the focused checkout (open one in the team editor, or create one) and the presets.
import { useEffect, useState, type CSSProperties } from "react";
import { runtimeLabel, teamTitle, type Team } from "../../shared/team";
import type { AppState } from "../../shared/views";
import { t } from "../i18n";
import { Badge, Button, Empty, Icon, Spinner } from "../kit";
import { call } from "../orca";

function Summary({ team }: { team: Team }) {
  return (
    <span className="tiny muted ellipsis">
      {t(`mode.${team.mode}`)} · {t("app.lead")} {runtimeLabel(team.lead)}
      {team.roles.length ? ` · ${t("app.teams.roles", { count: team.roles.length })}` : ""}
      {team.candidates.length ? ` · ${t("app.teams.candidates", { count: team.candidates.length })}` : ""}
    </span>
  );
}

export function TeamsTab({ state, refresh }: { state: AppState; refresh(): void }) {
  const root = state.focused?.path ?? null;
  const [files, setFiles] = useState<{ file: string; title: string; team: Team | null; errors: string[] }[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [planName, setPlanName] = useState("");
  const [planning, setPlanning] = useState(false);
  const load = () => {
    if (!root) return setFiles([]);
    void call("teamFiles", { root }).then(setFiles, () => setFiles([]));
  };
  useEffect(load, [root, state.presets.length]);

  const open = (file: string) => {
    if (!root) return;
    void call("openTeamFile", { root, file }).then((result) => setError(result.ok ? null : result.error ?? null));
  };
  const create = (presetId?: string, title?: string) => {
    if (!root) return;
    setBusy(true);
    void call("createTeam", { root, name: title ?? name, ...(presetId ? { presetId } : {}) })
      .then((result) => {
        setName("");
        setError(result.opened ? null : result.error ?? null);
        load();
      })
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="stack" style={{ "--gap": "16px" } as CSSProperties}>
      <div className="stack" style={{ "--gap": "8px" } as CSSProperties}>
        <span className="h3">{state.focused?.name ? t("app.teams.projectTeams", { project: state.focused.projectName ?? state.focused.name }) : t("app.teams.noProject")}</span>
        {!root ? null : files === null ? <Spinner /> : files.length ? (
          <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
            {files.map((entry) => (
              <button key={entry.file} type="button" className="card click stack" style={{ "--gap": "3px", textAlign: "left" } as CSSProperties} onClick={() => open(entry.file)}>
                <div className="row between">
                  <span className="row" style={{ "--gap": "6px" } as CSSProperties}>
                    <Icon name="file-text" size={13} style={{ color: "var(--c-tasks)" }} />
                    <span className="strong ellipsis">{entry.title}</span>
                  </span>
                  {entry.errors.length ? <Badge tone="var(--bad)">{t("app.teams.invalid")}</Badge> : <Icon name="external" size={12} style={{ color: "var(--muted-fg)" }} />}
                </div>
                {entry.team ? <Summary team={entry.team} /> : <span className="tiny bad clamp2">{entry.errors[0]}</span>}
                <span className="tiny muted mono ellipsis">{entry.file}</span>
              </button>
            ))}
          </div>
        ) : (
          <Empty icon="file-text">{t("app.teams.none")}</Empty>
        )}
        {root ? (
          <div className="row">
            <input className="input" value={name} placeholder={t("app.teams.newName")} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) create(); }} />
            <Button icon="plus" variant="primary" disabled={!name.trim() || busy} onClick={() => create()}>{t("app.teams.create")}</Button>
          </div>
        ) : null}
        {error ? <span className="tiny bad">{error}</span> : null}
      </div>

      {root ? (
        <div className="card inset stack" style={{ "--gap": "8px" } as CSSProperties}>
          <div className="row" style={{ "--gap": "6px" } as CSSProperties}>
            <span className="tile" style={{ "--tone": "var(--c-summary)" } as CSSProperties}><Icon name="sparkles" /></span>
            <span className="h3">{t("app.teams.plan")}</span>
          </div>
          <span className="tiny muted">{t("app.teams.planHint")}</span>
          <textarea className="textarea" rows={2} value={goal} placeholder={t("app.teams.planGoalHint")} onChange={(event) => setGoal(event.target.value)} />
          <div className="row">
            <input className="input" value={planName} placeholder={t("app.teams.newName")} onChange={(event) => setPlanName(event.target.value)} />
            <Button icon="sparkles" disabled={planning} onClick={() => {
              setPlanning(true);
              void call("planTeam", { root, goal, name: planName.trim() || "team" }).then(() => { setGoal(""); refresh(); }, (reason: unknown) => setError(String(reason))).finally(() => setPlanning(false));
            }}>{t("app.teams.planGo")}</Button>
          </div>
          {state.planners.map((job) => (
            <div key={job.terminalId} className="row small" style={{ "--gap": "6px" } as CSSProperties}>
              {job.status === "planning" ? <Spinner /> : <Icon name={job.status === "done" ? "check" : "alert"} style={{ color: job.status === "done" ? "var(--ok)" : "var(--bad)" }} />}
              <span className="grow ellipsis">{t(job.status === "planning" ? "app.teams.planning" : job.status === "done" ? "app.teams.planned" : "app.teams.planFailed", { file: job.file.split("/").pop() ?? job.file })}</span>
              {job.status === "done" ? <Button size="sm" variant="ghost" icon="external" onClick={() => open(job.file)} /> : <Button size="sm" variant="ghost" icon="terminal" title={t("app.focus")} onClick={() => void call("focus", { terminalId: job.terminalId })} />}
            </div>
          ))}
        </div>
      ) : null}

      <div className="sep" />
      <div className="stack" style={{ "--gap": "8px" } as CSSProperties}>
        <div className="stack" style={{ "--gap": "2px" } as CSSProperties}>
          <span className="h3">{t("app.teams.presets")}</span>
          <span className="tiny muted">{t("app.teams.presetsHint")}</span>
        </div>
        {state.presets.length ? state.presets.map((preset) => (
          <div key={preset.id} className="card stack" style={{ "--gap": "6px" } as CSSProperties}>
            <div className="row between">
              <span className="row" style={{ "--gap": "6px" } as CSSProperties}>
                <Icon name="star" size={13} style={{ color: "var(--c-plans)" }} />
                <span className="strong ellipsis">{teamTitle(preset.team)}</span>
              </span>
              <Badge tone="var(--primary)">{t(`mode.${preset.team.mode}`)}</Badge>
            </div>
            <Summary team={preset.team} />
            {confirming === preset.id ? (
              <div className="row wrap">
                <span className="small">{t("app.teams.deleteConfirm", { name: teamTitle(preset.team) })}</span>
                <Button size="sm" variant="danger" onClick={() => void call("deletePreset", { id: preset.id }).then(() => { setConfirming(null); refresh(); })}>{t("app.teams.delete")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>×</Button>
              </div>
            ) : (
              <div className="row">
                {root ? <Button size="sm" icon="copy" disabled={busy} onClick={() => create(preset.id, teamTitle(preset.team))}>{t("app.teams.saveToProject")}</Button> : null}
                <Button size="sm" variant="ghost" icon="trash" title={t("app.teams.delete")} onClick={() => setConfirming(preset.id)} />
              </div>
            )}
          </div>
        )) : <span className="small muted">{t("app.teams.noPresets")}</span>}
      </div>
    </div>
  );
}
