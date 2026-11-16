// Opens the document Orca hands the editor, then shows the editor (or why it can't).
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Icon, Spinner } from "../kit";
import { openDocument, type DocSession } from "./doc";
import { Editor } from "./Editor";

export function App() {
  const [session, setSession] = useState<DocSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    openDocument().then(setSession, (reason: Error) => setError(reason?.message === "no-document" ? t("editor.noDocument") : t("editor.loadFailed", { error: reason?.message ?? String(reason) })));
  }, []);
  if (error) {
    return (
      <div className="te-center">
        <Icon name="alert" size={20} />
        <span>{error}</span>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="te-center muted">
        <Spinner />
        <span>{t("editor.loading")}</span>
      </div>
    );
  }
  return <Editor session={session} />;
}
