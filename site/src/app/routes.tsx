import type { Route } from "./nav";
import Today from "./pages/Today";
import Library from "./pages/Library";
import ExamPage from "./pages/ExamPage";
import ResultsPage from "./pages/ResultsPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import HistoryPage from "./pages/HistoryPage";
import MistakesPage from "./pages/MistakesPage";
import VocabPage from "./pages/VocabPage";
import SettingsPage from "./pages/SettingsPage";

/**
 * Workspace route table. Exam routes render full-screen (no shell chrome) —
 * the exam runtime owns the whole viewport, same as the desktop app.
 */
export function WorkspaceRoutes({ route }: { route: Route }) {
  const seg = route.segments[1]; // segments[0] === "app"
  switch (seg) {
    case undefined:
    case "":
      return <Today />;
    case "library":
      return <Library route={route} />;
    case "exam":
      return <ExamPage route={route} />;
    case "results":
      return <ResultsPage route={route} />;
    case "analytics":
      return <AnalyticsPage route={route} />;
    case "history":
      return <HistoryPage route={route} />;
    case "mistakes":
      return <MistakesPage route={route} />;
    case "vocab":
      return <VocabPage route={route} />;
    case "settings":
      return <SettingsPage route={route} />;
    default:
      return <Today />;
  }
}

export function isExamRoute(route: Route): boolean {
  return route.segments[1] === "exam";
}
