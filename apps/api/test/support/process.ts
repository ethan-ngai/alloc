import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** A spawned process whose combined output is retained for failure messages. */
export interface RunningProcess {
  readonly child: ChildProcess;
  output(): string;
}

export function spawnProcess(entry: string, options: { cwd: string; env: NodeJS.ProcessEnv }): RunningProcess {
  const child = spawn(process.execPath, [entry], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
}

/** Inherits the environment minus the ports the test allocates itself. */
export function baseEnvironment(): NodeJS.ProcessEnv {
  const { CONDUCTOR_PORT: _conductorPort, PORT: _port, ...rest } = process.env;
  return rest;
}

export async function waitForHttp(url: string, timeoutMs: number, running: RunningProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    if (running.child.exitCode !== null) {
      throw new Error(`process exited with code ${running.child.exitCode}\n${running.output()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`no answer from ${url} within ${timeoutMs}ms\n${running.output()}`);
    }
    // A spawned process cannot be driven by fake timers; poll the real socket briefly.
    await delay(200);
  }
}

/** Polls until `check` passes, reporting the process output when it never does. */
export async function waitForSuccess(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
  running?: RunningProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}${running ? `\n${running.output()}` : ""}`);
    }
    await delay(200);
  }
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Terminates a spawned process, escalating from SIGTERM to SIGKILL. */
export async function stopProcess(running: RunningProcess): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return;
  }
  running.child.kill("SIGTERM");
  await waitForExit(running.child, 10_000).catch(() => running.child.kill("SIGKILL"));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
