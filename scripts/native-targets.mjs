import { spawnSync } from "node:child_process";

const triples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "linux-arm64-musl": "aarch64-unknown-linux-musl",
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "linux-x64-musl": "x86_64-unknown-linux-musl",
  "win32-arm64-msvc": "aarch64-pc-windows-msvc",
  "win32-x64-msvc": "x86_64-pc-windows-msvc",
};

export const nativeTargets = Object.fromEntries(
  Object.entries(triples).map(([key, targetTriple]) => {
    const [platform, arch, abi] = key.split("-");
    return [
      key,
      {
        key,
        platform,
        arch,
        libc: platform === "linux" ? abi : null,
        packageName: `gcc-ts-bundler-${key}`,
        targetTriple,
      },
    ];
  }),
);

export function hostNativeTarget() {
  const libc = process.platform === "linux" ? detectLinuxLibc() : null;
  const target = Object.values(nativeTargets).find(
    (candidate) =>
      candidate.platform === process.platform &&
      candidate.arch === process.arch &&
      candidate.libc === libc,
  );
  if (!target)
    throw new Error(
      `Unsupported native host ${process.platform}/${process.arch}/${libc}`,
    );
  return target;
}

function detectLinuxLibc() {
  if (process.report?.getReport?.().header?.glibcVersionRuntime) return "gnu";
  const result = spawnSync("ldd", ["--version"], { encoding: "utf8" });
  if (`${result.stdout ?? ""}${result.stderr ?? ""}`.includes("musl"))
    return "musl";
  throw new Error(
    "Cannot determine Linux libc; refusing to select a native package",
  );
}

export function parseNativeTargets(argv) {
  const booleans = new Set(["all", "skip-root-copy"]);
  const values = new Set([
    "targets",
    "platforms",
    "target",
    "platform",
    "arch",
    "libc",
    "package-name",
    "cargo-command",
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(argv[index]);
    if (!match || (!booleans.has(match[1]) && !values.has(match[1])))
      throw new Error(`Unknown argument ${argv[index]}`);
    const [, key, inline] = match;
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate --${key}`);
    if (booleans.has(key)) {
      if (inline !== undefined)
        throw new Error(`--${key} does not take a value`);
      options[key] = true;
    } else {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`--${key} requires a value`);
      options[key] = value;
    }
  }
  const selectors = ["all", "targets", "platforms"].filter((key) =>
    Object.hasOwn(options, key),
  );
  if (selectors.length > 1)
    throw new Error("Use only one of --all, --targets, --platforms");
  const list = (value) => {
    const entries = value.split(",").map((entry) => entry.trim());
    if (
      entries.some((entry) => !entry) ||
      new Set(entries).size !== entries.length
    )
      throw new Error("Target lists must contain distinct nonempty values");
    return entries;
  };
  let selected;
  if (options.targets) {
    selected = list(options.targets).map((key) => {
      if (!Object.hasOwn(nativeTargets, key))
        throw new Error(`Unsupported native target ${key}`);
      const target = nativeTargets[key];
      return target;
    });
  } else if (options.all) {
    selected = Object.values(nativeTargets);
  } else if (options.platforms) {
    const platforms = list(options.platforms);
    if (
      platforms.some(
        (platform) =>
          !Object.values(nativeTargets).some(
            (target) => target.platform === platform,
          ),
      )
    )
      throw new Error("Unsupported native platform filter");
    selected = Object.values(nativeTargets).filter((target) =>
      platforms.includes(target.platform),
    );
  } else {
    const fields = {
      target: "targetTriple",
      platform: "platform",
      arch: "arch",
      libc: "libc",
      "package-name": "packageName",
    };
    const constraints = Object.entries(fields).filter(
      ([key]) => options[key] !== undefined,
    );
    if (constraints.length === 0) selected = [hostNativeTarget()];
    else {
      selected = Object.values(nativeTargets).filter((target) =>
        constraints.every(([key, field]) => target[field] === options[key]),
      );
      if (selected.length !== 1)
        throw new Error(
          "Native metadata must select exactly one supported target",
        );
    }
  }
  for (const target of selected) {
    for (const [key, field] of Object.entries({
      target: "targetTriple",
      platform: "platform",
      arch: "arch",
      libc: "libc",
      "package-name": "packageName",
    })) {
      if (options[key] !== undefined && options[key] !== target[field])
        throw new Error(`--${key} conflicts with ${target.key}`);
    }
    const command = options["cargo-command"];
    if (
      command !== undefined &&
      command !== "build" &&
      !(command === "zigbuild" && target.platform === "linux") &&
      !(command === "xwin" && target.platform === "win32")
    )
      throw new Error(`Unsupported cargo command for ${target.key}`);
  }
  return {
    targets: selected.map((target) => ({
      ...target,
      cargoCommand: options["cargo-command"],
    })),
    skipRootCopy: options["skip-root-copy"] === true || selected.length > 1,
  };
}

export function validateNativePackage(manifest, target, rootManifest) {
  const expectedVersion =
    rootManifest.optionalDependencies?.[target.packageName];
  if (
    !expectedVersion ||
    manifest.name !== target.packageName ||
    manifest.version !== expectedVersion ||
    JSON.stringify(manifest.os) !== JSON.stringify([target.platform]) ||
    JSON.stringify(manifest.cpu) !== JSON.stringify([target.arch]) ||
    JSON.stringify(manifest.libc ?? []) !==
      JSON.stringify(
        target.libc ? [target.libc === "gnu" ? "glibc" : target.libc] : [],
      ) ||
    manifest.main !== "index.node"
  ) {
    throw new Error(
      `Native package ${target.packageName} must match its supported descriptor and declared version ${expectedVersion ?? "(missing)"}`,
    );
  }
}
