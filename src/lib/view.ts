/** Shell-level types shared by `App.tsx` and everything under `src/pages/`. */

export type View =
  | "home"
  | "practice"
  | "mock"
  | "analytics"
  | "history"
  | "settings"
  | "import"
  | "results"
  | "exam";

/** Only the app shell has a light/dark choice; the exam runtime is fixed light. */
export type UiTheme = "light" | "dark";

export type CatalogModule = "all" | "reading" | "listening" | "writing";
