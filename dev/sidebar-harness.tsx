// Renders RunOverview and ComponentDetail in sidebar-width columns: ?run=<id>&pages=tasks,board&width=360&pending=1
import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { PendingBriefView, RunDetail } from "../src/shared/views";
import { COMPONENT_PAGES, ComponentDetail, RunOverview, type ComponentPage } from "../src/ui/run";
import { overviewOf } from "../src/ui/run/common";

const params = new URLSearchParams(location.search);
const runId = params.get("run") ?? "";
const width = Number(params.get("width") ?? 360);
const pages = (params.get("pages") ?? "").split(",").filter((page): page is ComponentPage => (COMPONENT_PAGES as readonly string[]).includes(page));
const pending: PendingBriefView | null = params.get("pending")
  ? {
    brief: { title: "Keyboard shortcuts help", goal: "A ? overlay that lists every shortcut, grouped by area.", requirements: ["Opens with ?", "Groups: navigation, editing, terminal"], acceptance: ["Lists every registered shortcut", "Closes with Escape"], constraints: ["No new dependencies"], outOfScope: ["Rebinding keys"] },
    roles: ["ui", "tester"],
    rounds: 2,
    planApproval: false,
    tasks: [{ title: "Overlay component", detail: "", role: "ui", after: [], files: [] }, { title: "Shortcut registry export", detail: "", role: "ui", after: [], files: [] }, { title: "E2E test", detail: "", role: "tester", after: ["1"], files: [] }],
    at: new Date(Date.now() - 40_000).toISOString(),
    confirmed: false,
  }
  : null;

function Column({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div style={{ width, flex: "none", border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--bg)" } as CSSProperties}>
      <div className="tiny muted" style={{ marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Harness() {
  const fixture = (window as unknown as { __FIXTURES: Record<string, RunDetail> }).__FIXTURES[runId];
  const [opened, setOpened] = useState<ComponentPage | null>(null);
  if (!fixture) return <div className="pad">No fixture {runId}</div>;
  const view = overviewOf(fixture);
  const run = pending ? { ...view, status: "closed" as const } : view;
  return (
    <div style={{ display: "flex", gap: 16, padding: 16, alignItems: "flex-start" }}>
      <Column title={`RunOverview${opened ? ` · opened ${opened}` : ""}`}>
        <RunOverview run={run} pending={pending} onOpen={setOpened} onFocusAgent={(id) => console.log("focus", id)} />
      </Column>
      {pages.map((page) => (
        <Column key={page} title={`ComponentDetail · ${page}`}>
          <ComponentDetail runId={runId} page={page} compact onBack={() => undefined} onOpen={() => undefined} onFocusAgent={(id) => console.log("focus", id)} />
        </Column>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
