import { useEffect, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import { AppErrorBoundary } from "@/components/shared/AppErrorBoundary";
import { useSettings } from "@/contexts/SettingsContext";
import { getBookRepository } from "@/lib/storage/appRepository";

function StartupRedirect(props: { children: React.ReactNode }) {
  const { settings } = useSettings();
  const [, setLocation] = useLocation();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (settings.startupScreen !== "last-book") {
      setChecked(true);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const repo = await getBookRepository();
        const books = await repo.listBooks({ statuses: ["completed"] });
        if (cancelled) return;
        if (books.length > 0) {
          const sorted = [...books].sort((a, b) => b.updated_at - a.updated_at);
          setLocation(`/reader/${sorted[0].id}`, { replace: true });
        }
      } catch {
        // fall through to default home
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!checked) return null;
  return <>{props.children}</>;
}

function App() {
  return (
    <StartupRedirect>
      <Switch>
        <Route path="/">
          <AppErrorBoundary title="Library screen crashed">
            <Home />
          </AppErrorBoundary>
        </Route>
        <Route path="/reader/:bookId">
          <AppErrorBoundary title="Reader screen crashed">
            <Reader />
          </AppErrorBoundary>
        </Route>
        <Route>
          <div className="flex items-center justify-center min-h-screen text-neutral-400">
            404: Page Not Found
          </div>
        </Route>
      </Switch>
    </StartupRedirect>
  );
}

export default App;
