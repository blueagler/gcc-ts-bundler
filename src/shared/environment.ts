export type EnvironmentOverrides = NodeJS.ProcessEnv &
  Readonly<Record<string, string>>;

export async function withEnvironment<Result>(
  values: EnvironmentOverrides,
  run: () => Promise<Result>,
): Promise<Result> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
