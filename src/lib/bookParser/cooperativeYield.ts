const YIELD_BUDGET_MS = 50; // Yield at most every ~50ms of work: cancel stays
// responsive while total overhead stays a few % of the 30s wall-clock budget.

function macrotask(): Promise<void> {
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        port1.close();
        resolve();
      };
      port2.postMessage(null);
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function createCooperativeYielder(budgetMs = YIELD_BUDGET_MS): () => Promise<void> {
  let lastYield = performance.now();
  return async () => {
    if (performance.now() - lastYield < budgetMs) return;
    await macrotask();
    lastYield = performance.now();
  };
}
