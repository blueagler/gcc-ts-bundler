import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export const SHOW_INTERNAL_TIMINGS = process.env.GCC_BUILD_TIMINGS === "1";
export const PROFILE_INTERNAL_TIMINGS = process.env.GCC_BUILD_PROFILE === "1";

interface TimingSpan {
  id: number;
  parent: TimingSpan | undefined;
  label: string;
  depth: number;
  start: number;
  end: number | undefined;
  error: boolean;
  counters: Record<string, number> | undefined;
}

interface TimingScope {
  spans: TimingSpan[];
  current: TimingSpan;
  closed: boolean;
}

// No async context, span arrays, or counter objects in ordinary builds.
const timingScope = PROFILE_INTERNAL_TIMINGS
  ? new AsyncLocalStorage<TimingScope>()
  : undefined;

export function logInternalTiming(label: string, durationMs: number) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }

  console.error(`[gcc-ts-bundler timing] ${label}: ${durationMs.toFixed(1)}ms`);
}

export function logInternalDetail(label: string, detail: string) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }

  console.error(`[gcc-ts-bundler timing] ${label}: ${detail}`);
}

export function countInternalWork(label: string, count: number): void {
  const scope = timingScope?.getStore();
  if (!scope || scope.closed || scope.spans[0]?.end !== undefined) return;
  if (!scope.current.counters) {
    scope.current.counters = {};
    Object.setPrototypeOf(scope.current.counters, null);
  }
  const counters = scope.current.counters;
  counters[label] = (counters[label] ?? 0) + count;
}

function createSpan(
  label: string,
  spans: TimingSpan[],
  parent?: TimingSpan,
): TimingSpan {
  const span: TimingSpan = {
    id: spans.length,
    parent,
    label,
    depth: parent ? parent.depth + 1 : 0,
    start: performance.now(),
    end: undefined,
    error: false,
    counters: undefined,
  };
  spans.push(span);
  return span;
}

/** A fresh invocation, never a child of another concurrently active build. */
export async function withInternalBuildProfile<T>(
  label: string,
  work: () => Promise<T> | T,
): Promise<T> {
  if (!timingScope) return await work();
  const spans: TimingSpan[] = [];
  const root = createSpan(label, spans);
  const scope: TimingScope = { spans, current: root, closed: false };
  try {
    return await timingScope.run(scope, work);
  } catch (error) {
    root.error = true;
    throw error;
  } finally {
    root.end = performance.now();
    scope.closed = true;
    // Profiling output must not replace a build result or its original exception.
    try {
      writeProfileReceipt(root, spans);
    } catch {
      // A closed stderr must not prevent invocation cleanup or change diagnostics.
    }
  }
}

export async function withInternalTiming<T>(
  label: string,
  work: () => Promise<T> | T,
): Promise<T> {
  const scope = timingScope?.getStore();
  if (
    timingScope &&
    scope &&
    !scope.closed &&
    scope.spans[0]?.end === undefined
  ) {
    const span = createSpan(label, scope.spans, scope.current);
    try {
      return await timingScope.run({ ...scope, current: span }, work);
    } catch (error) {
      span.error = true;
      throw error;
    } finally {
      span.end = performance.now();
      logInternalTiming(label, span.end - span.start);
    }
  }
  if (!SHOW_INTERNAL_TIMINGS) {
    return await work();
  }

  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    logInternalTiming(label, performance.now() - startedAt);
  }
}

/** Keep synchronous setup synchronous, including its exception behavior. */
export function withInternalTimingSync<T>(label: string, work: () => T): T {
  const scope = timingScope?.getStore();
  if (
    timingScope &&
    scope &&
    !scope.closed &&
    scope.spans[0]?.end === undefined
  ) {
    const span = createSpan(label, scope.spans, scope.current);
    try {
      return timingScope.run({ ...scope, current: span }, work);
    } catch (error) {
      span.error = true;
      throw error;
    } finally {
      span.end = performance.now();
      logInternalTiming(label, span.end - span.start);
    }
  }
  if (!SHOW_INTERNAL_TIMINGS) return work();
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    logInternalTiming(label, performance.now() - startedAt);
  }
}

function writeProfileReceipt(root: TimingSpan, spans: TimingSpan[]): void {
  const end = root.end;
  if (end === undefined) throw new Error("Cannot report an open timing root.");
  const rows = spans.map((span) => {
    const spanEnd = Math.min(span.end ?? end, end);
    const start = Math.min(span.start, spanEnd);
    return {
      id: span.id,
      parentId: span.parent?.id ?? null,
      depth: span.depth,
      label: span.label,
      startMs: start - root.start,
      durationMs: spanEnd - start,
      selfMs: spanEnd - start,
      exclusiveMs: 0,
      counters: span.counters ?? {},
      error: span.error,
    };
  });
  const events = rows.flatMap((row) => [
    { time: row.startMs, row, start: true },
    { time: row.startMs + row.durationMs, row, start: false },
  ]);
  events.sort((a, b) => a.time - b.time || Number(b.start) - Number(a.start));
  const active = new Set<(typeof rows)[number]>();
  let previous = 0;
  for (const event of events) {
    const elapsed = event.time - previous;
    if (elapsed > 0) {
      let owner: (typeof rows)[number] | undefined;
      for (const row of active) {
        if (
          !owner ||
          row.depth > owner.depth ||
          (row.depth === owner.depth && row.id > owner.id)
        )
          owner = row;
      }
      // Wall-exclusive attribution partitions time even for overlapping siblings.
      if (owner) owner.exclusiveMs += elapsed;
      // Subtract each parent's active children as a UNION, not a sum.
      const parents = new Set<number>();
      for (const row of active) {
        if (row.parentId !== null) parents.add(row.parentId);
      }
      for (const row of active) {
        if (parents.has(row.id)) row.selfMs -= elapsed;
      }
    }
    if (event.start) active.add(event.row);
    else active.delete(event.row);
    previous = event.time;
  }
  // Floating point cancellation can produce a tiny negative zero-like residual.
  for (const row of rows) row.selfMs = Math.max(0, row.selfMs);
  // String keys must survive Closure ADVANCED in the self-hosted compiler.
  const receipt = Object.fromEntries<unknown>([
    ["version", 1],
    ["label", root.label],
    ["totalMs", end - root.start],
    [
      "spans",
      rows.map((row) =>
        Object.fromEntries<unknown>([
          ["id", row.id],
          ["parentId", row.parentId],
          ["label", row.label],
          ["startMs", row.startMs],
          ["durationMs", row.durationMs],
          ["selfMs", row.selfMs],
          ["exclusiveMs", row.exclusiveMs],
          ["counters", row.counters],
          ["error", row.error],
        ]),
      ),
    ],
  ]);
  console.error(`[gcc-ts-bundler profile] ${JSON.stringify(receipt)}`);
}
