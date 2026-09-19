import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { determineClosureConcurrency } from "../concurrency";
import { probeClosureDriver, type ClosureDriverProbe } from "./probe";

export interface ResidentJobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 10 * 60_000;
// A typed self-build can emit >100k Closure warnings (~10–20 MiB of
// stdout/stderr). 64 MiB leaves several times that headroom while bounding
// the transient peak (chunks + concat + UTF-8 + parsed strings) so a runaway
// reply degrades to the per-job spawn fallback instead of exhausting the heap.
const MAX_REPLY_BYTES = 64 * 1024 * 1024;

function unrefStream(stream: unknown) {
  // Only the socket-backed stdio handles carry `unref`; the declared
  // Readable/Writable types do not expose it.
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
}

// One JVM is the memory-conscious default. An explicit concurrency override can
// enable a second lazy worker for independent jobs; this pool remains capped at
// two regardless of the outer prepared-job concurrency.
const workers: ResidentWorker[] = [];
const sessions = new Set<ResidentSession>();

process.on("exit", () => {
  for (const session of sessions) {
    session.kill("SIGKILL");
  }
});

export function runResidentClosureJob(
  args: readonly string[],
): Promise<ResidentJobResult | undefined> {
  const limit = determineClosureConcurrency(2, 1);
  let worker = workers[0];
  for (let index = 1; index < Math.min(limit, workers.length); index += 1) {
    const candidate = workers[index];
    if (candidate && worker && candidate.pending < worker.pending) {
      worker = candidate;
    }
  }
  if (!worker || (worker.pending > 0 && workers.length < limit)) {
    worker = new ResidentWorker();
    workers.push(worker);
  }
  return worker.run(args);
}

class ResidentWorker {
  private queue: Promise<void> = Promise.resolve();
  private session: ResidentSession | undefined;
  pending = 0;

  run(args: readonly string[]): Promise<ResidentJobResult | undefined> {
    this.pending += 1;
    const job = this.queue.then(() => this.runUnqueued(args));
    // The queue never rejects, including when the driver probe itself fails.
    // A worker remains occupied through close/drain, not merely until exit.
    this.queue = job.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return job;
  }

  private async runUnqueued(
    args: readonly string[],
  ): Promise<ResidentJobResult | undefined> {
    const probe = await probeClosureDriver();
    if (!probe.ok) {
      return undefined;
    }

    try {
      if (!this.session?.alive) {
        await this.session?.close();
        this.session = await ResidentSession.start(probe);
      }
      return await this.session.run(args);
    } catch {
      // Only this worker is reset. Its process and streams must be closed
      // before the caller may spawn fallback against the same output paths.
      await this.session?.close();
      this.session = undefined;
      return undefined;
    }
  }
}

class ResidentSession {
  /** Chunks are kept unjoined and each byte is scanned for the frame
   * terminator exactly once. Concatenating and re-scanning from zero on every
   * `data` event is quadratic, and a reply carrying a large diagnostic payload
   * (a typed self-build emits >100k warnings) turns that into minutes of pure
   * memcpy inside the driver. */
  private chunks: Buffer[] = [];
  private scanChunk = 0;
  private bufferedBytes = 0;
  private waiter: ((frame: Buffer | undefined) => void) | undefined;
  alive = true;
  private readonly closed = Promise.withResolvers<void>();

  private constructor(private readonly child: ChildProcess) {
    // Register before the ready handshake too: process exit can happen while
    // a JVM is still starting or while another worker is being drained.
    sessions.add(this);
    child.once("close", () => {
      sessions.delete(this);
      this.closed.resolve();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!this.waiter) {
        return;
      }
      this.bufferedBytes += chunk.length;
      if (this.bufferedBytes > MAX_REPLY_BYTES) {
        this.kill();
        return;
      }
      this.chunks.push(chunk);
      this.dispatch();
    });
    child.stderr?.resume();
    child.stdin?.on("error", () => {
      this.kill();
    });
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
    // A child with piped stdio keeps the event loop alive on its own, so a
    // process whose last Closure job already finished could never exit and the
    // `process.on("exit")` teardown above could never fire — the loop cannot
    // drain while the handles are referenced. Unreferencing them is safe:
    // every in-flight job awaits `readFrame`, which holds its own timer, so
    // reads still complete while work is outstanding.
    child.unref();
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    const session = new ResidentSession(child);
    try {
      const ready = await session.readFrame(READY_TIMEOUT_MS);
      if (!ready) {
        throw new Error("resident worker did not become ready");
      }
      const parsed = JSON.parse(ready.toString("utf8")) as { ready?: boolean };
      if (parsed.ready !== true) {
        throw new Error("resident worker handshake failed");
      }
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async run(args: readonly string[]): Promise<ResidentJobResult> {
    const stdin = this.child.stdin;
    if (!this.alive || !stdin) {
      throw new Error("resident worker is not running");
    }
    // Arm the waiter before writing so a fast reply cannot land in the
    // stdout handler while `waiter` is still undefined and get dropped.
    const framePromise = this.readFrame(JOB_TIMEOUT_MS);
    try {
      stdin.write(`${JSON.stringify({ ["args"]: args })}`);
      stdin.write(Buffer.from([0]), (error) => {
        if (error) {
          this.kill();
        }
      });
    } catch {
      this.kill();
    }
    const frame = await framePromise;
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

  async close() {
    // A failed protocol exchange must not leave a writer alive when fallback
    // compilation starts against the same output paths.
    this.child.ref();
    this.kill();
    const escalation = setTimeout(
      () => this.child.kill("SIGKILL"),
      SHUTDOWN_TIMEOUT_MS,
    );
    try {
      await this.closed.promise;
    } finally {
      clearTimeout(escalation);
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.alive = false;
    this.chunks = [];
    this.scanChunk = 0;
    this.bufferedBytes = 0;
    const waiter = this.waiter;
    this.waiter = undefined;
    this.child.kill(signal);
    waiter?.(undefined);
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
    while (this.scanChunk < this.chunks.length) {
      const chunk = this.chunks[this.scanChunk];
      if (!chunk) {
        break;
      }
      const index = chunk.indexOf(0);
      if (index === -1) {
        this.scanChunk += 1;
        continue;
      }
      const parts = this.chunks.slice(0, this.scanChunk);
      parts.push(chunk.subarray(0, index));
      const frame = Buffer.concat(parts);
      const rest = chunk.subarray(index + 1);
      const tail = this.chunks.slice(this.scanChunk + 1);
      this.chunks = rest.length > 0 ? [rest, ...tail] : tail;
      this.scanChunk = 0;
      this.bufferedBytes = 0;
      for (const leftover of this.chunks) {
        this.bufferedBytes += leftover.length;
      }
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(frame);
      return;
    }
    if (!this.alive) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(undefined);
    }
  }
}
