// What every run view shares: component names and icons, how a flow event reads, times and durations, the live summary
// of a component, and the small widgets (event rows, usage bars, history) each component page ends with.
import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { flowTotals, RUN_COMPONENTS, type RunComponent, type RunEvent } from "../../shared/flow";
import type { CollabMode } from "../../shared/modes";
import type { PendingBriefView, RunDetail, RunView } from "../../shared/views";
import { t } from "../i18n";
import { Icon, stateTone, TONE } from "../kit";

/** A page of a run: one component, or the whole data flow. */
export type ComponentPage = RunComponent | "flow";
export const COMPONENT_PAGES: readonly ComponentPage[] = [...RUN_COMPONENTS, "flow"];

/** A flow this recent is drawn moving. */
export const LIVE_MS = 30_000;

export const COMPONENT_ICON: Record<RunComponent, string> = {
  brief: "file-text",
  tasks: "kanban",
  plans: "clipboard",
  board: "messages",
  claims: "file-lock",
  split: "split",
  contexts: "boxes",
  reports: "inbox",
  summary: "merge",
};

export const pageIcon = (page: ComponentPage) => (page === "flow" ? "activity" : COMPONENT_ICON[page]);
export const componentColor = (component: RunComponent) => `var(--c-${component})`;
/** Inline style that sets the component color `--c` for the CSS. */
export const tint = (color: string): CSSProperties => ({ "--c": color }) as CSSProperties;

export type Member = { agentId: string; title: string };

export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t("flow.duration.seconds", { count: seconds });
  if (seconds < 600) return t("flow.duration.minutes", { count: Math.round(seconds / 6) / 10 });
  if (seconds < 3600) return t("flow.duration.minutes", { count: Math.round(seconds / 60) });
  return t("flow.duration.hours", { count: Math.round(seconds / 360) / 10 });
}

export function agoText(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 5) return t("flow.ago.now");
  if (seconds < 60) return t("flow.ago.seconds", { count: seconds });
  if (seconds < 3600) return t("flow.ago.minutes", { count: Math.round(seconds / 60) });
  if (seconds < 48 * 3600) return t("flow.ago.hours", { count: Math.round(seconds / 3600) });
  return t("report.daysAgo", { count: Math.round(seconds / 86400) });
}

/** A date and time short enough for a header: "Nov 16, 18:46". */
export function timeText(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const locale = window.orca?.locale || navigator.language;
  return date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function partyName(party: string, members: readonly Member[]): string {
  if (party === "lead") return t("flow.lead");
  if (party === "user") return t("flow.user");
  if (party === "plugin") return t("flow.plugin");
  return members.find((member) => member.agentId === party)?.title ?? party;
}

function eventKey(event: RunEvent): string {
  if (event.component === "brief" && event.action === "deliver") return "flow.event.briefDeliver";
  if (event.component === "plans" && event.action === "notify") return "flow.event.plansNotify";
  if (event.component === "claims" && event.action === "claim") return "flow.event.fileClaim";
  if (event.component === "claims" && event.action === "release") return "flow.event.fileRelease";
  if (event.component === "split" && event.action === "add") return "flow.event.packetAdd";
  if (event.component === "split" && event.action === "assign") return "flow.event.packetAssign";
  if (event.component === "summary" && event.action === "deliver") return "flow.event.summaryDeliver";
  return `flow.event.${event.action}`;
}

/** Events whose sentence already quotes the note. */
const NOTE_IN_TEXT = new Set(["warn", "start"]);

export function describeEvent(event: RunEvent, members: readonly Member[]): string {
  // A post addressed to its own author has nowhere else to go; a claim or a read names its own agent on purpose.
  const targets = event.action === "post" && event.to.length === 1 && event.to[0] === event.from ? [] : event.to;
  const to = targets.map((party) => partyName(party, members)).join(", ");
  return t(eventKey(event), { from: partyName(event.from, members), to: to || t("flow.lead"), subject: event.subject, note: event.note });
}

export const componentName = (component: RunComponent, mode: CollabMode) => (component === "tasks" && mode === "delegation" ? t("flow.delegationTasks") : t(`flow.component.${component}`));
export const pageName = (page: ComponentPage, mode: CollabMode) => (page === "flow" ? t("report.allFlows") : componentName(page, mode));
export const aboutText = (page: ComponentPage, mode: CollabMode) => (page === "flow" ? t("flow.hint") : page === "tasks" && mode === "delegation" ? t("flow.about.delegationTasks") : t(`flow.about.${page}`));

/** One line on how a component stands right now. */
export function summaryOf(component: RunComponent, run: RunView, pending: PendingBriefView | null): string {
  const count = (state: string) => run.tasks.filter((task) => task.state === state).length;
  switch (component) {
    case "brief":
      return run.brief ? t("flow.summary.briefConfirmed", { count: run.brief.acceptance.length }) : pending ? t("flow.summary.briefPending") : t("flow.summary.briefNone");
    case "tasks":
      return run.tasks.length ? t("flow.summary.tasks", { doing: count("doing"), todo: count("todo"), done: count("done") }) : t("flow.summary.tasksEmpty");
    case "plans": {
      const plans = run.tasks.filter((task) => task.plan);
      if (!run.planApproval && !plans.length) return t("flow.summary.plansOff");
      return t("flow.summary.plans", { pending: plans.filter((task) => task.plan === "pending").length, approved: plans.filter((task) => task.plan === "approved").length, rejected: plans.filter((task) => task.plan === "rejected").length });
    }
    case "board":
      return t("flow.summary.board", { count: run.postCount });
    case "claims":
      return run.claims.length ? t("flow.summary.claims", { count: run.claims.length }) : t("flow.summary.claimsNone");
    case "reports":
      return t("flow.summary.reports", { done: run.members.filter((member) => member.state === "done" || member.state === "failed").length, total: run.members.length });
    case "split": {
      const warnings = run.batches.reduce((sum, batch) => sum + batch.warnings, 0);
      const text = t("flow.summary.split", { batches: run.batches.length, packets: run.batches.reduce((sum, batch) => sum + batch.packets, 0) || run.tasks.length });
      return warnings ? `${text} · ${t("flow.summary.splitWarn", { count: warnings })}` : text;
    }
    case "contexts":
      return t("flow.summary.contexts", { count: run.members.length, working: run.members.filter((member) => member.state === "working" || member.state === "attention").length });
    case "summary": {
      const last = run.batches.at(-1);
      if (last?.summarized) return t("flow.summary.summarized", { round: last.round });
      return last && run.members.length && run.members.every((member) => member.state === "done" || member.state === "failed") ? t("flow.summary.summaryWaiting") : t("flow.summary.summaryNone");
    }
  }
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** The overview shape of a full run, so the diagram and the cards read either. */
export function overviewOf(run: RunDetail): RunView {
  return {
    id: run.id,
    mode: run.mode,
    title: run.title,
    status: run.status,
    round: run.round,
    rounds: run.rounds,
    planApproval: run.planApproval,
    language: run.language,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    brief: run.brief ? { title: run.brief.title, goal: run.brief.goal, acceptance: run.brief.acceptance } : null,
    members: run.members.map((member) => ({ role: member.role, agentId: member.agentId, title: member.title, state: member.state, task: clip(member.task, 280), retired: member.retired, agent: member.agent ?? null, model: member.model ?? null })),
    tasks: run.tasks.map((task) => ({ id: task.id, title: task.title, role: task.role, state: task.state, ownerTitle: task.ownerTitle, waitingOn: task.waitingOn, plan: task.plan?.status ?? null, sentBack: task.feedback !== "" && task.state !== "done" })),
    posts: run.posts.slice(-40).map((post) => ({ seq: post.seq, round: post.round, author: post.author, kind: post.kind, text: post.text, to: post.to, at: post.at })),
    postCount: run.posts.length,
    claims: run.claims.map((claim) => ({ role: claim.role, path: claim.path })),
    events: run.events,
    batches: run.batches.map((batch) => ({ round: batch.round, title: batch.title, packets: batch.taskIds.length, warnings: batch.warnings.length, followUp: batch.followUp, summarized: batch.summaryAt !== null })),
  };
}

/** The lead's terminal, when the worker sends it along with the run. */
export const leadIdOf = (run: object): string | null => {
  const id = (run as { leadAgentId?: unknown }).leadAgentId;
  return typeof id === "string" && id ? id : null;
};

/** A member's state color and whether it pulses: Orca's live agent state when known, else the run's. */
export function memberTone(member: { state: RunView["members"][number]["state"]; retired: boolean }, live?: string | null): { tone: string; pulse: boolean } {
  if (member.retired) return { tone: TONE.idle, pulse: false };
  if (live) return { tone: stateTone(live), pulse: live === "working" };
  return { tone: TONE[member.state], pulse: member.state === "working" };
}

export const liveText = (live: string | null | undefined) => (live ? t(`app.state.${live}`) : "");

/** The element's content width, kept current as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(Math.round(node.clientWidth));
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** A compact uppercase heading. */
export function SectionTitle({ children, right, icon }: { children: ReactNode; right?: ReactNode; icon?: string }) {
  return (
    <div className="r-section-title">
      {icon ? <Icon name={icon} size={13} /> : null}
      <span className="label grow">{children}</span>
      {right}
    </div>
  );
}

/** A labelled block of text. */
export function Field({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="r-field">
      <div className="r-field-label">{label}</div>
      {typeof children === "string" ? <div className={`r-text${mono ? " mono" : ""}`}>{children}</div> : children}
    </div>
  );
}

export function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="r-bullets">
      {items.map((item, index) => <li key={index}>{item}</li>)}
    </ul>
  );
}

/** Long text, clamped until opened. */
export function LongText({ text, lines = 6 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 90 || text.split("\n").length > lines;
  return (
    <div className="r-long">
      <div className="r-text" style={!open && long ? ({ WebkitLineClamp: lines, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" } as CSSProperties) : undefined}>{text}</div>
      {long ? (
        <button type="button" className="r-link" onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>
          {open ? t("report.showLess") : t("report.showMore")}
        </button>
      ) : null}
    </div>
  );
}

/** A party's name with its state dot; a member or the lead opens its terminal when clicked. */
export function PartyTag({ name, tone, pulse, onClick, title }: { name: string; tone?: string; pulse?: boolean; onClick?: () => void; title?: string }) {
  const body = (
    <>
      <span className={`dot${pulse ? " live" : ""}`} style={tone ? ({ "--tone": tone } as CSSProperties) : undefined} />
      <span className="ellipsis">{name}</span>
    </>
  );
  return onClick ? (
    <button type="button" className="r-party-tag click" onClick={(event) => { event.stopPropagation(); onClick(); }} title={title ?? t("report.focus")}>{body}</button>
  ) : (
    <span className="r-party-tag" title={title}>{body}</span>
  );
}

export function EventRow({ event, members, mode, now, onOpen, showComponent = true }: { event: RunEvent; members: readonly Member[]; mode: CollabMode; now: number; onOpen?: () => void; showComponent?: boolean }) {
  const [open, setOpen] = useState(false);
  const note = NOTE_IN_TEXT.has(event.action) ? "" : event.note;
  // With a place to go, the row opens it; otherwise it opens itself, so a long post or result can be read in full.
  const press = onOpen ?? (note ? () => setOpen((current) => !current) : undefined);
  return (
    <div
      className={`r-event${press ? " click" : ""}`}
      style={tint(componentColor(event.component))}
      role={press ? "button" : undefined}
      tabIndex={press ? 0 : undefined}
      onClick={press}
      onKeyDown={press ? (key) => { if (key.key === "Enter" || key.key === " ") { key.preventDefault(); press(); } } : undefined}
    >
      <span className="r-event-bar" />
      <div className="r-event-body">
        <div className="r-event-head">
          <span className="r-event-text">
            {showComponent ? <b className="r-event-comp">{componentName(event.component, mode)}</b> : null}
            {showComponent ? " · " : null}
            {describeEvent(event, members)}
            {event.count > 1 ? <span className="r-event-count">×{event.count}</span> : null}
          </span>
          <span className="r-event-ago" title={new Date(event.at).toLocaleString()}>{agoText(event.at, now)}</span>
        </div>
        {note ? <div className={`r-event-note${open ? " open" : ""}`}>{note}</div> : null}
      </div>
    </div>
  );
}

/** Per party: how much it wrote into the component and received from it over the whole run. */
export function Usage({ events, members }: { events: readonly RunEvent[]; members: readonly Member[] }) {
  const totals = [...flowTotals(events)].map(([party, row]) => {
    const cells = [...row.values()];
    return { party, wrote: cells.reduce((sum, cell) => sum + cell.in, 0), got: cells.reduce((sum, cell) => sum + cell.out, 0) };
  });
  totals.sort((a, b) => b.wrote + b.got - (a.wrote + a.got));
  const max = Math.max(1, ...totals.map((row) => Math.max(row.wrote, row.got)));
  return (
    <section className="r-panel">
      <SectionTitle icon="users">{t("flow.usage")}</SectionTitle>
      {!totals.length ? <div className="r-empty-line">{t("flow.none")}</div> : null}
      <div className="r-usage">
        {totals.map((row) => (
          <div key={row.party} className="r-usage-row">
            <span className="r-usage-name ellipsis" title={partyName(row.party, members)}>{partyName(row.party, members)}</span>
            <div className="r-usage-bars">
              <div className={`r-usage-bar${row.wrote ? "" : " zero"}`}>
                <span className="r-usage-track"><span className="r-usage-fill in" style={{ width: `${row.wrote ? Math.max(3, (row.wrote / max) * 100) : 0}%` }} /></span>
                <span className="r-usage-num">→ {t("flow.wrote", { count: row.wrote })}</span>
              </div>
              <div className={`r-usage-bar${row.got ? "" : " zero"}`}>
                <span className="r-usage-track"><span className="r-usage-fill out" style={{ width: `${row.got ? Math.max(3, (row.got / max) * 100) : 0}%` }} /></span>
                <span className="r-usage-num">← {t("flow.got", { count: row.got })}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function History({ events, members, mode, now, title, showComponent = true, limit = 30 }: { events: readonly RunEvent[]; members: readonly Member[]; mode: CollabMode; now: number; title?: string; showComponent?: boolean; limit?: number }) {
  const [all, setAll] = useState(false);
  const newest = [...events].reverse();
  const shown = all ? newest : newest.slice(0, limit);
  return (
    <section className="r-panel">
      <SectionTitle icon="clock" right={<span className="tiny muted">{newest.length}</span>}>{title ?? t("flow.history")}</SectionTitle>
      {!shown.length ? <div className="r-empty-line">{t("flow.none")}</div> : null}
      <div className="r-events">
        {shown.map((event) => <EventRow key={event.seq} event={event} members={members} mode={mode} now={now} showComponent={showComponent} />)}
      </div>
      {!all && newest.length > shown.length ? (
        <button type="button" className="r-link" onClick={() => setAll(true)}>{t("flow.viewAll", { count: newest.length })}</button>
      ) : null}
    </section>
  );
}
