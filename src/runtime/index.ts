export function lazyModule<T>(_specifier: string): () => Promise<T> {
  throw new Error(
    "lazyModule() is a compile-time helper. Build the application with gcc-ts-bundler before running it.",
  );
}

export function preloadModule(_specifier: string): Promise<void> {
  throw new Error(
    "preloadModule() is a compile-time helper. Build the application with gcc-ts-bundler before running it.",
  );
}
