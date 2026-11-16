// The run's collaboration components for the panel and the run report: the compact overview (participants, component
// cards, the latest flows) and one component's page.
import { useRef, useState, type CSSProperties } from "react";
import { componentsOf } from "../../shared/flow";
import type { PendingBriefView, RunView } from "../../shared/views";
import { t } from "../i18n";
import { Button, Chip, Empty, Icon, Spinner, useNow } from "../kit";
import { componentColor, EventRow, pageIcon, pageName, SectionTitle, tint, useWidth, type ComponentPage } from "./common";
import { useRunDetail } from "./data";
import { FlowDiagram } from "./diagram";
import { ComponentBody, PendingBrief } from "./pages";

export { COMPONENT_PAGES, type ComponentPage } from "./common";
export { useRunDetail } from "./data";

/** Compact overview for a narrow sidebar (≈300-480px): participants, component cards with live summary + newest event, latest 8 flows, "all flows" link. */
export function RunOverview({ run, pending, onOpen, onFocusAgent }: { run: RunView; pending: PendingBriefView | null; onOpen(page: ComponentPage): void; onFocusAgent?(terminalId: string): void }) {
  const now = useNow();
  const [intakeOpen, setIntakeOpen] = useState(false);
  const latest = [...run.events].reverse().slice(0, 8);
  // A new request's brief waits for the user while the last run is over.
  const intake = pending && !pending.confirmed && run.status === "closed" ? pending : null;
  return (
    <div className="r-overview">
      {intake ? (
        <div className={`r-pending${intakeOpen ? " on" : ""}`} style={tint("var(--c-brief)")}>
          <button type="button" className="r-pending-head" onClick={() => setIntakeOpen((value) => !value)} aria-expanded={intakeOpen}>
            <span className="r-ctile"><Icon name="file-text" size={14} /></span>
            <span className="grow">
              <span className="r-pending-title">{t("flow.brief.pendingTitle")}</span>
              <span className="r-pending-sub ellipsis">{intake.brief.title} · {intake.brief.goal}</span>
            </span>
            <span className="r-live-dot" />
            <Icon name={intakeOpen ? "down" : "right"} size={14} style={{ color: "var(--muted-fg)" }} />
          </button>
          {intakeOpen ? <PendingBrief pending={intake} now={now} /> : null}
        </div>
      ) : null}
      <FlowDiagram run={run} pending={pending} now={now} onOpen={onOpen} onFocusAgent={onFocusAgent} hint={false} />
      <section className="r-overview-flows">
        <SectionTitle icon="activity">{t("flow.recent")}</SectionTitle>
        {latest.length ? (
          <div className="r-events">
            {latest.map((event) => <EventRow key={event.seq} event={event} members={run.members} mode={run.mode} now={now} onOpen={() => onOpen(event.component)} />)}
          </div>
        ) : (
          <div className="r-empty-line">{t("flow.none")}</div>
        )}
        {run.events.length ? (
          <button type="button" className="r-link" onClick={() => onOpen("flow")}>
            {t("flow.viewAll", { count: run.events.length })} <Icon name="arrow-right" size={12} />
          </button>
        ) : null}
      </section>
    </div>
  );
}

/** One component's page (or "flow" = all flows); fetches the full run with call("runDetail", { runId }) and refreshes on onChanged. compact = sidebar width. */
export function ComponentDetail({ runId, page, compact, onBack, onOpen, onFocusAgent }: { runId: string; page: ComponentPage; compact?: boolean; onBack?(): void; onOpen(page: ComponentPage): void; onFocusAgent?(terminalId: string): void }) {
  const { run, loading, error, refresh } = useRunDetail(runId);
  const now = useNow();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const wide = !compact && width >= 760;
  const mode = run?.mode ?? "team";
  const siblings: ComponentPage[] = run ? [...componentsOf(run.mode), "flow"] : [];
  return (
    <div ref={box} className={`r-detail${compact ? " compact" : ""}`}>
      <header className="r-detail-head">
        {onBack ? <Button icon="left" size="sm" variant="ghost" onClick={onBack}>{t("flow.back")}</Button> : null}
        <span className="r-ctile big" style={tint(page === "flow" ? "var(--flow)" : componentColor(page))}><Icon name={pageIcon(page)} size={16} /></span>
        <h2 className="h2 grow ellipsis">{pageName(page, mode)}</h2>
      </header>
      {siblings.length > 1 ? (
        <div className="r-chips scroll-x">
          {siblings.map((entry) => (
            <Chip key={entry} on={entry === page} color={entry === "flow" ? "var(--flow)" : componentColor(entry)} onClick={() => onOpen(entry)}>
              <Icon name={pageIcon(entry)} size={12} />
              {pageName(entry, mode)}
            </Chip>
          ))}
        </div>
      ) : null}
      {loading && !run ? (
        <div className="r-center"><Spinner /> <span className="muted">{t("report.loading")}</span></div>
      ) : error && !run ? (
        <div className="r-callout" style={{ "--tone": "var(--bad)" } as CSSProperties}>
          <Icon name="alert" size={15} />
          <div className="grow">{t("report.error", { error })}</div>
          <Button size="sm" icon="refresh" onClick={() => void refresh()}>{t("app.retry")}</Button>
        </div>
      ) : !run ? (
        <Empty icon="alert">{t("report.notFound", { id: runId })}</Empty>
      ) : (
        <ComponentBody run={run} page={page} now={now} wide={wide} onFocusAgent={onFocusAgent} />
      )}
    </div>
  );
}
