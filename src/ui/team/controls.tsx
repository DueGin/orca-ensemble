// Inputs the team editor is built from: a combobox with suggestions, a runtime editor (agent, model, effort), folder
// chips, an auto-growing textarea, and the per-field problem messages.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { CHAT_OFFERED, surfaceOf, type Surface } from "../../shared/agents";
import type { PromptLanguage } from "../../shared/modes";
import { EFFORTS, KNOWN_AGENTS, MODEL_SUGGESTIONS } from "../../shared/team";
import { t } from "../i18n";
import { Icon, Segmented } from "../kit";
import { call } from "../orca";
import type { RuntimeDraft } from "./draft";
import type { Issue } from "./validate";
import type { ModelChoices } from "../../worker/model-choices";

/** The problems per field, for every input below the editor. */
export const IssuesContext = createContext<(field: string) => Issue[]>(() => []);

export function useIssues(field: string): Issue[] {
  return useContext(IssuesContext)(field);
}

export const hasError = (issues: Issue[]) => issues.some((issue) => issue.level === "error");

export function FieldIssues({ field, only }: { field: string; only?: Issue["level"] }) {
  const issues = useIssues(field).filter((issue) => !only || issue.level === only);
  if (!issues.length) return null;
  return (
    <div className="te-issues">
      {issues.map((issue, index) => (
        <div key={index} className={`te-issue ${issue.level}`}>
          <Icon name={issue.level === "error" ? "alert" : "info"} size={12} />
          <span>{issue.message}</span>
        </div>
      ))}
    </div>
  );
}

/** A labelled field that the problem list can jump to. */
export function Slot({ field, label, hint, aside, children, className }: { field?: string; label?: ReactNode; hint?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`te-slot${className ? ` ${className}` : ""}`} data-field={field}>
      {label || aside ? (
        <div className="te-slot-head">
          {label ? <span className="te-label">{label}</span> : null}
          {aside ? <span className="te-slot-aside">{aside}</span> : null}
        </div>
      ) : null}
      {children}
      {field ? <FieldIssues field={field} /> : null}
      {hint ? <div className="te-hint">{hint}</div> : null}
    </div>
  );
}

/** A textarea that grows with its text. */
export function GrowText({ value, onChange, placeholder, rows = 3, className, invalid, max = 520 }: { value: string; onChange(value: string): void; placeholder?: string; rows?: number; className?: string; invalid?: boolean; max?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight + 2, max)}px`;
  }, [value, max]);
  return <textarea ref={ref} className={["te-textarea", className, invalid ? "invalid" : ""].filter(Boolean).join(" ")} rows={rows} value={value} placeholder={placeholder} spellCheck={false} onChange={(event) => onChange(event.target.value)} />;
}

/** A suggestion: its value, and a label shown beside it when that says more (a model's name beside its id). */
export type ComboItem = string | { value: string; label?: string };

/**
 * A text input with a list of suggestions; any text is allowed. `onOpen` runs each time the list opens (to fetch it),
 * `loading` shows it is coming, and `note` says where the list comes from.
 */
export function Combo({ value, onChange, suggestions, placeholder, invalid, label, mono, loading, note, onOpen }: { value: string; onChange(value: string): void; suggestions: readonly ComboItem[]; placeholder?: string; invalid?: boolean; label: string; mono?: boolean; loading?: boolean; note?: string; onOpen?(): void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);
  const query = value.trim().toLowerCase();
  const options = useMemo(() => suggestions.map((item) => (typeof item === "string" ? { value: item, label: item } : { value: item.value, label: item.label?.trim() || item.value })), [suggestions]);
  const items = useMemo(() => {
    if (!query || options.some((item) => item.value.toLowerCase() === query)) return options;
    return options.filter((item) => item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query));
  }, [query, options]);
  const shown = open && (items.length > 0 || !!loading || !!note);

  useEffect(() => {
    if (!shown || active < 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, shown]);

  const pick = (item: string) => {
    onChange(item);
    setOpen(false);
    setActive(-1);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (items.length ? (index + step + items.length) % items.length : -1));
    } else if (event.key === "Enter" && shown && active >= 0 && items[active]) {
      event.preventDefault();
      pick(items[active]!.value);
    } else if (event.key === "Escape" && shown) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className={`te-combo${shown ? " open" : ""}`}>
      <input
        className={`te-input${mono ? " mono" : ""}${invalid ? " invalid" : ""}`}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {suggestions.length || onOpen ? (
        <button type="button" className="te-combo-toggle" tabIndex={-1} aria-label={label} onMouseDown={(event) => event.preventDefault()} onClick={(event) => {
          const input = event.currentTarget.previousElementSibling as HTMLInputElement | null;
          const focused = document.activeElement === input;
          input?.focus();
          if (focused) setOpen((was) => !was);
          else setOpen(true);
        }}>
          <Icon name="down" size={12} />
        </button>
      ) : null}
      {shown ? (
        <ul className="te-combo-list" id={listId} role="listbox" ref={listRef}>
          {items.map((item, index) => {
            const on = item.value.toLowerCase() === query;
            return (
              <li key={item.value} role="option" aria-selected={on} title={item.label !== item.value ? `${item.value} · ${item.label}` : item.value} className={`${index === active ? "active" : ""}${on ? " on" : ""}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(item.value)}>
                <span className="te-combo-item">
                  <span className="mono">{item.value}</span>
                  {item.label !== item.value ? <span className="te-combo-label">{item.label}</span> : null}
                </span>
                {on ? <Icon name="check" size={12} /> : null}
              </li>
            );
          })}
          {loading || note ? (
            <li className="te-combo-note" role="presentation" aria-live="polite" onMouseDown={(event) => event.preventDefault()}>
              {loading ? <span className="te-combo-spin" aria-hidden /> : null}
              <span>{note}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

// ----- Each agent's models, from Orca's own lists

/** An agent's models as the editor knows them: `asked` once Orca was asked to list them, `loading` while it does. */
type ModelEntry = { choices: ModelChoices | null; loading: boolean; asked: boolean };
const modelEntries = new Map<string, ModelEntry>();
const modelListeners = new Set<() => void>();
let modelVersion = 0;

function setModelEntry(agent: string, entry: ModelEntry) {
  modelEntries.set(agent, entry);
  modelVersion += 1;
  for (const listener of modelListeners) listener();
}

const builtinChoices = (agent: string): ModelChoices => ({ source: "builtin", models: (MODEL_SUGGESTIONS[agent] ?? []).map((id) => ({ id, label: id, isDefault: false, efforts: null })), listing: false });

/** Reads the models Orca has saved for the agent, once per editor: this starts nothing in Orca. */
function loadModels(agent: string) {
  if (modelEntries.has(agent)) return;
  setModelEntry(agent, { choices: null, loading: false, asked: false });
  call("agentModels", { agent }).then(
    (choices) => setModelEntry(agent, { ...modelEntries.get(agent)!, choices }),
    () => setModelEntry(agent, { ...modelEntries.get(agent)!, choices: builtinChoices(agent) }),
  );
}

/**
 * When the list opens and Orca has no list for the agent yet (or is still listing it), asks Orca to list its models, as
 * Orca's own model picker does when opened; once per agent per editor.
 */
function askForModels(agent: string) {
  const entry = modelEntries.get(agent);
  if (!entry || entry.asked || (entry.choices?.source === "orca" && !entry.choices.listing)) return;
  setModelEntry(agent, { ...entry, asked: true, loading: true });
  call("agentModels", { agent, wait: true }, 70_000).then(
    (choices) => setModelEntry(agent, { choices, loading: false, asked: true }),
    () => setModelEntry(agent, { ...modelEntries.get(agent)!, loading: false }),
  );
}

function useModelChoices(agent: string): ModelEntry & { ask(): void } {
  const name = agent.trim();
  useSyncExternalStore(
    (listener) => {
      modelListeners.add(listener);
      return () => modelListeners.delete(listener);
    },
    () => modelVersion,
  );
  useEffect(() => {
    if (name) loadModels(name);
  }, [name]);
  const entry = (name && modelEntries.get(name)) || { choices: null, loading: false, asked: false };
  return { ...entry, ask: () => name && askForModels(name) };
}

/** What the model list says about where it came from. */
function modelNote(agent: string, entry: ModelEntry): string {
  const name = agent.trim() || "?";
  if (entry.loading) return t("editor.runtime.modelsAsking", { agent: name });
  const choices = entry.choices;
  if (!choices) return "";
  if (choices.source === "orca") return t(choices.listing ? "editor.runtime.modelsOrcaListing" : "editor.runtime.modelsOrca", { count: choices.models.length });
  if (choices.source === "cli") return t("editor.runtime.modelsCli", { agent: name });
  return t(entry.asked ? "editor.runtime.modelsNone" : "editor.runtime.modelsSuggested", { agent: name });
}

/** The agent CLI, model and effort an agent runs on, and for an agent Orca can open as a chat, chat or terminal. */
export function RuntimeEditor({ runtime, field, onChange }: { runtime: RuntimeDraft; field: string; onChange(runtime: RuntimeDraft, group: string): void }) {
  const models = useModelChoices(runtime.agent);
  const agentIssues = useIssues(`${field}.agent`);
  const effort = runtime.effort ?? "";
  // The efforts Orca lists for the chosen model (or the agent's default model); the usual ones when it lists none.
  const listed = models.choices?.models ?? [];
  const chosen = runtime.model?.trim() ? listed.find((model) => model.id === runtime.model!.trim()) : listed.find((model) => model.isDefault);
  const known: readonly string[] = chosen?.efforts ?? EFFORTS;
  const efforts: string[] = effort && !known.includes(effort) ? [...known, effort] : [...known];
  return (
    <div className="te-runtime">
      <Slot field={`${field}.agent`} label={t("editor.runtime.agent")}>
        <Combo label={t("editor.runtime.agent")} value={runtime.agent} suggestions={KNOWN_AGENTS} placeholder="claude" invalid={hasError(agentIssues)} mono onChange={(agent) => onChange({ ...runtime, agent }, `${field}.agent`)} />
      </Slot>
      <Slot field={`${field}.model`} label={t("editor.runtime.model")}>
        <Combo
          label={t("editor.runtime.model")}
          value={runtime.model ?? ""}
          suggestions={listed.map((model) => ({ value: model.id, label: model.label }))}
          loading={models.loading}
          note={modelNote(runtime.agent, models)}
          onOpen={models.ask}
          placeholder={t("editor.runtime.modelDefault")}
          mono
          onChange={(model) => onChange({ ...runtime, model: model || undefined }, `${field}.model`)}
        />
      </Slot>
      <Slot field={`${field}.effort`} label={t("editor.runtime.effort")}>
        <Select value={effort} label={t("editor.runtime.effort")} onChange={(value) => onChange({ ...runtime, effort: value || undefined }, `${field}.effort`)} options={[{ value: "", label: t("editor.runtime.effortDefault") }, ...efforts.map((item) => ({ value: item, label: item }))]} />
      </Slot>
      {CHAT_OFFERED.has(runtime.agent.trim()) ? (
        <div className="te-surface" data-field={`${field}.surface`}>
          <span className="te-surface-label">{t("editor.runtime.surface")}</span>
          <Segmented<Surface>
            value={surfaceOf(runtime)}
            options={[
              { value: "chat", label: t("editor.runtime.chat"), title: t("editor.runtime.chatHint") },
              { value: "terminal", label: t("editor.runtime.terminal"), title: t("editor.runtime.terminalHint") },
            ]}
            onChange={(surface) => onChange({ ...runtime, surface }, `${field}.surface`)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A native select with the editor's chevron. */
export function Select({ value, onChange, options, label }: { value: string; onChange(value: string): void; options: { value: string; label: string }[]; label: string }) {
  return (
    <div className="te-select-wrap">
      <select className="te-select" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <Icon name="down" size={12} />
    </div>
  );
}

/** Folders as removable chips, with an input that adds on Enter or a comma. */
export function FolderChips({ folders, onChange, invalid }: { folders: string[]; onChange(folders: string[]): void; invalid?: boolean }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[,，\n]/).map((part) => part.trim()).filter(Boolean);
    const next = [...folders];
    for (const part of parts) if (!next.includes(part)) next.push(part);
    if (next.length !== folders.length) onChange(next);
    setText("");
  };
  return (
    <div className={`te-chips${invalid ? " invalid" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}>
      {folders.map((folder, index) => (
        <span key={`${folder}-${index}`} className={`te-chip${folder.trim() ? "" : " empty"}`}>
          <Icon name="folder" size={12} />
          <span className="mono">{folder || "?"}</span>
          <button type="button" aria-label={t("editor.role.removeFolder", { folder })} title={t("editor.role.removeFolder", { folder })} onClick={() => onChange(folders.filter((_, at) => at !== index))}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="te-chip-input mono"
        value={text}
        placeholder={folders.length ? t("editor.role.folderMore") : t("editor.role.folderPlaceholder")}
        aria-label={t("editor.role.folders")}
        spellCheck={false}
        onChange={(event) => {
          const value = event.target.value;
          if (/[,，\n]/.test(value)) add(value);
          else setText(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add(text);
          } else if (event.key === "Backspace" && !text && folders.length) {
            onChange(folders.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && add(text)}
      />
    </div>
  );
}

export type LanguageChoice = "auto" | PromptLanguage;

/** The language choices: Orca's (unset), Chinese, English. */
export const languageOptions = (): { value: LanguageChoice; label: string }[] => [
  { value: "auto", label: t("editor.languageAuto") },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

/** Small icon button for card tools. */
export function Tool({ icon, label, onClick, tone }: { icon: string; label: string; onClick(): void; tone?: "danger" }) {
  return (
    <button type="button" className={`te-tool${tone ? ` ${tone}` : ""}`} title={label} aria-label={label} onClick={onClick}>
      <Icon name={icon} size={14} />
    </button>
  );
}
