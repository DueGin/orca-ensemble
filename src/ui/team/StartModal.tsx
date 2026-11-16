// Starts a session with the team as it is in the editor: the request, the mode and language for this session, and where
// the lead runs (the focused workspace, or a new worktree of a project).
import { useEffect, useRef, useState } from "react";
import { languageFromLocale, TEAM_MODES, type PromptLanguage, type TeamMode } from "../../shared/modes";
import type { AppState } from "../../shared/views";
import { t } from "../i18n";
import { Button, Icon, Segmented, Spinner } from "../kit";
import { call } from "../orca";
import { GrowText, languageOptions, Select, type LanguageChoice } from "./controls";
import type { TeamDraft } from "./draft";
import type { Check } from "./validate";

type Where = "here" | "worktree";

/** A worktree name from the request's first words, else the team's name. */
function suggestName(request: string, team: TeamDraft): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const fromRequest = slug(request.split(/\s+/).slice(0, 5).join(" ")).slice(0, 40).replace(/-+$/, "");
  return fromRequest || slug(team.name) || "team-session";
}

export function StartModal({ team, check, onClose, onStarted }: { team: TeamDraft; check: Check; onClose(): void; onStarted(path: string): void }) {
  const [request, setRequest] = useState("");
  const [mode, setMode] = useState<TeamMode>(team.mode);
  const [language, setLanguage] = useState<LanguageChoice>(team.language ?? "auto");
  const [where, setWhere] = useState<Where>("here");
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = () => {
    setLoadError(null);
    call("state")
      .then((next) => {
        setState(next);
        const projects = next.projects.filter((project) => project.kind === "git");
        const path = next.focused?.path ?? "";
        const match = projects.find((project) => path === project.path || path.startsWith(`${project.path}/`)) ?? projects.find((project) => project.name === next.focused?.name) ?? projects[0];
        setProjectPath((current) => current || match?.path || "");
      })
      .catch((reason: Error) => setLoadError(reason?.message ?? String(reason)));
  };
  useEffect(load, []);

  useEffect(() => {
    boxRef.current?.querySelector("textarea")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const focusedPath = state?.focused?.path ?? null;
  const projects = state?.projects.filter((project) => project.kind === "git") ?? [];
  const worktreeName = name.trim() || suggestName(request, team);
  const placeReady = where === "here" ? !!focusedPath : !!projectPath;
  const ready = !!check.team && !!request.trim() && !!state && placeReady && !busy;

  const start = async () => {
    if (!ready || !check.team || !state) return;
    setBusy(true);
    setError(null);
    // "Orca's" language means the app's, even when the team names one.
    const chosen: PromptLanguage | undefined = language === "auto" ? (team.language ? (state.settings.language === "auto" ? languageFromLocale(state.locale) : state.settings.language) : undefined) : language;
    try {
      const result = await call("start", {
        team: { kind: "inline", team: check.team },
        request: request.trim(),
        mode,
        language: chosen,
        ...(where === "here" ? { workspacePath: focusedPath! } : { projectPath, newWorkspace: { name: worktreeName, baseBranch: baseBranch.trim() || undefined } }),
      });
      onStarted(result.path);
    } catch (reason) {
      setError((reason as Error)?.message ?? String(reason));
      setBusy(false);
    }
  };

  return (
    <div className="modal-back te-modal-back" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="modal te-modal" role="dialog" aria-modal aria-label={t("editor.startModal.title")} ref={boxRef}>
        <div className="te-modal-head">
          <span className="te-section-icon" style={{ ["--tone" as string]: "var(--primary)" }}><Icon name="play" size={15} /></span>
          <div className="grow">
            <h2 className="te-h2">{t("editor.startModal.title")}</h2>
            <p className="te-sub">{t("editor.startModal.subtitle", { team: team.name.trim() || t("editor.untitled") })}</p>
          </div>
          <button type="button" className="te-tool" aria-label={t("editor.close")} onClick={onClose} disabled={busy}><Icon name="x" size={14} /></button>
        </div>

        {!check.team ? (
          <div className="te-callout bad"><Icon name="alert" size={14} />{t("editor.startModal.invalid", { count: check.errors })}</div>
        ) : null}

        <div className="te-modal-body">
          <div className="te-slot">
            <span className="te-label">{t("editor.startModal.request")}</span>
            <div onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void start(); } }}>
              <GrowText value={request} rows={4} placeholder={t("editor.startModal.requestPlaceholder")} onChange={setRequest} />
            </div>
          </div>

          <div className="te-modal-row">
            <div className="te-slot">
              <span className="te-label">{t("editor.startModal.mode")}</span>
              <Segmented<TeamMode> value={mode} stretch options={TEAM_MODES.map((value) => ({ value, label: t(`mode.${value}`), title: t(`mode.${value}Hint`) }))} onChange={setMode} />
            </div>
            <div className="te-slot">
              <span className="te-label">{t("editor.startModal.language")}</span>
              <Segmented<LanguageChoice> value={language} stretch options={languageOptions()} onChange={setLanguage} />
            </div>
          </div>

          <div className="te-slot">
            <span className="te-label">{t("editor.startModal.where")}</span>
            <div className="te-where">
              {(["here", "worktree"] as const).map((value) => (
                <button key={value} type="button" className={`te-where-opt${where === value ? " on" : ""}`} onClick={() => setWhere(value)} aria-pressed={where === value}>
                  <Icon name={value === "here" ? "terminal" : "branch"} size={15} />
                  <span className="grow">
                    <span className="te-where-title">{t(`editor.startModal.${value}`)}</span>
                    <span className="te-where-sub">{value === "here" ? (state ? state.focused?.name ?? t("editor.startModal.noneFocused") : "…") : t("editor.startModal.worktreeSub")}</span>
                  </span>
                  <span className="te-radio" aria-hidden>{where === value ? <Icon name="check" size={11} /> : null}</span>
                </button>
              ))}
            </div>
          </div>

          {!state && !loadError ? (
            <div className="row muted small"><Spinner />{t("editor.startModal.loading")}</div>
          ) : loadError ? (
            <div className="te-callout bad"><Icon name="alert" size={14} /><span className="grow">{t("editor.startModal.loadFailed", { error: loadError })}</span><Button size="sm" onClick={load}>{t("editor.retry")}</Button></div>
          ) : where === "here" ? (
            focusedPath ? (
              <div className="te-place">
                <Icon name="folder" size={14} />
                <span className="grow">
                  <span className="strong">{state!.focused!.name}</span>
                  {state!.focused!.branch ? <span className="te-place-branch"><Icon name="branch" size={11} />{state!.focused!.branch}</span> : null}
                  <span className="te-place-path mono">{focusedPath}</span>
                </span>
              </div>
            ) : (
              <div className="te-callout warn"><Icon name="info" size={14} /><span>{t("editor.startModal.noFocus")}</span></div>
            )
          ) : projects.length ? (
            <div className="te-modal-row">
              <label className="te-slot">
                <span className="te-label">{t("editor.startModal.project")}</span>
                <Select value={projectPath} label={t("editor.startModal.project")} onChange={setProjectPath} options={projects.map((project) => ({ value: project.path, label: project.name }))} />
              </label>
              <label className="te-slot">
                <span className="te-label">{t("editor.startModal.worktreeName")}</span>
                <input className="te-input mono" value={name} placeholder={suggestName(request, team)} spellCheck={false} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="te-slot">
                <span className="te-label">{t("editor.startModal.baseBranch")}</span>
                <input className="te-input mono" value={baseBranch} placeholder={t("editor.startModal.baseBranchPlaceholder")} spellCheck={false} onChange={(event) => setBaseBranch(event.target.value)} />
              </label>
            </div>
          ) : (
            <div className="te-callout warn"><Icon name="info" size={14} /><span>{t("editor.startModal.noProjects")}</span></div>
          )}

          {error ? <div className="te-callout bad"><Icon name="alert" size={14} /><span>{t("editor.startModal.failed", { error })}</span></div> : null}
        </div>

        <div className="te-modal-foot">
          <span className="te-hint grow">{t("editor.startModal.inlineNote")}</span>
          <Button onClick={onClose} disabled={busy}>{t("editor.cancel")}</Button>
          <Button variant="primary" icon={busy ? undefined : "play"} onClick={start} disabled={!ready}>
            {busy ? <Spinner /> : null}
            {t("editor.startModal.go")}
          </Button>
        </div>
      </div>
    </div>
  );
}
