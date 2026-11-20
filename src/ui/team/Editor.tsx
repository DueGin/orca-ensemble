// The team editor: a team file as a page of sections (overview, collaboration, lead, roles, candidates), with its own
// undo history, inline problems, and actions to save the team as a preset or start a session with it.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MODE_SPECS, TEAM_MODES, type TeamMode } from "../../shared/modes";
import { blankTeam, candidateHandle, runtimeLabel } from "../../shared/team";
import { t } from "../i18n";
import { AgentAvatar, Button, Icon, Segmented } from "../kit";
import { call } from "../orca";
import { BrokenView } from "./Broken";
import { FieldIssues, FolderChips, GrowText, hasError, IssuesContext, languageOptions, RuntimeEditor, Slot, Tool, useIssues, type LanguageChoice } from "./controls";
import type { DocSession } from "./doc";
import { cleanRuntime, newCandidate, newRole, toDraft, uniqueName, takenNames, type CandidateDraft, type Draft, type RoleDraft, type RuntimeDraft, type TeamDraft } from "./draft";
import { useHistory } from "./history";
import { StartModal } from "./StartModal";
import { checkDraft, issuePlace, type Check, type Issue } from "./validate";

type BrokenDraft = Extract<Draft, { kind: "broken" }>;
type Patch = (team: TeamDraft) => TeamDraft;

const ROLE_TONES = ["var(--c-tasks)", "var(--c-board)", "var(--c-plans)", "var(--c-claims)", "var(--c-brief)", "var(--c-reports)", "var(--c-split)", "var(--c-contexts)"];
const MODE_ICON: Record<TeamMode, string> = { auto: "sparkles", team: "users", delegation: "split", none: "bot" };
const MODE_FACETS: Record<TeamMode, string[]> = { auto: ["perRequest", "locked"], team: ["intake", "shared"], delegation: ["isolated", "reports"], none: ["solo"] };
const SECTIONS = [
  { id: "overview", icon: "file-text" },
  { id: "collab", icon: "layers" },
  { id: "lead", icon: "crown" },
  { id: "roles", icon: "users" },
  { id: "candidates", icon: "boxes" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** The section a field is shown in. */
function sectionOf(field: string): SectionId {
  const head = field.split(".")[0];
  if (head === "mode" || head === "language") return "collab";
  if (head === "lead" || head === "roles" || head === "candidates") return head;
  return "overview";
}

/** The mode hint without its "Team (MA-08):" lead-in, which the card already shows. */
const modeHint = (mode: TeamMode) => {
  // The hint without its "Team (MA-08):" lead-in, which the card already shows; sentence case again.
  const trimmed = t(`mode.${mode}Hint`).replace(/^[^:：]{1,32}[:：]\s*/, "");
  const hint = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return hint.charAt(0).toUpperCase() + hint.slice(1);
};
const modePattern = (mode: TeamMode) => (mode === "auto" ? `${MODE_SPECS.team.pattern} · ${MODE_SPECS.delegation.pattern}` : mode === "none" ? "" : MODE_SPECS[mode].pattern);

const blankDraft = (name = ""): TeamDraft => toDraft(blankTeam(name) as unknown as Record<string, unknown>).team;

// ---------------------------------------------------------------------------------------------------------------------
// Toasts

interface Toast {
  id: number;
  text: string;
  tone?: "ok" | "bad" | "info";
  action?: { label: string; run(): void };
}

function useToasts() {
  const [list, setList] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setList((all) => all.filter((toast) => toast.id !== id)), []);
  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = (seq.current += 1);
    setList((all) => [...all.slice(-2), { ...toast, id }]);
    setTimeout(() => dismiss(id), toast.action ? 6500 : 4000);
  }, [dismiss]);
  return { list, push, dismiss };
}

function Toasts({ list, dismiss }: { list: Toast[]; dismiss(id: number): void }) {
  return (
    <div className="te-toasts" aria-live="polite">
      {list.map((toast) => (
        <div key={toast.id} className={`te-toast ${toast.tone ?? "info"}`}>
          <Icon name={toast.tone === "bad" ? "alert" : toast.tone === "ok" ? "check" : "info"} size={14} />
          <span className="grow">{toast.text}</span>
          {toast.action ? <button type="button" className="te-toast-action" onClick={() => { toast.action!.run(); dismiss(toast.id); }}>{toast.action.label}</button> : null}
          <button type="button" className="te-toast-close" aria-label={t("editor.close")} onClick={() => dismiss(toast.id)}><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Jumping to a field

function jumpTo(field: string) {
  let path = field;
  let node: HTMLElement | null = null;
  for (;;) {
    node = document.querySelector<HTMLElement>(`[data-field="${CSS.escape(path)}"]`);
    if (node || !path.includes(".")) break;
    path = path.slice(0, path.lastIndexOf("."));
  }
  node ??= document.getElementById(`te-${sectionOf(field)}`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  const target = node.matches("input, textarea, select") ? node : node.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select");
  target?.focus({ preventScroll: true });
  node.classList.remove("te-flash");
  void node.offsetWidth;
  node.classList.add("te-flash");
  setTimeout(() => node?.classList.remove("te-flash"), 1600);
}

// ---------------------------------------------------------------------------------------------------------------------
// The status button and its list of problems

function Status({ check, team, onJump }: { check: Check; team: TeamDraft; onJump(field: string): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const tone = check.errors ? "bad" : "ok";
  const sorted = [...check.issues].sort((a, b) => Number(a.level === "warning") - Number(b.level === "warning"));
  return (
    <div className="te-status-wrap" ref={ref}>
      <button type="button" className={`te-status ${tone}`} aria-expanded={open} onClick={() => setOpen((was) => !was)} title={t("editor.statusTitle")}>
        <Icon name={check.errors ? "alert" : "check"} size={13} />
        <span>{check.errors ? t("editor.problems", { count: check.errors }) : t("editor.valid")}</span>
        {check.warnings ? <span className="te-status-sub">{t("editor.suggestions", { count: check.warnings })}</span> : null}
      </button>
      {open ? (
        <div className="te-pop" role="dialog" aria-label={t("editor.checkTitle")}>
          <div className="te-pop-head">
            <span className="strong">{t("editor.checkTitle")}</span>
            <span className="muted small">{check.errors ? t("editor.problems", { count: check.errors }) : t("editor.valid")}</span>
          </div>
          {sorted.length ? (
            <div className="te-pop-list">
              {sorted.map((issue, index) => (
                <button key={index} type="button" className={`te-pop-item ${issue.level}`} onClick={() => { setOpen(false); onJump(issue.field); }}>
                  <Icon name={issue.level === "error" ? "alert" : "info"} size={13} />
                  <span className="grow">
                    <span className="te-pop-place">{issuePlace(team, issue.field)}</span>
                    <span className="te-pop-msg">{issue.message}</span>
                  </span>
                  <Icon name="right" size={12} />
                </button>
              ))}
            </div>
          ) : (
            <div className="te-pop-empty"><Icon name="check" size={14} /> {t("editor.allGood")}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Sections

function Section({ id, icon, tone, title, hint, count, actions, children }: { id: SectionId; icon: string; tone: string; title: string; hint?: ReactNode; count?: number; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="te-section" id={`te-${id}`}>
      <div className="te-section-head">
        <span className="te-section-icon" style={{ "--tone": tone } as CSSProperties}><Icon name={icon} size={16} /></span>
        <div className="grow">
          <h2 className="te-h2">
            {title}
            {count !== undefined ? <span className="te-count">{count}</span> : null}
          </h2>
          {hint ? <p className="te-sub">{hint}</p> : null}
        </div>
        {actions ? <div className="te-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function ModeCards({ value, onChange }: { value: TeamMode; onChange(mode: TeamMode): void }) {
  return (
    <div className="te-modes" role="radiogroup" aria-label={t("mode.label")} data-field="mode">
      {TEAM_MODES.map((mode) => {
        const on = value === mode;
        const pattern = modePattern(mode);
        return (
          <button key={mode} type="button" role="radio" aria-checked={on} className={`te-mode m-${mode}${on ? " on" : ""}`} onClick={() => onChange(mode)}>
            <span className="te-mode-head">
              <span className="te-mode-icon"><Icon name={MODE_ICON[mode]} size={16} /></span>
              <span className="te-mode-title">{t(`mode.${mode}`)}</span>
              <span className="te-radio" aria-hidden>{on ? <Icon name="check" size={11} /> : null}</span>
            </span>
            <span className="te-mode-hint">{modeHint(mode)}</span>
            <span className="te-mode-facets">
              {pattern ? <span className="te-facet pattern">{pattern}</span> : null}
              {MODE_FACETS[mode].map((facet) => <span key={facet} className="te-facet">{t(`editor.facet.${facet}`)}</span>)}
            </span>
          </button>
        );
      })}
    </div>
  );
}


function RoleCard({ role, index, onChange, onDuplicate, onRemove }: { role: RoleDraft; index: number; onChange(role: RoleDraft, group: string): void; onDuplicate(): void; onRemove(): void }) {
  const field = `roles.${index}`;
  const nameIssues = useIssues(`${field}.name`);
  const folderIssues = useIssues(`${field}.folders`);
  const tone = ROLE_TONES[index % ROLE_TONES.length]!;
  return (
    <article className="te-card" data-field={field} style={{ "--tone": tone } as CSSProperties}>
      <div className="te-card-head">
        <AgentAvatar agent={role.agent ?? "unknown"} model={role.model} size={32} className="te-avatar" title={runtimeLabel(role)} />
        <div className="grow" data-field={`${field}.name`}>
          <input className={`te-card-name${hasError(nameIssues) ? " invalid" : ""}`} value={role.name} placeholder={t("editor.role.namePlaceholder")} aria-label={t("editor.role.name")} spellCheck={false} onChange={(event) => onChange({ ...role, name: event.target.value }, `${field}.name`)} />
        </div>
        <div className="te-card-tools">
          <Tool icon="copy" label={t("editor.role.duplicate")} onClick={onDuplicate} />
          <Tool icon="trash" label={t("editor.role.remove")} tone="danger" onClick={onRemove} />
        </div>
      </div>
      <FieldIssues field={`${field}.name`} />
      <RuntimeEditor runtime={role} field={field} onChange={(runtime, group) => onChange({ ...role, ...cleanRuntime(runtime) }, group)} />
      <Slot field={`${field}.folders`} label={t("editor.role.folders")} hint={t("editor.role.foldersHint")}>
        <FolderChips folders={role.folders} invalid={hasError(folderIssues)} onChange={(folders) => onChange({ ...role, folders }, `${field}.folders`)} />
      </Slot>
      <Slot field={`${field}.instructions`} label={t("editor.role.instructions")}>
        <GrowText value={role.instructions} rows={3} placeholder={t("editor.role.instructionsPlaceholder")} onChange={(instructions) => onChange({ ...role, instructions }, `${field}.instructions`)} />
      </Slot>
    </article>
  );
}

function CandidateCard({ candidate, index, onChange, onDuplicate, onRemove, onTemplate }: { candidate: CandidateDraft; index: number; onChange(candidate: CandidateDraft, group: string): void; onDuplicate(): void; onRemove(): void; onTemplate(): void }) {
  const field = `candidates.${index}`;
  const nameIssues = useIssues(`${field}.name`);
  const handle = candidateHandle(candidate);
  return (
    <article className="te-card cand" data-field={field}>
      <div className="te-card-head">
        <AgentAvatar agent={candidate.agent ?? "unknown"} model={candidate.model} size={32} className="te-avatar cand" title={runtimeLabel(candidate)} />
        <div className="grow te-handle" data-field={`${field}.name`}>
          <span className="te-at" aria-hidden>@</span>
          <input className={`te-card-name${hasError(nameIssues) ? " invalid" : ""}`} value={candidate.name} placeholder={handle} aria-label={t("editor.candidate.handle")} title={t("editor.candidate.handleHint", { handle })} spellCheck={false} onChange={(event) => onChange({ ...candidate, name: event.target.value }, `${field}.name`)} />
        </div>
        <div className="te-card-tools">
          <Tool icon="copy" label={t("editor.candidate.duplicate")} onClick={onDuplicate} />
          <Tool icon="trash" label={t("editor.candidate.remove")} tone="danger" onClick={onRemove} />
        </div>
      </div>
      <FieldIssues field={`${field}.name`} />
      <RuntimeEditor runtime={candidate} field={field} onChange={(runtime, group) => onChange({ ...candidate, ...cleanRuntime(runtime) }, group)} />
      <Slot
        field={`${field}.notes`}
        label={t("editor.candidate.notes")}
        aside={!candidate.notes.trim() ? <button type="button" className="te-link" onClick={onTemplate}><Icon name="sparkles" size={12} />{t("editor.candidate.useTemplate")}</button> : null}
      >
        <GrowText value={candidate.notes} rows={3} placeholder={t("editor.candidate.template")} onChange={(notes) => onChange({ ...candidate, notes }, `${field}.notes`)} />
      </Slot>
    </article>
  );
}

function EmptyBlock({ icon, text, action, field }: { icon: string; text: string; action: ReactNode; field?: string }) {
  return (
    <div className="te-empty" data-field={field}>
      <span className="te-empty-icon"><Icon name={icon} size={18} /></span>
      <span className="te-empty-text">{text}</span>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The editor

export function Editor({ session }: { session: DocSession }) {
  const first = session.value;
  const [broken, setBroken] = useState<BrokenDraft | null>(first.kind === "broken" ? first : null);
  const [readOnly, setReadOnly] = useState(session.readOnly);
  const history = useHistory<TeamDraft>(first.kind === "team" ? first.team : blankDraft());
  const team = history.value;
  const check = useMemo(() => checkDraft(team), [team]);
  const toasts = useToasts();
  const push = toasts.push;
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<SectionId>("overview");

  const issuesByField = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of check.issues) map.set(issue.field, [...(map.get(issue.field) ?? []), issue]);
    return map;
  }, [check]);
  const issuesFor = useCallback((field: string) => issuesByField.get(field) ?? [], [issuesByField]);

  const { edit, current, reset } = history;
  const undoStep = history.undo;
  const redoStep = history.redo;
  const send = useCallback((next: TeamDraft) => session.change({ kind: "team", team: next }), [session]);
  const apply = useCallback((patch: Patch, group?: string) => {
    if (session.readOnly) return;
    const next = patch(current());
    edit(next, group);
    send(next);
  }, [current, edit, send, session]);
  const undo = useCallback(() => {
    if (session.readOnly) return;
    const value = undoStep();
    if (value) send(value);
  }, [undoStep, send, session]);
  const redo = useCallback(() => {
    if (session.readOnly) return;
    const value = redoStep();
    if (value) send(value);
  }, [redoStep, send, session]);

  // The file changed outside the editor (or a conflict was merged): show what the session holds now.
  useEffect(() => {
    const subscription = session.onReplace((next) => {
      setReadOnly(session.readOnly);
      if (next.kind === "broken") {
        setBroken(next);
      } else {
        setBroken(null);
        reset(next.team);
      }
      push({ text: t("editor.replaced"), tone: "info" });
    });
    return () => subscription.dispose();
  }, [session, reset, push]);

  // Saves the file now: the same flush Orca runs on ⌘S, and the button next to undo/redo.
  const save = useCallback(() => {
    void session.flush().then(() => push({ text: t("editor.saved"), tone: "ok" }), (reason: unknown) => push({ text: t("editor.saveFailed", { error: String((reason as Error)?.message ?? reason) }), tone: "bad" }));
  }, [session, push]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      // The start dialog's request box keeps its own native undo.
      if ((event.target as Element | null)?.closest?.(".te-modal")) return;
      const key = event.key.toLowerCase();
      if (key === "s" || event.code === "KeyS") {
        event.preventDefault();
        save();
      } else if (key === "z" || event.code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y" && event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, save]);

  // The section in view, for the side navigation.
  useEffect(() => {
    const onScroll = () => {
      let current: SectionId = "overview";
      for (const section of SECTIONS) {
        const node = document.getElementById(`te-${section.id}`);
        if (node && node.getBoundingClientRect().top < 140) current = section.id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1]!.id;
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [broken]);

  // After React has rendered the new card.
  const focusLater = (field: string, select = false) => setTimeout(() => {
    jumpTo(field);
    if (select) (document.activeElement as HTMLInputElement | null)?.select?.();
  }, 30);

  if (broken) {
    return (
      <>
        <BrokenView
          broken={broken}
          readOnly={readOnly}
          onSalvage={broken.salvage ? () => { history.reset(broken.salvage!); setBroken(null); } : undefined}
          onBlank={() => {
            const blank = blankDraft(broken.salvage?.name ?? "");
            history.reset(blank);
            send(blank);
            setBroken(null);
            toasts.push({ text: t("editor.broken.blankDone"), tone: "info" });
          }}
        />
        <Toasts list={toasts.list} dismiss={toasts.dismiss} />
      </>
    );
  }

  // Edits
  const setRole = (index: number, role: RoleDraft, group: string) => apply((draft) => ({ ...draft, roles: draft.roles.map((entry, at) => (at === index ? role : entry)) }), group);
  const setCandidate = (index: number, candidate: CandidateDraft, group: string) => apply((draft) => ({ ...draft, candidates: draft.candidates.map((entry, at) => (at === index ? candidate : entry)) }), group);
  const addRole = () => {
    const index = team.roles.length;
    apply((draft) => ({ ...draft, roles: [...draft.roles, newRole(draft)] }));
    focusLater(`roles.${index}.name`, true);
  };
  const duplicateRole = (index: number) => {
    apply((draft) => {
      const source = draft.roles[index]!;
      const copy = { ...structuredClone(source), name: uniqueName(source.name.trim() || "role", takenNames(draft)) };
      return { ...draft, roles: [...draft.roles.slice(0, index + 1), copy, ...draft.roles.slice(index + 1)] };
    });
    focusLater(`roles.${index + 1}.name`, true);
  };
  const removeRole = (index: number) => {
    const name = team.roles[index]?.name.trim() || t("editor.where.role", { n: index + 1 });
    apply((draft) => ({ ...draft, roles: draft.roles.filter((_, at) => at !== index) }));
    const after = history.current();
    toasts.push({ text: t("editor.role.removed", { name }), action: { label: t("editor.undo"), run: () => history.current() === after && undo() } });
  };
  const addCandidate = () => {
    const index = team.candidates.length;
    apply((draft) => ({ ...draft, candidates: [...draft.candidates, newCandidate(draft)] }));
    focusLater(`candidates.${index}.name`);
  };
  const duplicateCandidate = (index: number) => {
    apply((draft) => {
      const source = draft.candidates[index]!;
      const copy = { ...structuredClone(source), name: source.name.trim() ? uniqueName(source.name.trim(), takenNames(draft)) : "" };
      return { ...draft, candidates: [...draft.candidates.slice(0, index + 1), copy, ...draft.candidates.slice(index + 1)] };
    });
    focusLater(`candidates.${index + 1}.name`);
  };
  const removeCandidate = (index: number) => {
    const name = team.candidates[index] ? team.candidates[index]!.name.trim() || candidateHandle(team.candidates[index]!) : "";
    apply((draft) => ({ ...draft, candidates: draft.candidates.filter((_, at) => at !== index) }));
    const after = history.current();
    toasts.push({ text: t("editor.candidate.removed", { name }), action: { label: t("editor.undo"), run: () => history.current() === after && undo() } });
  };
  const fillTemplate = (index: number) => {
    const template = t("editor.candidate.template");
    apply((draft) => ({ ...draft, candidates: draft.candidates.map((entry, at) => (at === index ? { ...entry, notes: template } : entry)) }));
    setTimeout(() => {
      const area = document.querySelector<HTMLTextAreaElement>(`[data-field="candidates.${index}.notes"] textarea`);
      if (!area) return;
      area.focus();
      const at = template.indexOf("…");
      if (at >= 0) area.setSelectionRange(at, at + 1);
    }, 30);
  };

  const savePreset = async () => {
    if (!check.team) return;
    setSaving(true);
    try {
      const { preset: _origin, ...plain } = check.team;
      const result = await call("savePreset", { preset: { team: plain } });
      if (result.ok) toasts.push({ text: t("editor.presetSaved", { name: plain.name.trim() || t("editor.untitled") }), tone: "ok" });
      else toasts.push({ text: t("editor.presetFailed", { error: result.errors.join("; ") }), tone: "bad" });
    } catch (error) {
      toasts.push({ text: t("editor.presetFailed", { error: (error as Error).message ?? String(error) }), tone: "bad" });
    } finally {
      setSaving(false);
    }
  };

  const sectionErrors = (id: SectionId) => check.issues.filter((issue) => issue.level === "error" && sectionOf(issue.field) === id).length;
  const title = team.name.trim() || t("editor.untitled");
  const language: LanguageChoice = team.language ?? "auto";

  return (
    <IssuesContext.Provider value={issuesFor}>
      <div className="te-page">
        <header className="te-bar">
          <div className="te-bar-in">
            <div className="te-crumb">
              <span className="te-logo"><Icon name="users" size={14} /></span>
              <span className="te-crumb-kind">{t("editor.kind")}</span>
              <Icon name="right" size={12} style={{ opacity: 0.5 }} />
              <span className="te-crumb-name">{title}</span>
              {readOnly ? <span className="te-ro"><Icon name="lock" size={11} />{t("editor.readOnlyBadge")}</span> : null}
            </div>
            <div className="te-bar-actions">
              <div className="te-undo">
                <button type="button" className="te-tool" disabled={!history.canUndo || readOnly} title={t("editor.undoKey")} aria-label={t("editor.undo")} onClick={undo}><Icon name="undo" size={14} /></button>
                <button type="button" className="te-tool" disabled={!history.canRedo || readOnly} title={t("editor.redoKey")} aria-label={t("editor.redo")} onClick={redo}><Icon name="redo" size={14} /></button>
              </div>
              <Button icon="save" onClick={save} disabled={readOnly} title={t("editor.saveKey")}>{t("editor.save")}</Button>
              <Status check={check} team={team} onJump={jumpTo} />
              <Button icon="star" onClick={savePreset} disabled={!check.team || saving} title={check.team ? t("editor.savePresetHint") : t("editor.fixFirst")}>
                <span className="te-hide-sm">{t("editor.savePreset")}</span>
              </Button>
              <Button variant="primary" icon="play" onClick={() => setStarting(true)}>
                {t("editor.start")}
              </Button>
            </div>
          </div>
        </header>

        {readOnly ? (
          <div className="te-banner"><Icon name="lock" size={14} />{t("editor.readOnly")}</div>
        ) : null}

        <div className="te-layout">
          <nav className="te-nav" aria-label={t("editor.nav.label")}>
            {SECTIONS.map((section) => {
              const errors = sectionErrors(section.id);
              const count = section.id === "roles" ? team.roles.length : section.id === "candidates" ? team.candidates.length : null;
              return (
                <button key={section.id} type="button" className={active === section.id ? "on" : ""} onClick={() => document.getElementById(`te-${section.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  <Icon name={section.icon} size={14} />
                  <span className="grow">{t(`editor.nav.${section.id}`)}</span>
                  {errors ? <span className="te-nav-bad">{errors}</span> : count !== null ? <span className="te-nav-count">{count}</span> : null}
                </button>
              );
            })}
            <div className="te-nav-foot">
              <span className="kbd">⌘Z</span> {t("editor.undo")} · <span className="kbd">⌘S</span> {t("editor.save")}
            </div>
          </nav>

          <main className="te-main">
            <fieldset className="te-fieldset" disabled={readOnly}>
              <section className="te-hero" id="te-overview">
                <div data-field="name">
                  <input className="te-name" value={team.name} placeholder={t("editor.namePlaceholder")} aria-label={t("editor.namePlaceholder")} spellCheck={false} onChange={(event) => apply((draft) => ({ ...draft, name: event.target.value }), "name")} />
                </div>
                <div data-field="goal">
                  <GrowText className="te-goal" rows={1} value={team.goal} placeholder={t("editor.goalPlaceholder")} onChange={(goal) => apply((draft) => ({ ...draft, goal }), "goal")} />
                </div>
                <div className="te-facts">
                  <span className="te-fact"><Icon name={MODE_ICON[team.mode]} size={13} />{t(`mode.${team.mode}`)}</span>
                  <span className="te-fact"><Icon name="crown" size={13} /><span className="mono">{runtimeLabel({ agent: team.lead.agent || "?", model: team.lead.model, effort: team.lead.effort })}</span></span>
                  <span className="te-fact"><Icon name="users" size={13} />{t("editor.roleCount", { count: team.roles.length })}</span>
                  <span className="te-fact"><Icon name="boxes" size={13} />{t("editor.candidateCount", { count: team.candidates.length })}</span>
                  {team.language ? <span className="te-fact"><Icon name="languages" size={13} />{team.language === "zh" ? "中文" : "English"}</span> : null}
                  {team.preset ? <span className="te-fact"><Icon name="star" size={13} />{t("editor.fromPreset", { name: team.preset.name })}</span> : null}
                </div>
              </section>

              <Section id="collab" icon="layers" tone="var(--c-split)" title={t("editor.section.collab")} hint={t("editor.section.collabHint")}>
                <ModeCards value={team.mode} onChange={(mode) => apply((draft) => ({ ...draft, mode }))} />
                <FieldIssues field="mode" />
                <div className="te-lang" data-field="language">
                  <div className="grow">
                    <div className="te-label-strong"><Icon name="languages" size={14} />{t("editor.section.language")}</div>
                    <div className="te-hint">{t("editor.section.languageHint")}</div>
                  </div>
                  <Segmented<LanguageChoice> value={language} options={languageOptions()} onChange={(value) => apply((draft) => ({ ...draft, language: value === "auto" ? undefined : value }))} />
                </div>
              </Section>

              <Section id="lead" icon="crown" tone="var(--c-plans)" title={t("editor.section.lead")} hint={t("editor.section.leadHint")}>
                <div className="te-card te-lead" data-field="lead">
                  <RuntimeEditor runtime={team.lead} field="lead" onChange={(runtime: RuntimeDraft, group) => apply((draft) => ({ ...draft, lead: { ...draft.lead, ...cleanRuntime(runtime) } }), group)} />
                </div>
              </Section>

              <Section
                id="roles"
                icon="users"
                tone="var(--c-tasks)"
                title={t("editor.section.roles")}
                count={team.roles.length}
                hint={t("editor.section.rolesHint")}
                actions={team.roles.length ? <Button icon="plus" size="sm" onClick={addRole}>{t("editor.role.add")}</Button> : null}
              >
                <FieldIssues field="roles" />
                {team.roles.length ? (
                  <>
                    <div className="te-grid">
                      {team.roles.map((role, index) => (
                        <RoleCard key={index} role={role} index={index} onChange={(next, group) => setRole(index, next, group)} onDuplicate={() => duplicateRole(index)} onRemove={() => removeRole(index)} />
                      ))}
                    </div>
                    <button type="button" className="te-add-card" onClick={addRole}><Icon name="plus" size={15} />{t("editor.role.add")}</button>
                  </>
                ) : (
                  <EmptyBlock field="roles" icon="users" text={t("editor.role.empty")} action={<Button icon="plus" size="sm" onClick={addRole}>{t("editor.role.add")}</Button>} />
                )}
              </Section>

              <Section
                id="candidates"
                icon="boxes"
                tone="var(--c-board)"
                title={t("editor.section.candidates")}
                count={team.candidates.length}
                hint={t("editor.section.candidatesHint")}
                actions={team.candidates.length ? <Button icon="plus" size="sm" onClick={addCandidate}>{t("editor.candidate.add")}</Button> : null}
              >
                <FieldIssues field="candidates" />
                {team.candidates.length ? (
                  <>
                    <div className="te-grid">
                      {team.candidates.map((candidate, index) => (
                        <CandidateCard key={index} candidate={candidate} index={index} onChange={(next, group) => setCandidate(index, next, group)} onDuplicate={() => duplicateCandidate(index)} onRemove={() => removeCandidate(index)} onTemplate={() => fillTemplate(index)} />
                      ))}
                    </div>
                    <button type="button" className="te-add-card" onClick={addCandidate}><Icon name="plus" size={15} />{t("editor.candidate.add")}</button>
                  </>
                ) : (
                  <EmptyBlock icon="boxes" text={t("editor.candidate.empty")} action={<Button icon="plus" size="sm" onClick={addCandidate}>{t("editor.candidate.add")}</Button>} />
                )}
              </Section>
            </fieldset>
            <footer className="te-foot">{t("editor.footer")}</footer>
          </main>
        </div>

        {starting ? (
          <StartModal
            team={team}
            check={check}
            onClose={() => setStarting(false)}
            onStarted={(path) => {
              setStarting(false);
              toasts.push({ text: t("editor.startModal.started", { path }), tone: "ok" });
            }}
          />
        ) : null}
        <Toasts list={toasts.list} dismiss={toasts.dismiss} />
      </div>
    </IssuesContext.Provider>
  );
}
