// The team editor frame: Orca opens `.team.json` files in it, beside its own Source view.
import { createRoot } from "react-dom/client";
import { App } from "./team/App";

createRoot(document.getElementById("root")!).render(<App />);
