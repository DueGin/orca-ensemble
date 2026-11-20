// The Session tab: one lead session of the focused workspace, its mode, the brief waiting for confirmation, its members
// and the run's data flow, with a page per component.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { TEAM_MODES, type TeamMode } from "../../shared/modes";
import { runtimeLabel } from "../../shared/team";
import type { AppState, LeadView } from "../../shared/views";
import { t } from "../i18n";
import { AgentAvatar, Badge, Button, Dot, Empty, Icon, Segmented, stateTone, useNow } from "../kit";
import { call } from "../orca";
import { ComponentDetail, RunOverview, type ComponentPage } from "../run";

const tone = (value: string) => ({ "--tone": value }) as CSSProperties;

function ago(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 60) return t("flow.ago.seconds", { count: seconds });
  if (seconds < 3600) return t("flow.ago.minutes", { count: Math.round(seconds / 60) });
  return t("flow.ago.hours", { count: Math.round(seconds / 3600) });
}

function stateLabel(lead: LeadView): string {
  return t(`app.state.${lead.state}`);
}

function SessionCard({ lead, refresh }: { lead: LeadView; refresh(): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setMode = (mode: TeamMode) => {
    if (busy || lead.locked) return;
    setBusy(true);
    setError(null);
    void call("setMode", { terminalId: lead.terminalId, mode })
      .then((result) => (result.ok ? refresh() : setError(result.error ?? "")))
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(false));
  };
  const lockedMode = lead.locked ? t(`mode.${lead.locked}`) : null;
  return (
    <div className="card stack" style={{ "--gap": "10px" } as CSSProperties}>
      <div className="row top between">
        <div className="stack grow" style={{ "--gap": "2px" } as CSSProperties}>
          <div className="row" style={{ "--gap": "6px" } as CSSProperties}>
            <span className="tile" style={tone("var(--primary)")}><Icon name="crown" /></span>
            <span className="h3 ellipsis">{lead.teamTitle}</span>
            {lead.team.preset ? <Badge tone="var(--c-split)">{lead.team.preset.name}</Badge> : null}
          </div>
          <span className="tiny muted ellipsis">
            {t("app.lead")} · {runtimeLabel(lead.team.lead)} · {lead.source === "preset" ? t("app.start.fromPreset") : lead.source === "inline" ? "inline" : lead.source}
          </span>
        </div>
        <div className="row" style={{ "--gap": "4px" } as CSSProperties}>
          <Badge tone={lead.ended ? "var(--muted-fg)" : stateTone(lead.state)}>
            <Dot tone={lead.ended ? "var(--muted-fg)" : stateTone(lead.state)} live={lead.state === "working"} />
            {stateLabel(lead)}
          </Badge>
          {!lead.ended ? <Button icon="terminal" size="sm" variant="ghost" title={t("app.focus")} onClick={() => void call("focus", { terminalId: lead.terminalId })} /> : null}
        </div>
      </div>
      <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
        <div className="row between">
          <span className="label">{t("mode.label")}</span>
          {lead.locked ? <Badge tone="var(--warn)"><Icon name="lock" size={11} />{t("app.lockedBadge")}</Badge> : lead.override === null ? <span className="tiny muted">{t("mode.fromFile")}</span> : null}
        </div>
        <Segmented<TeamMode>
          stretch
          value={lead.effective}
          disabled={busy || lead.locked !== null || lead.ended}
          onChange={setMode}
          options={TEAM_MODES.map((mode) => ({ value: mode, label: t(`mode.${mode}`), title: t(`mode.${mode}Hint`) }))}
        />
        <span className="tiny muted">{lockedMode ? t("app.modeLocked", { mode: lockedMode }) : t(`mode.${lead.effective}Hint`)}</span>
        {error ? <span className="tiny bad">{t("app.modeSwitchFailed", { error })}</span> : null}
      </div>
    </div>
  );
}

function BriefCallout({ lead, refresh }: { lead: LeadView; refresh(): void }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const pending = lead.pendingBrief;
  if (!pending) return null;
  const confirmed = pending.confirmed || state === "done";
  return (
    <div className="callout stack" style={{ ...tone("var(--c-brief)"), "--gap": "8px" } as CSSProperties}>
      <div className="row between">
        <div className="row" style={{ "--gap": "6px" } as CSSProperties}>
          <Dot tone="var(--c-brief)" live={!confirmed} />
          <span className="strong">{t("flow.brief.pendingTitle")}</span>
        </div>
        <span className="tiny muted">{pending.tasks.length} {t("flow.brief.plannedTasks")}</span>
      </div>
      <div className="strong">{pending.brief.title}</div>
      <div className="small clamp3">{pending.brief.goal}</div>
      {pending.brief.acceptance.length ? (
        <div className="stack" style={{ "--gap": "2px" } as CSSProperties}>
          <span className="label">{t("flow.brief.acceptance")}</span>
          {pending.brief.acceptance.slice(0, 4).map((item, index) => <span key={index} className="small">• {item}</span>)}
        </div>
      ) : null}
      <span className="tiny muted">{t("flow.brief.roles")}: {pending.roles.join(", ")} · {t("flow.brief.rounds")}: {pending.rounds}{pending.planApproval ? ` · ${t("flow.brief.planApproval")}` : ""}</span>
      {confirmed ? (
        <span className="small ok row"><Icon name="check" />{t("app.confirmed")}</span>
      ) : (
        <>
          <Button variant="primary" icon="play" block disabled={state === "busy" || lead.ended} onClick={() => {
            setState("busy");
            void call("confirmBrief", { terminalId: lead.terminalId }).then(() => { setState("done"); refresh(); }, () => setState("idle"));
          }}>{t("app.confirm")}</Button>
          <span className="tiny muted">{t("app.confirmHint")}</span>
        </>
      )}
    </div>
  );
}

function Members({ lead }: { lead: LeadView }) {
  const runMembers = lead.run?.members ?? [];
  const rows = lead.members.map((member) => {
    const inRun = runMembers.find((entry) => entry.agentId === member.terminalId);
    return { ...member, runState: inRun?.state ?? null, retired: inRun?.retired ?? false };
  });
  return (
    <div className="stack" style={{ "--gap": "6px" } as CSSProperties}>
      <span className="label">{t("app.members")} · {rows.length}</span>
      {rows.length ? (
        <div className="stack" style={{ "--gap": "4px" } as CSSProperties}>
          {rows.map((member) => {
            const state = member.runState === "attention" ? "blocked" : member.state;
            return (
              <button key={member.terminalId} type="button" className="card click row" style={{ padding: "6px 8px", textAlign: "left", opacity: member.retired ? 0.55 : 1 } as CSSProperties} onClick={() => void call("focus", { terminalId: member.terminalId })} title={t("app.focus")}>
                <span className="member-avatar" style={{ "--tone": stateTone(state) } as CSSProperties}>
                  <AgentAvatar agent={member.agent} model={member.model} size={22} title={`${member.agent}${member.model ? ` · ${member.model}` : ""}`} />
                  <span className={`member-state${state === "working" ? " live" : ""}`} />
                </span>
                <span className="grow stack" style={{ "--gap": "0px" } as CSSProperties}>
                  <span className="small strong ellipsis">{member.title}</span>
                  <span className="tiny muted ellipsis">{member.agent}{member.model ? `/${member.model}` : ""}</span>
                </span>
                <span className="tiny muted">{member.retired ? t("session.retired") : t(`app.state.${state === "blocked" ? "blocked" : state === "working" ? "working" : state === "unknown" ? "unknown" : "done"}`)}</span>
                <Icon name="terminal" size={12} style={{ color: "var(--muted-fg)" }} />
              </button>
            );
          })}
        </div>
      ) : (
        <span className="small muted">{t("app.noMembers")}</span>
      )}
    </div>
  );
}

function RunSection({ lead }: { lead: LeadView }) {
  const [page, setPage] = useState<ComponentPage | null>(null);
  const run = lead.run;
  useEffect(() => setPage(null), [run?.id]);
  if (!run) return lead.pendingBrief ? null : <span className="small muted">{t("session.noRun")}</span>;
  if (page) {
    return <ComponentDetail runId={run.id} page={page} compact onBack={() => setPage(null)} onOpen={setPage} onFocusAgent={(terminalId) => void call("focus", { terminalId })} />;
  }
  return (
    <div className="stack" style={{ "--gap": "8px" } as CSSProperties}>
      <RunOverview run={run} pending={lead.pendingBrief} onOpen={setPage} onFocusAgent={(terminalId) => void call("focus", { terminalId })} />
      <div className="row between">
        <Button icon="external" size="sm" onClick={() => void call("openReport", { runId: run.id })}>{t("app.openReport")}</Button>
        {lead.runCount > 1 ? <span className="tiny muted">{t("app.runs", { count: lead.runCount })}</span> : null}
      </div>
    </div>
  );
}

export function SessionTab({ state, selected, onSelect, onStart, refresh }: { state: AppState; selected: string | null; onSelect(terminalId: string): void; onStart(): void; refresh(): void }) {
  const now = useNow(10_000);
  const [showEnded, setShowEnded] = useState(false);
  const focusedPath = state.focused?.path ?? null;
  const here = state.leads.filter((lead) => lead.path === focusedPath && (showEnded || !lead.ended));
  const others = state.leads.filter((lead) => lead.path !== focusedPath && (showEnded || !lead.ended));
  const current = useMemo(() => state.leads.find((lead) => lead.terminalId === selected) ?? here.find((lead) => !lead.ended) ?? here[0] ?? others.find((lead) => !lead.ended) ?? null, [state, selected, here, others]);
  if (!current) {
    return (
      <div className="stack">
        <Empty icon="users">{t("app.noSession")}</Empty>
        <Button variant="primary" icon="play" block onClick={onStart}>{t("app.start.title")}</Button>
      </div>
    );
  }
  const pickable = [...here, ...others];
  return (
    <div className="stack" style={{ "--gap": "12px" } as CSSProperties}>
      {pickable.length > 1 ? (
        <select className="select" value={current.terminalId} onChange={(event) => onSelect(event.target.value)}>
          {pickable.map((lead) => (
            <option key={lead.terminalId} value={lead.terminalId}>
              {lead.teamTitle} · {lead.workspaceName} · {lead.ended ? t("app.ended") : t(`app.state.${lead.state}`)} · {ago(lead.createdAt, now)}
            </option>
          ))}
        </select>
      ) : null}
      <SessionCard lead={current} refresh={refresh} />
      <BriefCallout lead={current} refresh={refresh} />
      <Members lead={current} />
      <RunSection lead={current} />
      <div className="sep" />
      <div className="row between">
        <label className="row tiny muted" style={{ "--gap": "6px", cursor: "pointer" } as CSSProperties}>
          <input type="checkbox" checked={showEnded} onChange={(event) => setShowEnded(event.target.checked)} />
          {t("app.showEnded")}
        </label>
        {current.ended ? null : <Button size="sm" variant="ghost" icon="x" onClick={() => void call("endSession", { terminalId: current.terminalId }).then(refresh)}>{t("app.endSession")}</Button>}
      </div>
    </div>
  );
}
