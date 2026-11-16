// The data-flow diagram: who takes part on the left, the mode's components on the right, and the latest flows between
// them as lines (an arrow shows where the data goes; a moving dot, a flow of the last 30 seconds). Narrow, it stacks the
// participants as chips above the component cards and draws no lines.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { componentsOf, type RunComponent, type RunEvent } from "../../shared/flow";
import type { PendingBriefView, RunView } from "../../shared/views";
import { t } from "../i18n";
import { Icon, TONE } from "../kit";
import { agoText, COMPONENT_ICON, componentColor, componentName, describeEvent, LIVE_MS, liveText, memberTone, partyName, summaryOf, tint, useWidth, type ComponentPage } from "./common";

type Link = { party: string; component: RunComponent; direction: "in" | "out"; count: number; live: boolean };

/** Flows among the latest events, per party, component and direction. */
function linksOf(events: readonly RunEvent[], parties: ReadonlySet<string>, now: number): Link[] {
  const links = new Map<string, Link>();
  for (const event of events) {
    const ends = event.direction === "in" ? [event.from] : event.to;
    for (const party of ends.filter((end) => parties.has(end))) {
      const key = `${party}|${event.component}|${event.direction}`;
      const link = links.get(key);
      const live = now - Date.parse(event.at) < LIVE_MS;
      links.set(key, { party, component: event.component, direction: event.direction, count: (link?.count ?? 0) + event.count, live: (link?.live ?? false) || live });
    }
  }
  return [...links.values()];
}

/** The parties to draw: the user when it took part lately, the lead, the members, and the plugin when it wrote lately. */
function partiesOf(run: RunView, recent: readonly RunEvent[]): string[] {
  const members = run.members.filter((member) => !member.retired || recent.some((event) => event.from === member.agentId || event.to.includes(member.agentId)));
  return [
    ...(recent.some((event) => event.from === "user" || event.to.includes("user")) ? ["user"] : []),
    "lead",
    ...members.map((member) => member.agentId),
    // The plugin only shows when it wrote into a part itself; what it hands out is drawn from the part.
    ...(recent.some((event) => event.from === "plugin" && event.direction === "in") ? ["plugin"] : []),
  ];
}

const partyIcon = (party: string) => (party === "user" ? "user" : party === "lead" ? "crown" : party === "plugin" ? "plug" : "bot");

export interface DiagramProps {
  run: RunView;
  pending: PendingBriefView | null;
  now: number;
  /** Orca's live state per member terminal. */
  live?: Record<string, string | null>;
  /** The lead's terminal, to show it in Orca. */
  leadId?: string | null;
  /** The component whose page is open below. */
  selected?: ComponentPage | null;
  onOpen(page: ComponentPage): void;
  onFocusAgent?(terminalId: string): void;
  /** Shown as a column to the right of the cards when there is room. */
  aside?: ReactNode;
  /** Narrower than this, the participants stack above the cards. */
  stackBelow?: number;
  /** Events to draw lines for: the latest this many. */
  window?: number;
  hint?: boolean;
}

type Point = { x: number; top: number; bottom: number };
type Geometry = { width: number; height: number; parties: Record<string, Point>; cards: Record<string, Point> };

export function FlowDiagram({ run, pending, now, live, leadId, selected, onOpen, onFocusAgent, aside, stackBelow = 520, window: span = 18, hint = true }: DiagramProps) {
  const outer = useRef<HTMLDivElement>(null);
  const width = useWidth(outer);
  const stacked = width > 0 && width < stackBelow;
  const withAside = !!aside && width >= 1080;
  const components = componentsOf(run.mode);
  const recent = useMemo(() => run.events.slice(-span), [run.events, span]);
  const parties = partiesOf(run, recent);
  const links = linksOf(recent, new Set(parties), now);
  const liveComponents = new Set(links.filter((link) => link.live).map((link) => link.component));
  const anyLive = liveComponents.size > 0;
  const [hot, setHot] = useState<string | null>(null);

  const stateOf = (party: string) => {
    const member = run.members.find((entry) => entry.agentId === party);
    if (!member) return { tone: party === "lead" ? "var(--lead)" : TONE.idle, pulse: false, text: "" };
    const state = live?.[party];
    // Orca's live state says what the agent does right now; the run's state is the fallback.
    return { ...memberTone(member, state), text: member.retired ? t("session.retired") : state ? liveText(state) : t(`session.state.${member.state}`) };
  };
  const focusId = (party: string) => (party === "lead" ? leadId ?? null : run.members.some((member) => member.agentId === party) ? party : null);

  // Measured anchors: the right edge of each participant, the left edge of each card, relative to the grid.
  const grid = useRef<HTMLDivElement>(null);
  const partyNodes = useRef(new Map<string, HTMLElement>());
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const measure = useCallback(() => {
    const box = grid.current;
    if (!box) return;
    const origin = box.getBoundingClientRect();
    const read = (nodes: Map<string, HTMLElement>, edge: "left" | "right") => {
      const points: Record<string, Point> = {};
      for (const [key, node] of nodes) {
        if (!node.isConnected) continue;
        const rect = node.getBoundingClientRect();
        points[key] = { x: Math.round(rect[edge] - origin.left), top: Math.round(rect.top - origin.top), bottom: Math.round(rect.bottom - origin.top) };
      }
      return points;
    };
    const next: Geometry = { width: Math.round(origin.width), height: Math.round(origin.height), parties: read(partyNodes.current, "right"), cards: read(cardNodes.current, "left") };
    setGeometry((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, []);
  // Every render may move a card (a summary wraps, a member joins); the observer catches resizes in between.
  useLayoutEffect(() => {
    if (!stacked) measure();
  });
  useLayoutEffect(() => {
    const box = grid.current;
    if (stacked || !box) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    return () => observer.disconnect();
  }, [stacked, measure]);

  const header = (
    <div className="r-diagram-head">
      <span className="label">{t("flow.title")}</span>
      {anyLive ? <span className="r-live-pill"><span className="r-live-dot" />{t("flow.live")}</span> : null}
    </div>
  );

  const card = (component: RunComponent) => (
    <ComponentCard
      key={component}
      component={component}
      run={run}
      pending={pending}
      now={now}
      live={liveComponents.has(component)}
      selected={selected === component}
      dim={hot !== null && hot !== component && !links.some((link) => link.component === component && link.party === hot)}
      onOpen={() => onOpen(component)}
      onHover={(on) => setHot(on ? component : null)}
      nodeRef={(node) => { if (node) cardNodes.current.set(component, node); else cardNodes.current.delete(component); }}
    />
  );

  if (stacked) {
    return (
      <div ref={outer} className="r-diagram stacked">
        {header}
        <div className="r-chips">
          {parties.map((party) => {
            const state = stateOf(party);
            const id = focusId(party);
            const linked = links.filter((link) => link.party === party);
            return (
              <button key={party} type="button" className={`r-party-chip${party === "lead" ? " lead" : ""}`} disabled={!id || !onFocusAgent} onClick={() => id && onFocusAgent?.(id)} title={id && onFocusAgent ? t("report.focus") : state.text || undefined}>
                <span className={`dot${state.pulse ? " live" : ""}`} style={{ "--tone": state.tone } as CSSProperties} />
                <span className="ellipsis">{partyName(party, run.members)}</span>
                {linked.some((link) => link.live) ? <span className="r-live-dot small" /> : null}
              </button>
            );
          })}
        </div>
        <div className="r-cards">{components.map(card)}</div>
      </div>
    );
  }

  // Each card and participant spreads its lines over its own height, ordered by where the other end sits.
  const lines: { link: Link; x1: number; y1: number; x2: number; y2: number }[] = [];
  if (geometry) {
    const ready = links.filter((link) => geometry.parties[link.party] && geometry.cards[link.component]);
    const mid = (point: Point) => (point.top + point.bottom) / 2;
    const spread = (point: Point, index: number, total: number) => {
      if (total <= 1) return mid(point);
      const pad = Math.min(12, (point.bottom - point.top) / 4);
      return point.top + pad + ((point.bottom - point.top - pad * 2) * index) / (total - 1);
    };
    const order = (a: Link, b: Link) => a.direction.localeCompare(b.direction);
    const atParty = new Map<string, Link[]>();
    const atCard = new Map<string, Link[]>();
    for (const link of ready) {
      atParty.set(link.party, [...(atParty.get(link.party) ?? []), link]);
      atCard.set(link.component, [...(atCard.get(link.component) ?? []), link]);
    }
    for (const list of atParty.values()) list.sort((a, b) => mid(geometry.cards[a.component]!) - mid(geometry.cards[b.component]!) || order(a, b));
    for (const list of atCard.values()) list.sort((a, b) => mid(geometry.parties[a.party]!) - mid(geometry.parties[b.party]!) || order(a, b));
    for (const link of ready) {
      const party = geometry.parties[link.party]!;
      const card = geometry.cards[link.component]!;
      const fromList = atParty.get(link.party)!;
      const toList = atCard.get(link.component)!;
      lines.push({ link, x1: party.x + 6, y1: spread(party, fromList.indexOf(link), fromList.length), x2: card.x - 6, y2: spread(card, toList.indexOf(link), toList.length) });
    }
  }

  return (
    <div ref={outer} className="r-diagram">
      {header}
      {hint ? <div className="r-diagram-hint">{t("flow.hint")}</div> : null}
      <div ref={grid} className={`r-diagram-grid${withAside ? " with-aside" : ""}`}>
        <div className="r-parties">
          {parties.map((party) => {
            const state = stateOf(party);
            const id = focusId(party);
            const member = run.members.find((entry) => entry.agentId === party);
            return (
              <button
                key={party}
                ref={(node) => { if (node) partyNodes.current.set(party, node); else partyNodes.current.delete(party); }}
                type="button"
                className={`r-party${party === "lead" ? " lead" : ""}${member?.retired ? " retired" : ""}${hot !== null && hot !== party && !links.some((link) => link.party === party && link.component === hot) ? " dim" : ""}`}
                disabled={!id || !onFocusAgent}
                onClick={() => id && onFocusAgent?.(id)}
                onMouseEnter={() => setHot(party)}
                onMouseLeave={() => setHot(null)}
                title={id && onFocusAgent ? t("report.focus") : undefined}
              >
                <span className="r-party-icon" style={{ "--tone": state.tone } as CSSProperties}><Icon name={partyIcon(party)} size={13} /></span>
                <span className="r-party-text">
                  <span className="r-party-name ellipsis">{partyName(party, run.members)}</span>
                  {member ? (
                    <span className="r-party-sub ellipsis">
                      <span className={`dot${state.pulse ? " live" : ""}`} style={{ "--tone": state.tone } as CSSProperties} />
                      {member.role} · {state.text}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className="r-gap" aria-hidden />
        <div className="r-cards">{components.map(card)}</div>
        {withAside ? <div className="r-diagram-aside">{aside}</div> : null}
        {geometry ? (
          <svg className="r-flow-svg" width={geometry.width} height={geometry.height} aria-hidden>
            {lines.map(({ link, x1, y1, x2, y2 }) => {
              const [sx, sy, ex, ey] = link.direction === "in" ? [x1, y1, x2, y2] : [x2, y2, x1, y1];
              const dir = Math.sign(ex - sx) || 1;
              const tipX = ex;
              const endX = ex - 6 * dir;
              const bend = (endX - sx) / 2;
              const d = `M${sx},${sy} C${sx + bend},${sy} ${endX - bend},${ey} ${endX},${ey}`;
              const head = `M${tipX},${ey} L${tipX - 7 * dir},${ey - 4} L${tipX - 7 * dir},${ey + 4} Z`;
              const isHot = hot !== null && (hot === link.party || hot === link.component);
              const dim = hot !== null && !isHot;
              const strokeWidth = Math.min(3.2, 1.2 + Math.log2(link.count) * 0.45);
              return (
                <g key={`${link.party}|${link.component}|${link.direction}`} className={`r-fl${link.live ? " live" : ""}${dim ? " dim" : ""}${isHot ? " hot" : ""}`} style={tint(componentColor(link.component))}>
                  <path d={d} className="r-fl-path" strokeWidth={strokeWidth} />
                  <path d={head} className="r-fl-head" />
                  {link.live ? (
                    <circle r={3.4} className="r-fl-packet">
                      <animateMotion dur="1.5s" repeatCount="indefinite" path={d} />
                    </circle>
                  ) : null}
                  {isHot ? (
                    <text x={(sx + ex) / 2} y={(sy + ey) / 2 - 5} textAnchor="middle" className="r-fl-count">{link.direction === "in" ? "→" : "←"} {link.count}</text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>
    </div>
  );
}

function ComponentCard({ component, run, pending, now, live, selected, dim, onOpen, onHover, nodeRef }: { component: RunComponent; run: RunView; pending: PendingBriefView | null; now: number; live: boolean; selected: boolean; dim: boolean; onOpen(): void; onHover(on: boolean): void; nodeRef(node: HTMLElement | null): void }) {
  const last = [...run.events].reverse().find((event) => event.component === component);
  const total = run.tasks.filter((task) => task.state !== "dropped").length;
  const progress = (component === "tasks" || component === "split") && total > 0;
  const done = run.tasks.filter((task) => task.state === "done").length;
  return (
    <button
      ref={nodeRef}
      type="button"
      className={`r-ccard${live ? " live" : ""}${selected ? " on" : ""}${dim ? " dim" : ""}`}
      style={tint(componentColor(component))}
      onClick={onOpen}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      aria-label={`${componentName(component, run.mode)}: ${t("flow.details")}`}
    >
      <span className="r-ccard-head">
        <span className="r-ctile"><Icon name={COMPONENT_ICON[component]} size={14} /></span>
        <span className="r-ccard-name ellipsis">{componentName(component, run.mode)}</span>
        {live ? <span className="r-live-dot" /> : null}
        <Icon name="right" size={14} style={{ color: "var(--muted-fg)" }} />
      </span>
      <span className="r-ccard-sum ellipsis">{summaryOf(component, run, pending)}</span>
      {progress ? (
        <span className="r-ccard-bar"><span style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
      ) : null}
      {last ? (
        <span className="r-ccard-last">
          <span className="ellipsis">{describeEvent(last, run.members)}</span>
          <span className="r-ccard-ago">{agoText(last.at, now)}</span>
        </span>
      ) : null}
    </button>
  );
}
