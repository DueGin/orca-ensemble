// The run report: an Orca editor tab for `*.team-run.json` files (`{ "agentTeamRun": "<run id>" }`). It reads the run
// from the plugin's worker and shows it full width: the header, the members, the data-flow diagram and a page per
// component. It never edits the file.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { componentsOf } from "../shared/flow";
import type { RunDetail } from "../shared/views";
import { t } from "./i18n";
import { Badge, Button, Empty, Icon, Spinner, TONE, useNow } from "./kit";
import { call, orca } from "./orca";
import { agoText, componentColor, durationText, EventRow, leadIdOf, liveText, memberTone, overviewOf, pageIcon, pageName, PartyTag, SectionTitle, timeText, tint, useWidth, type ComponentPage } from "./run/common";
import { useRunDetail } from "./run/data";
import { FlowDiagram } from "./run/diagram";
import { ComponentBody } from "./run/pages";

/** The run id a report file names; null when the file names none. */
function runIdOf(text: string): string | null {
  try {
    const value = (JSON.parse(text) as { agentTeamRun?: unknown }).agentTeamRun;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function focusAgent(terminalId: string) {
  call("focus", { terminalId }).catch((error) => console.warn("[ensemble] focus failed", error));
}

function App() {
  const [runId, setRunId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const doc = orca()?.document;
    if (!doc) {
      setRunId(null);
      return;
    }
    let alive = true;
    doc.get().then((value) => { if (alive) setRunId(runIdOf(value.content.text)); }).catch(() => { if (alive) setRunId(null); });
    const subscription = doc.onDidChange((value) => setRunId(runIdOf(value.content.text)));
    return () => {
      alive = false;
      subscription.dispose();
    };
  }, []);
  if (runId === undefined) return <div className="r-center full"><Spinner /> <span className="muted">{t("report.loading")}</span></div>;
  if (runId === null) return <div className="r-center full"><Empty icon="alert">{t("report.badFile")}</Empty></div>;
  return <Report key={runId} runId={runId} />;
}

function Report({ runId }: { runId: string }) {
  const { run, loading, error, refresh, loadedAt } = useRunDetail(runId);
  const now = useNow(2000);
  const box = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [page, setPage] = useState<ComponentPage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const view = useMemo(() => (run ? overviewOf(run) : null), [run]);
  const live = useMemo(() => Object.fromEntries((run?.members ?? []).map((member) => [member.agentId, member.live])), [run]);

  if (!run || !view) {
    return (
      <div ref={box} className="r-root">
        {loading ? <div className="r-center full"><Spinner /> <span className="muted">{t("report.loading")}</span></div> : null}
        {!loading && error ? (
          <div className="r-center full">
            <div className="r-callout" style={{ "--tone": "var(--bad)", maxWidth: 520 } as CSSProperties}>
              <Icon name="alert" size={15} />
              <div className="grow">{t("report.error", { error })}</div>
              <Button size="sm" icon="refresh" onClick={() => void refresh()}>{t("app.retry")}</Button>
            </div>
          </div>
        ) : null}
        {!loading && !error ? <div className="r-center full"><Empty icon="alert">{t("report.notFound", { id: runId })}</Empty></div> : null}
      </div>
    );
  }

  const pages: ComponentPage[] = [...componentsOf(run.mode), "flow"];
  const current = page && pages.includes(page) ? page : pages[0]!;
  const leadId = leadIdOf(run);
  const open = (next: ComponentPage) => {
    setPage(next);
    // Bring the page into view when it is below the fold.
    const node = tabs.current;
    if (node && node.getBoundingClientRect().top > window.innerHeight - 160) node.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const doRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };
  const latest = [...run.events].reverse().slice(0, 12);
  const countOf = (entry: ComponentPage) => (entry === "flow" ? run.events.length : run.events.filter((event) => event.component === entry).length);

  return (
    <div ref={box} className={`r-root${width < 640 ? " narrow" : ""}`}>
      <Header run={run} now={now} leadId={leadId} refreshing={refreshing} loadedAt={loadedAt} onRefresh={doRefresh} />
      <Members run={run} />
      <section className="r-panel r-diagram-panel">
        <FlowDiagram
          run={view}
          pending={null}
          now={now}
          live={live}
          leadId={leadId}
          selected={current}
          onOpen={open}
          onFocusAgent={focusAgent}
          window={24}
          aside={
            <div className="r-aside-flows">
              <SectionTitle icon="activity">{t("flow.recent")}</SectionTitle>
              <div className="r-events">
                {latest.map((event) => <EventRow key={event.seq} event={event} members={run.members} mode={run.mode} now={now} onOpen={() => open(event.component)} />)}
              </div>
              {!latest.length ? <div className="r-empty-line">{t("flow.none")}</div> : null}
              {run.events.length > latest.length ? <button type="button" className="r-link" onClick={() => open("flow")}>{t("flow.viewAll", { count: run.events.length })} <Icon name="arrow-right" size={12} /></button> : null}
            </div>
          }
        />
      </section>
      <nav ref={tabs} className="r-tabs" role="tablist">
        {pages.map((entry) => (
          <button key={entry} type="button" role="tab" aria-selected={entry === current} className={entry === current ? "on" : ""} style={tint(entry === "flow" ? "var(--flow)" : componentColor(entry))} onClick={() => setPage(entry)}>
            <Icon name={pageIcon(entry)} size={14} />
            <span>{pageName(entry, run.mode)}</span>
            <span className="r-tab-count">{countOf(entry)}</span>
          </button>
        ))}
      </nav>
      <ComponentBody run={run} page={current} now={now} wide={width >= 760} onFocusAgent={focusAgent} />
    </div>
  );
}

function Header({ run, now, leadId, refreshing, loadedAt, onRefresh }: { run: RunDetail; now: number; leadId: string | null; refreshing: boolean; loadedAt: number; onRefresh(): void }) {
  const active = run.status === "active";
  const end = active ? now : Date.parse(run.updatedAt);
  return (
    <header className="r-head">
      <div className="r-head-main">
        <span className="r-head-icon" style={tint(run.mode === "team" ? "var(--c-tasks)" : "var(--c-split)")}><Icon name={run.mode === "team" ? "users" : "split"} size={20} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h1 className="r-title" title={run.title}>{run.title}</h1>
          <div className="r-head-badges">
            <Badge tone={run.mode === "team" ? "var(--c-tasks)" : "var(--c-split)"}>{t(`report.modeTag.${run.mode}`)}</Badge>
            <span className={`r-status${active ? " active" : ""}`}>
              <span className={`dot${active ? " live" : ""}`} style={{ "--tone": active ? TONE.working : TONE.idle } as CSSProperties} />
              {active ? t("report.active") : t("report.closed")}
            </span>
            <Badge>{run.mode === "team" ? t("session.round", { round: run.round, rounds: run.rounds }) : t("session.batch", { round: run.round })}</Badge>
            {run.planApproval ? <Badge tone="var(--c-plans)"><Icon name="clipboard" size={11} />{t("session.planApprovalOn")}</Badge> : null}
          </div>
        </div>
        <div className="r-head-actions">
          {loadedAt ? <span className="tiny muted" title={new Date(loadedAt).toLocaleTimeString()}>{t("report.refreshed", { ago: agoText(new Date(loadedAt).toISOString(), now) })}</span> : null}
          <Button icon="refresh" size="sm" onClick={onRefresh} disabled={refreshing}>{t("report.refresh")}</Button>
        </div>
      </div>
      <dl className="r-head-facts">
        <div><dt>{t("report.runId")}</dt><dd className="mono">{run.id}</dd></div>
        <div><dt>{t("report.lead")}</dt><dd><PartyTag name={t("flow.lead")} tone="var(--lead)" onClick={leadId ? () => focusAgent(leadId) : undefined} /></dd></div>
        <div><dt>{t("report.language")}</dt><dd>{t(`report.lang.${run.language}`)}</dd></div>
        <div><dt>{t("report.created")}</dt><dd>{timeText(run.createdAt)}</dd></div>
        <div><dt>{t("report.updated")}</dt><dd title={new Date(run.updatedAt).toLocaleString()}>{agoText(run.updatedAt, now)}</dd></div>
        <div><dt>{active ? t("report.runningFor") : t("report.lasted")}</dt><dd>{durationText(end - Date.parse(run.createdAt))}</dd></div>
      </dl>
      {run.reason ? <div className="r-reason"><span className="r-field-label">{t("report.reason")}</span> <span>{run.reason}</span></div> : null}
    </header>
  );
}

function Members({ run }: { run: RunDetail }) {
  return (
    <section className="r-members">
      <SectionTitle icon="users" right={<span className="tiny muted">{run.members.filter((member) => !member.retired).length}</span>}>{t("app.members")}</SectionTitle>
      {!run.members.length ? <div className="r-empty-line">{t("app.noMembers")}</div> : null}
      <div className="r-members-row">
        {run.members.map((member) => {
          const { tone, pulse } = memberTone(member, member.live);
          const runtime = member.agent ? (member.model ? `${member.agent} · ${member.model}` : member.agent) : null;
          return (
            <button key={member.agentId} type="button" className={`r-member${member.retired ? " retired" : ""}`} onClick={() => focusAgent(member.agentId)} title={t("report.focus")}>
              <span className="r-member-avatar" style={{ "--tone": tone } as CSSProperties}>
                <Icon name="bot" size={15} />
                <span className={`r-member-dot${pulse ? " live" : ""}`} />
              </span>
              <span className="r-member-text">
                <span className="r-member-line">
                  <span className="r-member-name ellipsis">{member.title}</span>
                  <span className="r-member-state" style={{ "--tone": tone } as CSSProperties} title={member.live ? `${t("report.liveState")}: ${liveText(member.live)} · ${t(`session.state.${member.state}`)}` : undefined}>
                    {member.retired ? t("session.retired") : member.live ? liveText(member.live) : t(`session.state.${member.state}`)}
                  </span>
                  <Icon name="terminal" size={12} style={{ color: "var(--muted-fg)" }} />
                </span>
                <span className="r-member-sub ellipsis" title={runtime ?? undefined}>{member.role}{runtime ? <> · <span className="mono">{runtime}</span></> : null}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
