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

let queue: Promise<unknown> = Promise.resolve();
let session: ResidentSession | undefined;

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

  private constructor(private readonly child: ChildProcess) {
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
    const ready = await session.readFrame(READY_TIMEOUT_MS);
    if (!ready) {
      session.kill();
      throw new Error("resident worker did not become ready");
    }
    let parsed: { ready?: boolean };
    try {
      parsed = JSON.parse(ready.toString("utf8")) as { ready?: boolean };
    } catch (error) {
      session.kill();
      throw error;
    }
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
    // Arm the waiter before writing so a fast reply cannot land in the
    // stdout handler while `waiter` is still undefined and get dropped.
    const framePromise = this.readFrame(JOB_TIMEOUT_MS);
    try {
      stdin.write(`${JSON.stringify({ args })}`);
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

  kill() {
    this.alive = false;
    this.chunks = [];
    this.scanChunk = 0;
    this.bufferedBytes = 0;
    const waiter = this.waiter;
    this.waiter = undefined;
    this.child.kill();
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
