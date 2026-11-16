// The Start tab: start a lead on a team (a team file of this checkout, or a preset), here or in a new worktree, with the
// user's request; or make an agent already running here the lead; or use @team in Orca's own new-agent box.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { TEAM_MODES, type PromptLanguage, type TeamMode } from "../../shared/modes";
import { runtimeLabel, teamTitle, type Team } from "../../shared/team";
import type { AppState, StartInput } from "../../shared/views";
import { t } from "../i18n";
import { AutoText, Badge, Button, Empty, Field, Icon, Segmented, Spinner } from "../kit";
import { call } from "../orca";

type Choice = { key: string; label: string; team: Team; source: StartInput["team"]; kind: "file" | "preset" };

function TeamOption({ choice, on, onPick }: { choice: Choice; on: boolean; onPick(): void }) {
  const team = choice.team;
  return (
    <button type="button" className="card click stack" onClick={onPick} style={{ "--gap": "3px", textAlign: "left", borderColor: on ? "var(--primary)" : undefined, background: on ? "color-mix(in srgb, var(--primary) 9%, var(--card))" : undefined } as CSSProperties}>
      <div className="row between">
        <span className="row" style={{ "--gap": "6px" } as CSSProperties}>
          <Icon name={choice.kind === "file" ? "file-text" : "star"} size={13} style={{ color: choice.kind === "file" ? "var(--c-tasks)" : "var(--c-plans)" }} />
          <span className="strong ellipsis">{choice.label}</span>
        </span>
        <Badge tone="var(--primary)">{t(`mode.${team.mode}`)}</Badge>
      </div>
      <span className="tiny muted ellipsis">
        {t("app.lead")} {runtimeLabel(team.lead)}
        {team.roles.length ? ` · ${t("app.teams.roles", { count: team.roles.length })}` : ""}
        {team.candidates.length ? ` · ${t("app.teams.candidates", { count: team.candidates.length })}` : ""}
      </span>
    </button>
  );
}

export function StartTab({ state, onStarted }: { state: AppState; onStarted(terminalId: string): void }) {
  const focused = state.focused;
  const [files, setFiles] = useState<{ file: string; title: string; team: Team | null; errors: string[] }[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [where, setWhere] = useState<"here" | "new">("here");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<TeamMode | "team-default">("team-default");
  const [language, setLanguage] = useState<PromptLanguage | "auto">("auto");
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!focused?.path) return setFiles([]);
    void call("teamFiles", { root: focused.path }).then(setFiles, () => setFiles([]));
  }, [focused?.path]);

  const choices = useMemo<Choice[]>(() => [
    ...(files ?? []).filter((file) => file.team).map((file) => ({ key: `file:${file.file}`, label: file.title, team: file.team!, kind: "file" as const, source: { kind: "file" as const, file: file.file, root: focused?.path ?? "" } })),
    ...state.presets.map((preset) => ({ key: `preset:${preset.id}`, label: teamTitle(preset.team), team: preset.team, kind: "preset" as const, source: { kind: "preset" as const, presetId: preset.id } })),
  ], [files, state.presets, focused?.path]);
  const choice = choices.find((entry) => entry.key === picked) ?? choices[0] ?? null;
  const canNew = focused?.projectKind === "git" && !!focused.projectPath;
  const suggestedName = (request.trim().split("\n")[0] ?? "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 36).toLowerCase() || "team-task";

  if (!focused) return <Empty icon="folder">{t("app.start.noWorkspace")}</Empty>;

  const start = () => {
    if (!choice || !focused.path) return;
    setBusy("start");
    setError(null);
    const input: StartInput = {
      team: choice.source,
      request,
      ...(mode === "team-default" ? {} : { mode }),
      ...(language === "auto" ? {} : { language }),
      ...(where === "new" && canNew ? { projectPath: focused.projectPath!, newWorkspace: { name: name.trim() || suggestedName } } : { workspacePath: focused.path }),
    };
    void call("start", input, 200_000)
      .then((result) => onStarted(result.terminalId))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(null));
  };

  const loose = focused.agents.filter((agent) => agent.role === null);
  return (
    <div className="stack" style={{ "--gap": "14px" } as CSSProperties}>
      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        <span className="label">{t("app.start.team")}</span>
        {files === null ? <Spinner /> : choices.length ? (
          <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
            {choices.map((entry) => <TeamOption key={entry.key} choice={entry} on={entry.key === choice?.key} onPick={() => setPicked(entry.key)} />)}
          </div>
        ) : (
          <span className="small muted">{t("app.start.noTeams")}</span>
        )}
      </div>

      <Field label={t("app.start.request")} hint={t("app.start.requestHint")}>
        <AutoText value={request} onChange={setRequest} rows={4} />
      </Field>

      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        <span className="label">{t("app.start.where")}</span>
        <Segmented<"here" | "new"> stretch value={where} onChange={setWhere} options={[{ value: "here", label: t("app.start.here") }, ...(canNew ? [{ value: "new" as const, label: t("app.start.newWorktree") }] : [])]} />
        {where === "new" && canNew ? (
          <Field label={t("app.start.worktreeName")} hint={t("app.start.worktreeHint", { project: focused.projectName ?? "" })}>
            <input className="input" value={name} placeholder={suggestedName} onChange={(event) => setName(event.target.value)} />
          </Field>
        ) : (
          <span className="tiny muted">{focused.name}{focused.branch ? ` · ${focused.branch}` : ""}</span>
        )}
      </div>

      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        <span className="label">{t("app.start.mode")}</span>
        <Segmented<TeamMode | "team-default"> stretch value={mode} onChange={setMode} options={[{ value: "team-default", label: choice ? `${t(`mode.${choice.team.mode}`)} ✓` : "—", title: t("mode.fromFile") }, ...TEAM_MODES.filter((entry) => entry !== choice?.team.mode).map((entry) => ({ value: entry, label: t(`mode.${entry}`), title: t(`mode.${entry}Hint`) }))]} />
        <span className="tiny muted">{t(`mode.${mode === "team-default" ? choice?.team.mode ?? "auto" : mode}Hint`)}</span>
      </div>

      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        <span className="label">{t("app.start.language")}</span>
        <Segmented<PromptLanguage | "auto"> stretch value={language} onChange={setLanguage} options={[{ value: "auto", label: t("app.start.languageAuto") }, { value: "zh", label: "中文" }, { value: "en", label: "English" }]} />
      </div>

      {error ? <div className="callout small" style={{ "--tone": "var(--bad)" } as CSSProperties}>{error}</div> : null}
      <Button variant="primary" size="lg" icon="play" block disabled={!choice || busy !== null} onClick={start}>
        {busy === "start" ? t("app.start.starting") : t("app.start.go")}
      </Button>

      <div className="sep" />
      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        <span className="h3">{t("app.start.adoptTitle")}</span>
        <span className="tiny muted">{t("app.start.adoptHint")}</span>
        {loose.length ? loose.map((agent) => (
          <div key={agent.terminalId} className="card row" style={{ padding: "6px 8px" }}>
            <span className="grow stack" style={{ "--gap": "0px" } as CSSProperties}>
              <span className="small strong ellipsis">{agent.title ?? agent.agent ?? agent.terminalId}</span>
              <span className="tiny muted">{agent.agent ?? ""} · {t(`app.state.${agent.state === "working" ? "working" : agent.state === "blocked" ? "blocked" : "done"}`)}</span>
            </span>
            <Button size="sm" disabled={!choice || busy !== null || !focused.path} onClick={() => {
              if (!choice || !focused.path) return;
              setBusy(agent.terminalId);
              void call("adopt", { terminalId: agent.terminalId, workspaceId: focused.workspaceId, path: focused.path, team: choice.source, ...(mode === "team-default" ? {} : { mode }), ...(language === "auto" ? {} : { language }) })
                .then(() => onStarted(agent.terminalId))
                .catch((reason: unknown) => setError(String(reason)))
                .finally(() => setBusy(null));
            }}>{t("app.start.adopt")}</Button>
          </div>
        )) : <span className="small muted">{t("app.start.noAgents")}</span>}
      </div>

      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        <span className="h3">{t("app.start.nativeTitle")}</span>
        <span className="tiny muted">{t("app.start.nativeHint")}</span>
        <pre className="card inset mono small">{t("app.start.nativeExample")}</pre>
      </div>
    </div>
  );
}
