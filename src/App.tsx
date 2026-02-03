import { Route, Switch } from "wouter";
import Home from "./pages/Home";
import Reader from "./pages/Reader";

function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/reader/:bookId" component={Reader} />
      <Route>
        <div className="flex items-center justify-center min-h-screen text-neutral-400">
          404: Page Not Found
        </div>
      </Route>
    </Switch>
  );
}

export default App;
