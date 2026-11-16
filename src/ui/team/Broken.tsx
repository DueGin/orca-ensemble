// A file that can't be edited as a team: its problems, and a way to start over. Nothing is written until the user picks.
import { t } from "../i18n";
import { Button, Icon } from "../kit";
import type { Draft } from "./draft";

function problemText(problem: string): string {
  if (problem.startsWith("json: ")) return t("editor.broken.notJson", { error: problem.slice(6) });
  if (problem === "object") return t("editor.broken.notObject");
  return problem;
}

export function BrokenView({ broken, readOnly, onSalvage, onBlank }: { broken: Extract<Draft, { kind: "broken" }>; readOnly: boolean; onSalvage?: () => void; onBlank(): void }) {
  return (
    <div className="te-broken">
      <div className="te-broken-card">
        <span className="te-broken-icon"><Icon name="alert" size={20} /></span>
        <h1 className="te-broken-title">{t("editor.broken.title")}</h1>
        <p className="te-broken-hint">{t("editor.broken.hint")}</p>
        <ul className="te-broken-list">
          {broken.problems.slice(0, 12).map((problem, index) => <li key={index}><code>{problemText(problem)}</code></li>)}
          {broken.problems.length > 12 ? <li className="muted">{t("editor.broken.more", { count: broken.problems.length - 12 })}</li> : null}
        </ul>
        <div className="te-broken-actions">
          {onSalvage ? <Button icon="edit" onClick={onSalvage} disabled={readOnly}>{t("editor.broken.salvage")}</Button> : null}
          <Button variant="primary" icon="file" onClick={onBlank} disabled={readOnly}>{t("editor.broken.blank")}</Button>
        </div>
        <p className="te-hint">{readOnly ? t("editor.readOnly") : t("editor.broken.untouched")}</p>
      </div>
    </div>
  );
}
