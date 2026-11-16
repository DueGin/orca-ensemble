// Small building blocks shared by the panel, the team editor and the run report.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// Lucide icons (MIT), the few the plugin draws, as path data on a 24 grid.
const ICONS: Record<string, string> = {
  bot: "M12 8V4H8|M4 8h16v12H4z|M2 14h2|M20 14h2|M15 13v2|M9 13v2",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M22 21v-2a4 4 0 0 0-3-3.87|M16 3.13a4 4 0 0 1 0 7.75",
  play: "M6 3l14 9-14 9V3z",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18|M6 6l12 12",
  plus: "M12 5v14|M5 12h14",
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  down: "M6 9l6 6 6-6",
  up: "M18 15l-6-6-6 6",
  external: "M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  trash: "M3 6h18|M8 6V4h8v2|M19 6l-1 14H6L5 6",
  edit: "M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  lock: "M5 11h14v10H5z|M8 11V7a4 4 0 0 1 8 0v4",
  alert: "M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-15 6.7L3 16|M3 21v-5h5",
  terminal: "M4 17l6-6-6-6|M12 19h8",
  branch: "M6 3v12|M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 9a9 9 0 0 1-9 9",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6",
  "file-text": "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8",
  kanban: "M3 3h18v18H3z|M8 7v7|M12 7v4|M16 7v9",
  clipboard: "M9 2h6v4H9z|M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2|M9 14l2 2 4-4",
  messages: "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z|M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
  "file-lock": "M4 22V4a2 2 0 0 1 2-2h8l6 6v4|M14 2v6h6|M12 17h8v5h-8z|M14 17v-2a2 2 0 0 1 4 0v2",
  split: "M16 3h5v5|M8 3H3v5|M12 22v-8.3a4 4 0 0 0-1.17-2.83L3 3|M21 3l-7.83 7.83",
  boxes: "M7 13h10v8H7z|M2 3h9v8H2z|M13 3h9v8h-9z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2|M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  merge: "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 21V9a9 9 0 0 0 9 9",
  sparkles: "M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z",
  layers: "M12 2 2 7l10 5 10-5z|M2 17l10 5 10-5|M2 12l10 5 10-5",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 16v-4|M12 8h.01",
  save: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z|M17 21v-8H7v8|M7 3v5h8",
  copy: "M9 9h13v13H9z|M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1z",
  folder: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
  crown: "M2 4l3 12h14l3-12-6 7-4-7-4 7z|M5 20h14",
  zap: "M13 2 3 14h9l-1 8 10-12h-9z",
  undo: "M3 7v6h6|M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13",
  redo: "M21 7v6h-6|M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13",
  languages: "m5 8 6 6|m4 14 6-6 2-3|M2 5h12|M7 2h1|m22 22-5-10-5 10|M14 18h6",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 6v6l4 2",
  user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2|M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  plug: "M12 22v-5|M9 8V2|M15 8V2|M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z",
  hourglass: "M5 22h14|M5 2h14|M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22|M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2",
  "arrow-right": "M5 12h14|M12 5l7 7-7 7",
  "arrow-left": "M19 12H5|M12 19l-7-7 7-7",
  "check-circle": "M22 11.08V12a10 10 0 1 1-5.93-9.14|M22 4 12 14.01l-3-3",
  timer: "M10 2h4|M12 14l3-3|M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
  send: "M22 2 11 13|M22 2l-7 20-4-9-9-4z",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54z",
};

export function Icon({ name, size = 14, style }: { name: string; size?: number; style?: CSSProperties }) {
  const paths = (ICONS[name] ?? ICONS.info!).split("|");
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", ...style }} aria-hidden>
      {paths.map((d, index) => <path key={index} d={d} />)}
    </svg>
  );
}

export function Button({ children, icon, variant, size, onClick, disabled, title, block }: { children?: ReactNode; icon?: string; variant?: "primary" | "ghost" | "danger"; size?: "sm" | "lg"; onClick?: () => void; disabled?: boolean; title?: string; block?: boolean }) {
  return (
    <button type="button" className={["btn", variant, size, block ? "block" : "", !children ? "icon" : ""].filter(Boolean).join(" ")} onClick={onClick} disabled={disabled} title={title} aria-label={title}>
      {icon ? <Icon name={icon} size={size === "lg" ? 16 : 14} /> : null}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled, stretch }: { value: T; options: readonly { value: T; label: ReactNode; title?: string }[]; onChange(value: T): void; disabled?: boolean; stretch?: boolean }) {
  return (
    <div className={`seg${stretch ? " stretch" : ""}`} role="tablist">
      {options.map((option) => (
        <button key={option.value} type="button" role="tab" aria-selected={option.value === value} className={option.value === value ? "on" : ""} disabled={disabled} title={option.title} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ children, on, onClick, color, disabled, title }: { children: ReactNode; on?: boolean; onClick?: () => void; color?: string; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className={`chip${on ? " on" : ""}`} style={color ? ({ "--chip": color } as CSSProperties) : undefined} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className="badge" style={tone ? ({ "--tone": tone } as CSSProperties) : undefined}>{children}</span>;
}

export function Dot({ tone, live }: { tone?: string; live?: boolean }) {
  return <span className={`dot${live ? " live" : ""}`} style={tone ? ({ "--tone": tone } as CSSProperties) : undefined} />;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Empty({ children, icon }: { children: ReactNode; icon?: string }) {
  return (
    <div className="empty stack" style={{ alignItems: "center" }}>
      {icon ? <Icon name={icon} size={22} /> : null}
      <div>{children}</div>
    </div>
  );
}

/** A textarea that grows with its text. */
export function AutoText({ value, onChange, placeholder, rows = 3, readOnly }: { value: string; onChange(value: string): void; placeholder?: string; rows?: number; readOnly?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight + 2, 480)}px`;
  }, [value]);
  return <textarea ref={ref} className="textarea" rows={rows} value={value} placeholder={placeholder} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />;
}

/** The current time, refreshed every few seconds so "12s ago" stays current. */
export function useNow(intervalMs = 3000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Status colors. */
export const TONE = {
  working: "var(--warn)",
  done: "var(--ok)",
  attention: "var(--bad)",
  failed: "var(--bad)",
  idle: "var(--muted-fg)",
} as const;

/** The color of an agent's live state as Orca reports it. */
export function stateTone(state: string): string {
  if (state === "working") return TONE.working;
  if (state === "blocked" || state === "attention" || state === "failed") return TONE.attention;
  if (state === "done" || state === "waiting") return TONE.done;
  return TONE.idle;
}
