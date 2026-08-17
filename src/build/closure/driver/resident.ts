import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { probeClosureDriver, type ClosureDriverProbe } from "./probe";

export interface ResidentJobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const READY_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 10 * 60_000;

let queue: Promise<unknown> = Promise.resolve();
let session: ResidentSession | undefined;

export function resetResidentClosureDriver() {
  session?.kill();
  session = undefined;
  queue = Promise.resolve();
}

process.on("exit", () => {
  session?.kill();
});

export function runResidentClosureJob(
  args: readonly string[],
): Promise<ResidentJobResult | undefined> {
  const job = queue.then(
    () => runResidentClosureJobUnqueued(args),
    () => runResidentClosureJobUnqueued(args),
  );
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

async function runResidentClosureJobUnqueued(
  args: readonly string[],
): Promise<ResidentJobResult | undefined> {
  const probe = await probeClosureDriver();
  if (!probe.ok) {
    return undefined;
  }

  try {
    const child = await ensureSession(probe);
    return await child.run(args);
  } catch {
    session?.kill();
    session = undefined;
    return undefined;
  }
}

async function ensureSession(probe: Extract<ClosureDriverProbe, { ok: true }>) {
  if (session?.alive) {
    return session;
  }
  session?.kill();
  session = await ResidentSession.start(probe);
  return session;
}

class ResidentSession {
  private buffer = Buffer.alloc(0);
  private waiter: ((frame: Buffer | undefined) => void) | undefined;
  alive = true;

  private constructor(private readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.dispatch();
    });
    child.stderr?.resume();
    child.on("exit", () => {
      this.alive = false;
      this.waiter?.(undefined);
      this.waiter = undefined;
    });
    child.on("error", () => {
      this.alive = false;
      this.waiter?.(undefined);
      this.waiter = undefined;
    });
  }

  static async start(probe: Extract<ClosureDriverProbe, { ok: true }>) {
    const child = spawn(
      probe.javaPath,
      [
        "-XX:+IgnoreUnrecognizedVMOptions",
        "--sun-misc-unsafe-memory-access=allow",
        "-cp",
        `${probe.jarPath}${path.delimiter}${probe.classesDir}`,
        "ResidentCliWorker",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const session = new ResidentSession(child);
    const ready = await session.readFrame(READY_TIMEOUT_MS);
    if (!ready) {
      session.kill();
      throw new Error("resident worker did not become ready");
    }
    const parsed = JSON.parse(ready.toString("utf8")) as { ready?: boolean };
    if (parsed.ready !== true) {
      session.kill();
      throw new Error("resident worker handshake failed");
    }
    return session;
  }

  async run(args: readonly string[]): Promise<ResidentJobResult> {
    const stdin = this.child.stdin;
    if (!this.alive || !stdin) {
      throw new Error("resident worker is not running");
    }
    stdin.write(`${JSON.stringify({ args })}`);
    stdin.write(Buffer.from([0]));
    const frame = await this.readFrame(JOB_TIMEOUT_MS);
    if (!frame) {
      throw new Error("resident worker closed during job");
    }
    const parsed = JSON.parse(frame.toString("utf8")) as {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    };
    if (typeof parsed.exitCode !== "number") {
      throw new Error("resident worker returned a malformed reply");
    }
    return {
      exitCode: parsed.exitCode,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr ?? "",
    };
  }

  kill() {
    this.alive = false;
    this.child.kill();
    this.waiter?.(undefined);
    this.waiter = undefined;
  }

  private readFrame(timeoutMs: number): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        resolve(undefined);
      }, timeoutMs);
      this.waiter = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.dispatch();
    });
  }

  private dispatch() {
    if (!this.waiter) {
      return;
    }
    const index = this.buffer.indexOf(0);
    if (index === -1) {
      if (!this.alive) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter(undefined);
      }
      return;
    }
    const frame = this.buffer.subarray(0, index);
    this.buffer = this.buffer.subarray(index + 1);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter(frame);
  }
}
