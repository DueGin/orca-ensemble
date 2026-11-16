// Inputs the team editor is built from: a combobox with suggestions, a runtime editor (agent, model, effort), folder
// chips, an auto-growing textarea, and the per-field problem messages.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PromptLanguage } from "../../shared/modes";
import { EFFORTS, KNOWN_AGENTS, MODEL_SUGGESTIONS } from "../../shared/team";
import { t } from "../i18n";
import { Icon } from "../kit";
import type { RuntimeDraft } from "./draft";
import type { Issue } from "./validate";

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

/** A text input with a list of suggestions; any text is allowed. */
export function Combo({ value, onChange, suggestions, placeholder, invalid, label, mono }: { value: string; onChange(value: string): void; suggestions: readonly string[]; placeholder?: string; invalid?: boolean; label: string; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const query = value.trim().toLowerCase();
  const items = useMemo(() => {
    if (!query || suggestions.some((item) => item.toLowerCase() === query)) return [...suggestions];
    return suggestions.filter((item) => item.toLowerCase().includes(query));
  }, [query, suggestions]);
  const shown = open && items.length > 0;

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
      pick(items[active]!);
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
      {suggestions.length ? (
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
          {items.map((item, index) => (
            <li key={item} role="option" aria-selected={item.toLowerCase() === query} className={`${index === active ? "active" : ""}${item.toLowerCase() === query ? " on" : ""}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(item)}>
              <span className="mono">{item}</span>
              {item.toLowerCase() === query ? <Icon name="check" size={12} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The agent CLI, model and effort an agent runs on. */
export function RuntimeEditor({ runtime, field, onChange }: { runtime: RuntimeDraft; field: string; onChange(runtime: RuntimeDraft, group: string): void }) {
  const models = MODEL_SUGGESTIONS[runtime.agent.trim()] ?? [];
  const agentIssues = useIssues(`${field}.agent`);
  const effort = runtime.effort ?? "";
  const efforts: string[] = effort && !(EFFORTS as readonly string[]).includes(effort) ? [...EFFORTS, effort] : [...EFFORTS];
  return (
    <div className="te-runtime">
      <Slot field={`${field}.agent`} label={t("editor.runtime.agent")}>
        <Combo label={t("editor.runtime.agent")} value={runtime.agent} suggestions={KNOWN_AGENTS} placeholder="claude" invalid={hasError(agentIssues)} mono onChange={(agent) => onChange({ ...runtime, agent }, `${field}.agent`)} />
      </Slot>
      <Slot field={`${field}.model`} label={t("editor.runtime.model")}>
        <Combo label={t("editor.runtime.model")} value={runtime.model ?? ""} suggestions={models} placeholder={t("editor.runtime.modelDefault")} mono onChange={(model) => onChange({ ...runtime, model: model || undefined }, `${field}.model`)} />
      </Slot>
      <Slot field={`${field}.effort`} label={t("editor.runtime.effort")}>
        <Select value={effort} label={t("editor.runtime.effort")} onChange={(value) => onChange({ ...runtime, effort: value || undefined }, `${field}.effort`)} options={[{ value: "", label: t("editor.runtime.effortDefault") }, ...efforts.map((item) => ({ value: item, label: item }))]} />
      </Slot>
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
