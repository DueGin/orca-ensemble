// One page per component of a run, laid out for the width they get: the run report's wide tab (Kanban board, chat
// timeline with an inbox column, card grids) or the sidebar (stacked lists). Each page ends with who uses the component
// and its history (see ComponentBody).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { componentsOf, flowTotals, type RunComponent, type RunEvent } from "../../shared/flow";
import type { PendingBriefView, RunDetail } from "../../shared/views";
import { t } from "../i18n";
import { AgentAvatar, Badge, Button, Chip, Empty, Icon, TONE } from "../kit";
import {
  aboutText, agoText, Bullets, COMPONENT_ICON, componentColor, componentName, durationText, EventRow, Field, History, liveText, LongText, memberTone, partyName, PartyTag, SectionTitle, tint, Usage, type ComponentPage,
} from "./common";

type Task = RunDetail["tasks"][number];
type RunMember = RunDetail["members"][number];
type Batch = RunDetail["batches"][number];
interface PageProps {
  run: RunDetail;
  now: number;
  /** Room for columns: the run report's tab rather than the sidebar. */
  wide: boolean;
  onFocusAgent?(terminalId: string): void;
}

const TASK_COLUMNS = ["todo", "doing", "done", "dropped"] as const;
const TASK_TONE: Record<Task["state"], string> = { todo: "var(--c-tasks)", doing: TONE.working, done: TONE.done, dropped: TONE.idle };
const PLAN_TONE = { pending: "var(--c-plans)", approved: TONE.done, rejected: TONE.attention } as const;
const planLabel = (status: keyof typeof PLAN_TONE) => (status === "pending" ? t("flow.plans.pending") : status === "approved" ? t("flow.plans.approved") : t("flow.plans.rejected"));
const planBadge = (status: keyof typeof PLAN_TONE) => (status === "pending" ? t("session.planPending") : status === "approved" ? t("session.planApproved") : t("session.planRejected"));
const memberOf = (run: RunDetail, agentId: string | null) => (agentId ? run.members.find((member) => member.agentId === agentId) : undefined);
const taskNumber = (task: Task) => Number(task.id.replace(/\D/g, "")) || 0;

/** A member as a clickable name with its state dot. */
function MemberTag({ run, agentId, fallback, onFocusAgent }: { run: RunDetail; agentId: string | null; fallback?: string | null; onFocusAgent?(id: string): void }) {
  const member = memberOf(run, agentId);
  if (!member) return fallback ? <PartyTag name={agentId === "lead" ? t("flow.lead") : fallback} /> : null;
  const { tone, pulse } = memberTone(member, member.live);
  return <PartyTag name={member.title} tone={tone} pulse={pulse} onClick={onFocusAgent ? () => onFocusAgent(member.agentId) : undefined} />;
}

function Callout({ icon, tone, children }: { icon: string; tone: string; children: ReactNode }) {
  return (
    <div className="r-callout" style={{ "--tone": tone } as CSSProperties}>
      <Icon name={icon} size={15} />
      <div className="grow">{children}</div>
    </div>
  );
}

/** A panel sliding in from the right, over the page; Escape or a click outside closes it. */
function Drawer({ title, onClose, children }: { title: ReactNode; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="r-drawer-back" onClick={onClose}>
      <aside className="r-drawer" onClick={(event) => event.stopPropagation()} role="dialog">
        <header className="r-drawer-head">
          <div className="grow">{title}</div>
          <Button icon="x" variant="ghost" title={t("report.close")} onClick={onClose} />
        </header>
        <div className="r-drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Small label-and-value pairs in a row. */
function Facts({ items }: { items: readonly (readonly [ReactNode, ReactNode] | null | false)[] }) {
  return (
    <dl className="r-facts">
      {items.filter((item): item is readonly [ReactNode, ReactNode] => !!item).map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FileList({ files }: { files: readonly string[] }) {
  return (
    <div className="r-files">
      {files.map((file) => <span key={file} className="r-file mono"><Icon name="file" size={11} />{file}</span>)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Team mode

function TaskCard({ run, task, now, selected, onSelect, onFocusAgent, children }: { run: RunDetail; task: Task; now: number; selected: boolean; onSelect(): void; onFocusAgent?(id: string): void; children?: ReactNode }) {
  const sentBack = task.feedback !== "" && task.state !== "done";
  return (
    <div
      className={`r-tcard${selected ? " on" : ""}${task.state === "dropped" ? " dropped" : ""}`}
      style={tint(TASK_TONE[task.state])}
      role="button"
      tabIndex={0}
      aria-expanded={selected}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(); } }}
    >
      <div className="r-tcard-top">
        <span className="r-tid">{task.id}</span>
        <span className={`r-role${task.role ? "" : " any"}`}>{task.role ?? t("session.anyone")}</span>
        <span className="grow" />
        {task.plan ? <Badge tone={PLAN_TONE[task.plan.status]}>{planBadge(task.plan.status)}</Badge> : null}
      </div>
      <div className="r-tcard-title">{task.title}</div>
      {task.ownerTitle || task.waitingOn.length || sentBack ? (
        <div className="r-tcard-meta">
          {task.ownerTitle ? <MemberTag run={run} agentId={task.owner} fallback={task.ownerTitle} onFocusAgent={onFocusAgent} /> : null}
          {task.waitingOn.length ? <Badge tone={TONE.working}><Icon name="hourglass" size={11} />{t("session.waitsFor", { ids: task.waitingOn.join(", ") })}</Badge> : null}
          {sentBack ? <Badge tone={TONE.attention}><Icon name="undo" size={11} />{t("session.sentBack")}</Badge> : null}
        </div>
      ) : null}
      <div className="r-tcard-foot">
        <span>{t("flow.tasks.updated", { ago: agoText(task.updatedAt, now) })}</span>
        {task.files.length ? <span className="r-tcard-files" title={task.files.join("\n")}><Icon name="file" size={11} />{task.files.length}</span> : null}
        {task.deps.length && !task.waitingOn.length ? <span title={task.deps.join(", ")}><Icon name="check" size={11} />{task.deps.join(", ")}</span> : null}
      </div>
      {children ? <div className="r-tcard-more" onClick={(event) => event.stopPropagation()}>{children}</div> : null}
    </div>
  );
}

function TaskDetail({ run, task, now, onFocusAgent }: { run: RunDetail; task: Task; now: number; onFocusAgent?(id: string): void }) {
  const history = run.events.filter((event) => (event.component === "tasks" || event.component === "plans" || event.component === "split") && event.subject === task.id);
  return (
    <div className="r-tdetail">
      {task.detail && task.detail !== task.title ? <Field label={t("flow.details")}><LongText text={task.detail} lines={12} /></Field> : null}
      <Facts
        items={[
          [t("flow.tasks.role"), task.role ?? t("session.anyone")],
          [t("flow.tasks.owner"), task.ownerTitle ? <MemberTag run={run} agentId={task.owner} fallback={task.ownerTitle} onFocusAgent={onFocusAgent} /> : "–"],
          [t("flow.tasks.createdBy"), task.createdBy === "lead" ? t("flow.lead") : task.createdBy],
          task.deps.length > 0 && [
            t("flow.tasks.waitsFor"),
            <span className="r-deps">
              {task.deps.map((dep) => {
                const waiting = task.waitingOn.includes(dep);
                return <span key={dep} className={waiting ? "warn" : "ok"} title={waiting ? t("report.depWaiting") : t("report.depDone")}><Icon name={waiting ? "hourglass" : "check"} size={11} />{dep}</span>;
              })}
            </span>,
          ],
        ]}
      />
      {task.files.length ? <Field label={t("flow.tasks.files")}><FileList files={task.files} /></Field> : null}
      {task.plan ? (
        <div className="r-subcard" style={tint(PLAN_TONE[task.plan.status])}>
          <div className="r-subcard-head">
            <span className="r-field-label">{t("flow.tasks.plan")}</span>
            <Badge tone={PLAN_TONE[task.plan.status]}>{planLabel(task.plan.status)}</Badge>
            {task.plan.status !== "pending" ? <span className="tiny muted">{task.plan.delivered ? t("flow.plans.delivered") : t("flow.plans.notDelivered")}</span> : null}
          </div>
          <LongText text={task.plan.text} lines={8} />
          {task.plan.feedback ? <div className="r-verdict"><b>{t("flow.lead")}:</b> {task.plan.feedback}</div> : null}
        </div>
      ) : null}
      {task.result ? <Field label={t("flow.tasks.result")}><LongText text={task.result} lines={10} /></Field> : null}
      {task.feedback ? <Callout icon="undo" tone={TONE.attention}><div className="r-field-label">{t("flow.tasks.feedback")}</div><div className="r-text">{task.feedback}</div></Callout> : null}
      {history.length ? (
        <Field label={t("flow.history")}>
          <div className="r-events">{[...history].reverse().map((event) => <EventRow key={event.seq} event={event} members={run.members} mode={run.mode} now={now} />)}</div>
        </Field>
      ) : null}
    </div>
  );
}

function TaskTitle({ task }: { task: Task }) {
  return (
    <div className="stack" style={{ "--gap": "4px" } as CSSProperties}>
      <div className="row">
        <span className="r-tid">{task.id}</span>
        <Badge tone={TASK_TONE[task.state]}>{t(`session.taskState.${task.state}`)}</Badge>
      </div>
      <div className="r-drawer-title">{task.title}</div>
    </div>
  );
}

const columnOrder = (state: Task["state"]) => (a: Task, b: Task) => {
  if (state === "todo") return a.waitingOn.length - b.waitingOn.length || taskNumber(a) - taskNumber(b);
  if (state === "done") return b.updatedAt.localeCompare(a.updatedAt);
  return taskNumber(a) - taskNumber(b);
};

/** The shared task board: a Kanban board when wide, the same columns stacked in the sidebar. */
export function TasksPage({ run, now, wide, onFocusAgent }: PageProps) {
  const [role, setRole] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const roles = [...new Set(run.tasks.map((task) => task.role ?? ""))];
  const tasks = run.tasks.filter((task) => role === null || (task.role ?? "") === role);
  const current = selected ? run.tasks.find((task) => task.id === selected) : undefined;
  const live = run.tasks.filter((task) => task.state !== "dropped");
  const done = live.filter((task) => task.state === "done").length;
  if (!run.tasks.length) return <Empty icon="kanban">{t("flow.tasks.none")}</Empty>;
  const toggle = (id: string) => setSelected((value) => (value === id ? null : id));
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      <div className="r-toolbar">
        <div className="r-progress-line">
          <span className="strong">{t("report.doneOf", { done, total: live.length })}</span>
          <span className="r-meter"><span style={{ width: `${live.length ? Math.round((done / live.length) * 100) : 0}%` }} /></span>
        </div>
        {roles.length > 1 ? (
          <div className="r-chips">
            <Chip on={role === null} onClick={() => setRole(null)}>{t("flow.filterAll")}</Chip>
            {roles.map((entry) => <Chip key={entry} on={role === entry} color="var(--c-tasks)" onClick={() => setRole(entry)}>{entry || t("session.anyone")}</Chip>)}
          </div>
        ) : null}
      </div>
      {wide ? (
        <div className="r-kanban">
          {TASK_COLUMNS.map((state) => {
            const list = tasks.filter((task) => task.state === state).sort(columnOrder(state));
            return (
              <section key={state} className={`r-kcol${state === "dropped" && !list.length ? " slim" : ""}`} style={tint(TASK_TONE[state])}>
                <header className="r-kcol-head">
                  <span className="dot" style={{ "--tone": TASK_TONE[state] } as CSSProperties} />
                  <span className="grow">{t(`session.taskState.${state}`)}</span>
                  <span className="r-count">{list.length}</span>
                </header>
                <div className="r-kcol-body">
                  {list.map((task) => <TaskCard key={task.id} run={run} task={task} now={now} selected={task.id === selected} onSelect={() => toggle(task.id)} onFocusAgent={onFocusAgent} />)}
                  {!list.length ? <div className="r-kcol-empty">{t("report.columnEmpty")}</div> : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        TASK_COLUMNS.map((state) => {
          const list = tasks.filter((task) => task.state === state).sort(columnOrder(state));
          if (!list.length) return null;
          return (
            <section key={state} className="r-kstack" style={tint(TASK_TONE[state])}>
              <header className="r-kcol-head">
                <span className="dot" style={{ "--tone": TASK_TONE[state] } as CSSProperties} />
                <span className="grow">{t(`session.taskState.${state}`)}</span>
                <span className="r-count">{list.length}</span>
              </header>
              {list.map((task) => (
                <TaskCard key={task.id} run={run} task={task} now={now} selected={task.id === selected} onSelect={() => toggle(task.id)} onFocusAgent={onFocusAgent}>
                  {task.id === selected ? <TaskDetail run={run} task={task} now={now} onFocusAgent={onFocusAgent} /> : null}
                </TaskCard>
              ))}
            </section>
          );
        })
      )}
      {wide && current ? (
        <Drawer title={<TaskTitle task={current} />} onClose={() => setSelected(null)}>
          <TaskDetail run={run} task={current} now={now} onFocusAgent={onFocusAgent} />
        </Drawer>
      ) : null}
    </div>
  );
}

export function PlansPage({ run, now, wide, onFocusAgent }: PageProps) {
  const withPlans = run.tasks.filter((task) => task.plan);
  if (!run.planApproval && !withPlans.length) return <Callout icon="info" tone="var(--muted-fg)">{t("flow.plans.off")}</Callout>;
  if (!withPlans.length) return <Empty icon="clipboard">{t("flow.plans.none")}</Empty>;
  const order = { pending: 0, rejected: 1, approved: 2 } as const;
  const count = (status: keyof typeof order) => withPlans.filter((task) => task.plan!.status === status).length;
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      <div className="r-stats">
        {(["pending", "rejected", "approved"] as const).map((status) => (
          <div key={status} className="r-stat" style={tint(PLAN_TONE[status])}>
            <span className="r-stat-num">{count(status)}</span>
            <span className="r-stat-label">{planLabel(status)}</span>
          </div>
        ))}
      </div>
      <div className="r-list">
        {[...withPlans].sort((a, b) => order[a.plan!.status] - order[b.plan!.status] || taskNumber(a) - taskNumber(b)).map((task) => {
          const plan = task.plan!;
          return (
            <article key={task.id} className="r-plan" style={tint(PLAN_TONE[plan.status])}>
              <header className="r-plan-head">
                <span className="r-tid">{task.id}</span>
                <span className="r-plan-title grow">{task.title}</span>
                <Badge tone={PLAN_TONE[plan.status]}>{planLabel(plan.status)}</Badge>
              </header>
              <div className="r-plan-meta">
                {task.ownerTitle ? <MemberTag run={run} agentId={task.owner} fallback={task.ownerTitle} onFocusAgent={onFocusAgent} /> : null}
                {plan.status !== "pending" ? <span className={plan.delivered ? "ok" : "warn"}><Icon name={plan.delivered ? "check" : "clock"} size={11} /> {plan.delivered ? t("flow.plans.delivered") : t("flow.plans.notDelivered")}</span> : null}
                <span className="muted">{t("flow.tasks.updated", { ago: agoText(task.updatedAt, now) })}</span>
              </div>
              <div className={wide && plan.feedback ? "r-two" : "stack"}>
                <Field label={t("flow.tasks.plan")}><LongText text={plan.text} lines={wide ? 10 : 6} /></Field>
                {plan.feedback ? <Field label={t("flow.lead")}><div className="r-verdict">{plan.feedback}</div></Field> : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

const KIND_TONE: Record<string, string> = { brief: "var(--c-brief)", update: "var(--info)", finding: "var(--warn)", question: "var(--c-plans)", answer: "var(--c-board)", done: "var(--ok)", note: "var(--muted-fg)" };
const AUTHOR_TONES = ["#60a5fa", "#f472b6", "#34d399", "#f5a524", "#a78bfa", "#22d3ee", "#e879f9", "#84cc16"];
const kindName = (kind: string) => t(`report.kind.${kind}`) === `report.kind.${kind}` ? kind : t(`report.kind.${kind}`);
const initials = (name: string) => name.replace(/#.*$/, "").slice(0, 2).toUpperCase();

/** The team board as a conversation, oldest first, with each reader's inbox beside it. */
export function BoardPage({ run, now, wide, onFocusAgent }: PageProps) {
  const [kind, setKind] = useState<string | null>(null);
  const [earlier, setEarlier] = useState(false);
  const kinds = [...new Set(run.posts.map((post) => post.kind))];
  const filtered = run.posts.filter((post) => kind === null || post.kind === kind);
  const limit = 40;
  const posts = wide || earlier ? filtered : filtered.slice(-limit);
  const last = run.posts.at(-1)?.seq ?? 0;
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // Stay at the newest post while the reader hasn't scrolled up.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [posts.length, wide, kind]);

  const readers = [
    { id: "lead", title: t("flow.lead"), readSeq: run.leadReadSeq, inboxSeq: null as number | null, tone: "var(--lead)" },
    ...run.members.filter((member) => !member.retired).map((member) => ({ id: member.agentId, title: member.title, readSeq: member.readSeq, inboxSeq: member.inboxSeq, tone: memberTone(member, member.live).tone })),
  ];
  const authorTone = (agentId: string, author: string) => {
    if (author === "lead") return "var(--lead)";
    const index = run.members.findIndex((member) => member.agentId === agentId);
    return AUTHOR_TONES[(index < 0 ? 0 : index) % AUTHOR_TONES.length]!;
  };

  const filters = (
    <div className="r-chips">
      <Chip on={kind === null} onClick={() => setKind(null)}>{t("flow.filterAll")} {run.posts.length}</Chip>
      {kinds.map((entry) => (
        <Chip key={entry} on={kind === entry} color={KIND_TONE[entry]} onClick={() => setKind(kind === entry ? null : entry)}>
          {kindName(entry)} {run.posts.filter((post) => post.kind === entry).length}
        </Chip>
      ))}
    </div>
  );
  const inbox = (
    <section className="r-panel">
      <SectionTitle icon="inbox">{t("flow.board.inbox")}</SectionTitle>
      <div className="r-inbox">
        {readers.map((reader) => {
          const read = last ? Math.min(reader.readSeq, last) / last : 0;
          const delivered = last && reader.inboxSeq !== null ? Math.min(Math.max(reader.inboxSeq, reader.readSeq), last) / last : read;
          const unread = Math.max(0, last - reader.readSeq);
          return (
            <div key={reader.id} className="r-inbox-row">
              <div className="row between">
                {reader.id === "lead" ? <PartyTag name={reader.title} tone={reader.tone} /> : <MemberTag run={run} agentId={reader.id} onFocusAgent={onFocusAgent} />}
                <span className={`tiny ${unread ? "warn" : "muted"}`}>{unread ? t("flow.board.unread", { count: unread }) : <Icon name="check" size={11} />}</span>
              </div>
              <div className="r-inbox-bar" title={reader.inboxSeq !== null ? t("report.deliveredUpTo", { seq: reader.inboxSeq }) : undefined}>
                <span className="delivered" style={{ width: `${Math.round(delivered * 100)}%` }} />
                <span className="read" style={{ width: `${Math.round(read * 100)}%` }} />
              </div>
              <div className="tiny muted">{t("flow.board.readUpTo", { seq: reader.readSeq })}{reader.inboxSeq !== null ? ` · ${t("report.deliveredUpTo", { seq: reader.inboxSeq })}` : ""}</div>
            </div>
          );
        })}
      </div>
    </section>
  );

  const timeline = (
    <div
      ref={scroller}
      className={`r-timeline${wide ? " scroll" : ""}`}
      onScroll={(event) => {
        const node = event.currentTarget;
        stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      }}
    >
      {!wide && !earlier && filtered.length > limit ? <button type="button" className="r-link center" onClick={() => setEarlier(true)}>{t("report.showEarlier", { count: filtered.length - limit })}</button> : null}
      {!posts.length ? <Empty icon="messages">{t("flow.board.none")}</Empty> : null}
      {posts.map((post, index) => {
        const lead = post.author === "lead";
        const poster = run.members.find((member) => member.agentId === post.agentId);
        const author = lead ? t("flow.lead") : poster?.title ?? post.author;
        const newRound = index === 0 || posts[index - 1]!.round !== post.round;
        const tone = authorTone(post.agentId, post.author);
        return (
          <div key={post.seq} className="r-post-wrap">
            {newRound ? <div className="r-round-divider"><span>{run.mode === "team" ? t("session.round", { round: post.round, rounds: run.rounds }) : t("session.batch", { round: post.round })}</span></div> : null}
            <div className={`r-post${lead ? " lead" : ""}${post.kind === "brief" ? " brief" : ""}`} style={tint(KIND_TONE[post.kind] ?? "var(--muted-fg)")}>
              <span className="r-avatar" style={{ "--tone": tone } as CSSProperties} title={author}>
                {lead ? <Icon name="crown" size={13} /> : poster?.agent ? <AgentAvatar agent={poster.agent} model={poster.model} size={28} /> : initials(author)}
              </span>
              <div className="r-bubble">
                <div className="r-post-head">
                  <b className="ellipsis">{author}</b>
                  <span className="r-kind">{kindName(post.kind)}</span>
                  {post.to.length ? <span className="r-post-to ellipsis"><Icon name="send" size={10} /> {post.to.map((to) => partyName(to, run.members)).join(", ")}</span> : null}
                  <span className="grow" />
                  <span className="r-post-seq" title={new Date(post.at).toLocaleString()}>#{post.seq} · {agoText(post.at, now)}</span>
                </div>
                <LongText text={post.text} lines={post.kind === "brief" ? 6 : 12} />
                {post.files.length ? <FileList files={post.files} /> : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (wide) {
    return (
      <div className="r-board">
        <div className="r-board-main">{timeline}</div>
        <aside className="r-board-aside">
          <section className="r-panel">
            <SectionTitle icon="filter">{t("report.kinds")}</SectionTitle>
            {filters}
          </section>
          {inbox}
        </aside>
      </div>
    );
  }
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      {filters}
      {timeline}
      {inbox}
    </div>
  );
}

export function ClaimsPage({ run, now, onFocusAgent }: PageProps) {
  const holders = [...new Set(run.claims.map((claim) => claim.agentId))];
  const refused = run.events.filter((event) => event.component === "claims" && event.action === "conflict").slice(-8).reverse();
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      {!holders.length ? <Empty icon="file-lock">{t("flow.claims.none")}</Empty> : null}
      <div className="r-grid" style={{ "--min": "300px" } as CSSProperties}>
        {holders.map((holder) => {
          const member = memberOf(run, holder);
          const claims = run.claims.filter((claim) => claim.agentId === holder);
          const tasks = run.tasks.filter((task) => task.owner === holder && task.state === "doing");
          return (
            <article key={holder} className="r-holder">
              <header className="row between">
                <MemberTag run={run} agentId={holder} fallback={claims[0]?.role ?? holder} onFocusAgent={onFocusAgent} />
                <span className="tiny muted">{member?.role ?? claims[0]?.role} · {t("report.paths", { count: claims.length })}</span>
              </header>
              <div className="r-claims">
                {claims.map((claim) => {
                  const task = tasks.find((entry) => entry.files.includes(claim.path));
                  return (
                    <div key={claim.path} className="r-claim">
                      <Icon name="file-lock" size={13} style={{ color: "var(--c-claims)" }} />
                      <span className="mono grow r-claim-path">{claim.path}</span>
                      {task ? <span className="r-tid small" title={task.title}>{task.id}</span> : null}
                      <span className="tiny muted">{t("flow.claims.since", { ago: agoText(claim.at, now) })}</span>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
      {refused.length ? (
        <section className="r-panel">
          <SectionTitle icon="alert">{t("report.refused")}</SectionTitle>
          <div className="r-events">{refused.map((event) => <EventRow key={event.seq} event={event} members={run.members} mode={run.mode} now={now} showComponent={false} />)}</div>
        </section>
      ) : null}
    </div>
  );
}

export function BriefPage({ run }: PageProps) {
  const brief = run.brief;
  if (!brief) return <Empty icon="file-text">{t("flow.brief.none")}</Empty>;
  const sentTo = [...new Set(run.events.filter((event) => event.component === "brief" && event.action === "deliver").flatMap((event) => event.to))];
  return (
    <article className="r-brief">
      <h2 className="r-brief-title">{brief.title}</h2>
      <div className="r-brief-goal">
        <div className="r-field-label">{t("flow.brief.goal")}</div>
        <div className="r-text">{brief.goal}</div>
      </div>
      <BriefLists brief={brief} />
      {brief.userConfirmation ? (
        <div className="r-quote">
          <div className="r-field-label">{t("flow.brief.confirmation")}</div>
          <div className="r-text">“{brief.userConfirmation}”</div>
        </div>
      ) : null}
      {sentTo.length ? (
        <div className="r-brief-sent">
          <span className="r-field-label">{t("report.briefSentTo")}</span>
          {sentTo.map((party) => <MemberTag key={party} run={run} agentId={party} fallback={partyName(party, run.members)} />)}
        </div>
      ) : null}
    </article>
  );
}

function BriefLists({ brief }: { brief: { requirements: string[]; acceptance: string[]; constraints: string[]; outOfScope: string[] } }) {
  const sections = [
    ["flow.brief.requirements", brief.requirements, "check"],
    ["flow.brief.acceptance", brief.acceptance, "check-circle"],
    ["flow.brief.constraints", brief.constraints, "lock"],
    ["flow.brief.outOfScope", brief.outOfScope, "x"],
  ] as const;
  return (
    <div className="r-brief-grid">
      {sections.filter(([, items]) => items.length).map(([key, items, icon]) => (
        <section key={key} className="r-brief-list">
          <div className="r-field-label"><Icon name={icon} size={12} /> {t(key)} <span className="muted">{items.length}</span></div>
          <Bullets items={items} />
        </section>
      ))}
    </div>
  );
}

/** The brief and task plan the lead showed the user, waiting for the user's confirmation. */
export function PendingBrief({ pending, now }: { pending: PendingBriefView; now: number }) {
  return (
    <div className="r-pending-body">
      <div className="tiny muted">{t("flow.brief.pendingHint")} · {agoText(pending.at, now)}</div>
      <div className="r-brief-title small">{pending.brief.title}</div>
      <Field label={t("flow.brief.goal")}>{pending.brief.goal}</Field>
      <BriefLists brief={pending.brief} />
      {pending.tasks.length ? (
        <Field label={t("flow.brief.plannedTasks")}>
          <ol className="r-plan-list">
            {pending.tasks.map((task, index) => (
              <li key={index}>
                {task.title} <span className="muted">({task.role ?? t("session.anyone")}){task.after.length ? ` · ${t("session.waitsFor", { ids: task.after.join(", ") })}` : ""}</span>
              </li>
            ))}
          </ol>
        </Field>
      ) : null}
      <div className="tiny muted">
        {t("flow.brief.roles")}: {pending.roles.join(", ")} · {t("flow.brief.rounds")}: {pending.rounds}{pending.planApproval ? ` · ${t("flow.brief.planApproval")}` : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Delegation mode

const batchLabel = (batch: Batch) => (batch.followUp ? `${t("flow.split.batch", { round: batch.round })} · ${t("flow.split.followUp")}` : t("flow.split.batch", { round: batch.round }));
/** When a member's latest report came in, from the data flow. */
const reportAt = (run: RunDetail, agentId: string, after?: string) => [...run.events].reverse().find((event) => event.component === "reports" && event.action === "report" && event.from === agentId && (!after || event.at >= after))?.at;
/** The member's runtime: its agent and model, or what the plugin noted when it started the member's context. */
const runtimeOf = (run: RunDetail, member: RunMember) => {
  if (member.agent) return member.model ? `${member.agent}/${member.model}` : member.agent;
  return run.events.find((event) => event.component === "contexts" && event.action === "start" && event.to.includes(member.agentId))?.note || null;
};

function PacketCard({ run, task, open, onToggle, onFocusAgent, extra }: { run: RunDetail; task: Task; open: boolean; onToggle(): void; onFocusAgent?(id: string): void; extra?: ReactNode }) {
  return (
    <div className={`r-packet${open ? " on" : ""}`} style={tint(TASK_TONE[task.state])} role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onToggle(); } }}>
      <div className="r-packet-head">
        <span className="r-tid">{task.id}</span>
        {/* A member's title starts with its role, so the role shows on its own only while no one has the packet. */}
        {task.ownerTitle ? <MemberTag run={run} agentId={task.owner} fallback={task.ownerTitle} onFocusAgent={onFocusAgent} /> : <span className={`r-role${task.role ? "" : " any"}`}>{task.role ?? t("session.anyone")}</span>}
        <span className="grow" />
        <Badge tone={TASK_TONE[task.state]}>{t(`session.taskState.${task.state}`)}</Badge>
        <Icon name={open ? "down" : "right"} size={14} style={{ color: "var(--muted-fg)" }} />
      </div>
      {extra}
      {open ? (
        <div className="r-packet-more" onClick={(event) => event.stopPropagation()}>
          <LongText text={task.detail || task.title} lines={14} />
          {task.result ? <Field label={t("flow.tasks.result")}><LongText text={task.result} lines={8} /></Field> : null}
        </div>
      ) : (
        <div className="r-packet-title">{task.title}</div>
      )}
    </div>
  );
}

/** Delegation, step 1: each split of a request into packets, with why delegation and the overlap check. */
export function SplitPage(props: PageProps) {
  const { run, now, onFocusAgent } = props;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Runs from before splits were recorded show their packets as a task list.
  if (!run.batches.length) return run.tasks.length ? <TasksPage {...props} /> : <Empty icon="split">{t("flow.split.none")}</Empty>;
  return (
    <div className="stack" style={{ "--gap": "14px" } as CSSProperties}>
      {[...run.batches].reverse().map((batch) => {
        const tasks = batch.taskIds.map((id) => run.tasks.find((task) => task.id === id)).filter((task): task is Task => !!task);
        const check = batch.warnings.length ? "warn" : !batch.followUp && tasks.length > 1 ? "ok" : null;
        return (
          <article key={`${batch.round}-${batch.at}`} className="r-batch" style={tint("var(--c-split)")}>
            <header className="r-batch-head">
              <span className="r-batch-no">{batchLabel(batch)}</span>
              <span className="r-batch-title grow">{batch.title}</span>
              {check === "warn" ? <Badge tone={TONE.working}><Icon name="alert" size={11} />{t("flow.split.overlap")}</Badge> : null}
              {check === "ok" ? <Badge tone={TONE.done}><Icon name="check" size={11} />{t("flow.split.disjoint")}</Badge> : null}
            </header>
            <div className="r-batch-meta">
              <span title={new Date(batch.at).toLocaleString()}><Icon name="clock" size={11} /> {agoText(batch.at, now)}</span>
              <span><Icon name="boxes" size={11} /> {t("flow.split.packets")} {batch.taskIds.length}</span>
              <span>{t("report.doneOf", { done: tasks.filter((task) => task.state === "done").length, total: tasks.length })}</span>
            </div>
            {batch.reason ? <Field label={t("flow.split.reason")}>{batch.reason}</Field> : null}
            {batch.warnings.length ? (
              <Callout icon="alert" tone={TONE.working}>
                <div className="strong">{t("flow.split.overlap")}</div>
                <Bullets items={batch.warnings} />
              </Callout>
            ) : null}
            <div className="r-grid" style={{ "--min": "300px" } as CSSProperties}>
              {tasks.map((task) => {
                const key = `${batch.round}:${task.id}`;
                return <PacketCard key={task.id} run={run} task={task} open={open[key] ?? false} onToggle={() => setOpen((current) => ({ ...current, [key]: !current[key] }))} onFocusAgent={onFocusAgent} />;
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/** Delegation, step 2: each sub-agent's own context, holding only the packets it was given. */
export function ContextsPage({ run, now, onFocusAgent }: PageProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!run.members.length) return <Empty icon="boxes">{t("flow.contexts.none")}</Empty>;
  const batchOf = (id: string) => run.batches.find((batch) => batch.taskIds.includes(id));
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      <Callout icon="lock" tone="var(--c-contexts)">{t("flow.contexts.isolation")}</Callout>
      <div className="r-grid" style={{ "--min": "340px" } as CSSProperties}>
        {run.members.map((member) => {
          const contexts = run.events.filter((event) => event.component === "contexts" && event.to.includes(member.agentId) && (event.action === "start" || event.action === "continue"));
          const attention = run.events.filter((event) => event.component === "contexts" && event.action === "attention" && event.from === member.agentId).reduce((sum, event) => sum + event.count, 0);
          const packets = run.tasks.filter((task) => task.owner === member.agentId);
          const latest = contexts.at(-1);
          const runtime = runtimeOf(run, member);
          const { tone, pulse } = memberTone(member, member.live);
          const busy = member.state === "working" || member.state === "attention";
          return (
            <article key={member.agentId} className={`r-context${member.retired ? " retired" : ""}`}>
              <header className="r-context-head">
                <span className="r-avatar" style={{ "--tone": tone } as CSSProperties}><AgentAvatar agent={member.agent ?? "unknown"} model={member.model} size={28} title={runtime ?? member.role} /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <PartyTag name={member.title} tone={tone} pulse={pulse} onClick={onFocusAgent ? () => onFocusAgent(member.agentId) : undefined} />
                  <div className="tiny muted">{member.role}</div>
                </div>
                <Badge tone={tone}>{member.retired ? t("session.retired") : t(`session.state.${member.state}`)}</Badge>
              </header>
              <Facts
                items={[
                  [t("report.runtime"), runtime ? <span className="mono">{runtime}</span> : <span className="muted">{t("report.unknown")}</span>],
                  [t("report.context"), latest ? (latest.action === "continue" ? t("flow.contexts.continued") : t("flow.contexts.started")) : "–"],
                  member.live ? [t("report.liveState"), liveText(member.live)] : null,
                  busy ? [t("report.elapsed"), durationText(now - Date.parse(member.dispatchedAt))] : null,
                  attention > 0 && [t("report.attention"), <span className="bad">{t("report.attentionCount", { count: attention })}</span>],
                ]}
              />
              <div className="r-field-label">{t("flow.contexts.received")} · {packets.length}</div>
              <div className="r-context-packets">
                {packets.map((task) => {
                  const key = `${member.agentId}:${task.id}`;
                  const batch = batchOf(task.id);
                  const context = batch ? contexts.find((event) => event.at >= batch.at) : undefined;
                  const expanded = open[key] ?? false;
                  return (
                    <div key={task.id} className={`r-context-packet${expanded ? " on" : ""}`} role="button" tabIndex={0} onClick={() => setOpen((current) => ({ ...current, [key]: !expanded }))}>
                      <div className="row">
                        <span className="r-tid">{task.id}</span>
                        {batch ? <span className="tiny muted">{batchLabel(batch)}</span> : null}
                        {context ? <span className={`r-ctx-tag${context.action === "continue" ? " reused" : ""}`}>{context.action === "continue" ? t("report.reused") : t("report.fresh")}</span> : null}
                        <span className="grow" />
                        <span className="dot" style={{ "--tone": TASK_TONE[task.state] } as CSSProperties} title={t(`session.taskState.${task.state}`)} />
                        <Icon name={expanded ? "down" : "right"} size={13} style={{ color: "var(--muted-fg)" }} />
                      </div>
                      {expanded ? <div onClick={(event) => event.stopPropagation()}><LongText text={task.detail || task.title} lines={14} /></div> : <div className="r-packet-title">{task.title}</div>}
                    </div>
                  );
                })}
                {!packets.length ? <div className="r-empty-line">–</div> : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** Delegation, step 3: what each sub-agent reported back, and how long its packet took. */
export function ReportsPage({ run, now, wide, onFocusAgent }: PageProps) {
  if (!run.members.length) return <Empty icon="inbox">{t("flow.contexts.none")}</Empty>;
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      {run.members.map((member) => {
        const at = reportAt(run, member.agentId, member.dispatchedAt);
        const busy = member.state === "working" || member.state === "attention";
        const { tone, pulse } = memberTone(member, member.live);
        const status = busy ? { text: t("flow.reports.working"), tone: TONE.working } : member.collected ? { text: t("flow.reports.collected"), tone: TONE.done } : { text: t("flow.reports.waiting"), tone: "var(--c-reports)" };
        return (
          <article key={member.agentId} className={`r-rcard${member.retired ? " retired" : ""}`} style={tint(tone)}>
            <header className="r-rcard-head">
              <PartyTag name={member.title} tone={tone} pulse={pulse} onClick={onFocusAgent ? () => onFocusAgent(member.agentId) : undefined} />
              <span className="tiny muted">{member.role}</span>
              <span className="grow" />
              {at ? <span className="tiny muted"><Icon name="timer" size={11} /> {t("flow.took", { time: durationText(Date.parse(at) - Date.parse(member.dispatchedAt)) })}</span> : busy ? <span className="tiny muted"><Icon name="timer" size={11} /> {durationText(now - Date.parse(member.dispatchedAt))}</span> : null}
              <Badge tone={status.tone}>{status.text}</Badge>
            </header>
            <div className={wide ? "r-two" : "stack"}>
              {member.task ? <Field label={t("flow.reports.task")}><LongText text={member.task} lines={wide ? 9 : 5} /></Field> : null}
              <Field label={t("flow.reports.result")}>
                {member.result ? <LongText text={member.result} lines={wide ? 9 : 6} /> : <div className="r-empty-line">{busy ? t("flow.reports.working") : t("report.noResult")}</div>}
              </Field>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/** Delegation, step 4: the lead's summary of each batch, how long the batch took, and its slowest packet. */
export function SummaryPage({ run, now }: PageProps) {
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      <Callout icon="alert" tone={TONE.working}>{t("flow.summaryPage.noCheck")}</Callout>
      {!run.batches.length ? <Empty icon="merge">{t("flow.summaryPage.none")}</Empty> : null}
      {[...run.batches].reverse().map((batch) => {
        const owners = new Set(batch.taskIds.map((id) => run.tasks.find((task) => task.id === id)?.owner).filter((owner): owner is string => !!owner));
        const members = run.members.filter((member) => owners.has(member.agentId));
        const reported = members.filter((member) => member.state === "done" || member.state === "failed").length;
        const collected = members.filter((member) => member.collected).length;
        const timings = members.map((member) => ({ member, at: reportAt(run, member.agentId, batch.at) })).filter((entry): entry is { member: RunMember; at: string } => !!entry.at);
        const slowest = timings.sort((a, b) => b.at.localeCompare(a.at))[0];
        return (
          <article key={`${batch.round}-${batch.at}`} className="r-batch" style={tint("var(--c-summary)")}>
            <header className="r-batch-head">
              <span className="r-batch-no">{batchLabel(batch)}</span>
              <span className="r-batch-title grow">{batch.title}</span>
              {batch.summaryAt ? <Badge tone={TONE.done}><Icon name="check" size={11} />{t("flow.summaryPage.done", { ago: agoText(batch.summaryAt, now) })}</Badge> : <Badge tone="var(--c-summary)"><Icon name="hourglass" size={11} />{t("flow.summary.summaryWaiting")}</Badge>}
            </header>
            <div className="r-stats">
              <div className="r-stat">
                <span className="r-stat-num">{batch.summaryAt ? durationText(Date.parse(batch.summaryAt) - Date.parse(batch.at)) : "–"}</span>
                <span className="r-stat-label">{t("report.metricLatency")}</span>
              </div>
              <div className="r-stat">
                <span className="r-stat-num">{slowest ? durationText(Date.parse(slowest.at) - Date.parse(batch.at)) : "–"}</span>
                <span className="r-stat-label">{slowest ? t("report.metricSlowest", { member: slowest.member.title }) : t("report.metricSlowestNone")}</span>
              </div>
              <div className="r-stat">
                <span className="r-stat-num">{reported}/{members.length}</span>
                <span className="r-stat-label">{t("report.metricReported")}</span>
              </div>
              <div className="r-stat">
                <span className="r-stat-num">{collected}/{members.length}</span>
                <span className="r-stat-label">{t("report.metricCollected")}</span>
              </div>
            </div>
            {batch.summary ? (
              <Field label={t("flow.component.summary")}><LongText text={batch.summary} lines={16} /></Field>
            ) : (
              <div className="r-empty-line">{t("flow.summaryPage.waiting", { reported, total: members.length, collected })}</div>
            )}
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// All flows

const PARTY_ORDER = (party: string) => (party === "user" ? 0 : party === "lead" ? 1 : party === "plugin" ? 3 : 2);

/** Who wrote into and received from each component, as a table. */
function FlowMatrix({ run, components, focus, onFocus }: { run: RunDetail; components: RunComponent[]; focus: RunComponent | null; onFocus(component: RunComponent | null): void }) {
  const totals = flowTotals(run.events);
  const parties = [...totals.keys()].sort((a, b) => PARTY_ORDER(a) - PARTY_ORDER(b) || run.members.findIndex((member) => member.agentId === a) - run.members.findIndex((member) => member.agentId === b));
  const max = Math.max(1, ...[...totals.values()].flatMap((row) => [...row.values()].map((cell) => cell.in + cell.out)));
  if (!parties.length) return null;
  return (
    <section className="r-panel">
      <SectionTitle icon="users" right={<span className="tiny muted">{t("report.matrixHint")}</span>}>{t("flow.usage")}</SectionTitle>
      <div className="r-matrix-wrap">
        <table className="r-matrix">
          <thead>
            <tr>
              <th />
              {components.map((component) => (
                <th key={component} className={focus === component ? "on" : ""} style={tint(componentColor(component))}>
                  <button type="button" onClick={() => onFocus(focus === component ? null : component)}>
                    <span className="r-ctile tiny"><Icon name={COMPONENT_ICON[component]} size={11} /></span>
                    <span>{componentName(component, run.mode)}</span>
                  </button>
                </th>
              ))}
              <th className="total">{t("report.total")}</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const row = totals.get(party)!;
              const sum = [...row.values()].reduce((acc, cell) => ({ in: acc.in + cell.in, out: acc.out + cell.out }), { in: 0, out: 0 });
              const member = memberOf(run, party);
              return (
                <tr key={party}>
                  <th className="party">{member ? <PartyTag name={member.title} tone={memberTone(member, member.live).tone} /> : <PartyTag name={partyName(party, run.members)} />}</th>
                  {components.map((component) => {
                    const cell = row.get(component);
                    const weight = cell ? (cell.in + cell.out) / max : 0;
                    return (
                      <td key={component} className={focus && focus !== component ? "dim" : ""} style={{ ...tint(componentColor(component)), "--w": `${Math.round(10 + weight * 45)}%` } as CSSProperties}>
                        {cell ? (
                          <span className="r-cell">
                            {cell.in ? <span title={t("flow.wrote", { count: cell.in })}>→{cell.in}</span> : null}
                            {cell.out ? <span title={t("flow.got", { count: cell.out })}>←{cell.out}</span> : null}
                          </span>
                        ) : <span className="r-cell none">·</span>}
                      </td>
                    );
                  })}
                  <td className="total"><span className="r-cell plain">→{sum.in} ←{sum.out}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function FlowPage({ run, now, wide }: PageProps) {
  const [component, setComponent] = useState<RunComponent | null>(null);
  const components = componentsOf(run.mode);
  const events = run.events.filter((event) => component === null || event.component === component);
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      <div className="r-chips">
        <Chip on={component === null} onClick={() => setComponent(null)}>{t("flow.filterAll")} {run.events.length}</Chip>
        {components.map((entry) => (
          <Chip key={entry} on={component === entry} color={componentColor(entry)} onClick={() => setComponent(component === entry ? null : entry)}>
            {componentName(entry, run.mode)} {run.events.filter((event) => event.component === entry).length}
          </Chip>
        ))}
      </div>
      {wide ? <FlowMatrix run={run} components={components} focus={component} onFocus={setComponent} /> : <Usage events={events} members={run.members} />}
      <History events={events} members={run.members} mode={run.mode} now={now} title={t("flow.allTitle")} limit={wide ? 60 : 30} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

/** A component's page: what it is, its content, who uses it and its history. */
export function ComponentBody({ run, page, now, wide, onFocusAgent }: PageProps & { page: ComponentPage }) {
  const events: RunEvent[] = run.events.filter((event) => page === "flow" || event.component === page);
  const props: PageProps = { run, now, wide, onFocusAgent };
  const content = (() => {
    switch (page) {
      case "brief": return <BriefPage {...props} />;
      case "tasks": return <TasksPage {...props} />;
      case "plans": return <PlansPage {...props} />;
      case "board": return <BoardPage {...props} />;
      case "claims": return <ClaimsPage {...props} />;
      case "split": return <SplitPage {...props} />;
      case "contexts": return <ContextsPage {...props} />;
      case "reports": return <ReportsPage {...props} />;
      case "summary": return <SummaryPage {...props} />;
      case "flow": return <FlowPage {...props} />;
    }
  })();
  return (
    <div className={`r-page${wide ? " wide" : ""}`} style={tint(page === "flow" ? "var(--flow)" : componentColor(page))}>
      <div className="r-about"><Icon name="info" size={14} /><span>{aboutText(page, run.mode)}</span></div>
      {content}
      {page !== "flow" ? (
        <div className="r-page-foot">
          <Usage events={events} members={run.members} />
          <History events={events} members={run.members} mode={run.mode} now={now} showComponent={false} />
        </div>
      ) : null}
    </div>
  );
}
