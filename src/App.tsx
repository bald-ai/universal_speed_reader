import { Route, Switch } from "wouter";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import { AppErrorBoundary } from "@/components/shared/AppErrorBoundary";

function App() {
  return (
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
  );
}

export default App;
