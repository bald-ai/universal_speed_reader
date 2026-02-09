import { spawn } from "node:child_process";

function spawnProc(name, cmd, args, opts = {}, onExit) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
  child.on("exit", (code, signal) => {
    if (onExit) onExit(code, signal);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });
  return child;
}

const python = process.env.PYTHON || "python3";

let vite;

const tts = spawnProc(
  "tts",
  python,
  ["tools/tts-server/server.py"],
  { cwd: process.cwd() },
  (code) => {
    if (code && code !== 0) {
      // If the TTS server fails (common: port already in use), fail fast so we don't
      // keep running Vite against a stale/old server.
      try {
        vite?.kill("SIGINT");
      } catch {}
      process.exit(code);
    }
  }
);

vite = spawnProc(
  "vite",
  process.platform === "win32" ? "bun.exe" : "bun",
  ["run", "dev:vite"],
  { cwd: process.cwd() }
);

function shutdown() {
  try {
    tts.kill("SIGINT");
  } catch {}
  try {
    vite.kill("SIGINT");
  } catch {}
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
