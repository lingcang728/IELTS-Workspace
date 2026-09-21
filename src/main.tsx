import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { flushForClose } from "./lib/closeFlush";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/exam.css";
import "./styles/practice.css";

// Rust intercepts every CloseRequested (Alt+F4, taskbar close, logoff) and
// re-emits it here; flush whatever the exam registered, then actually close.
// A wedged webview is still covered by the backend's 3 s destroy fallback.
if ("__TAURI_INTERNALS__" in window) {
  void listen("app-close-requested", async () => {
    await flushForClose();
    await getCurrentWindow().destroy();
  });
}

// Restore the last-used shell theme before first paint — the tokens default
// to dark and bootstrap is async, so without this light-mode users flash dark.
try {
  const theme = window.localStorage.getItem("ielts.ui.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.ui = theme;
} catch { /* storage may be unavailable; fall back to the dark default */ }

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
