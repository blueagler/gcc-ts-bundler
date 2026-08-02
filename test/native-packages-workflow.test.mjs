import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/native-packages.yml", import.meta.url),
  "utf8",
);
const zigInstaller = workflow.match(
  /      - if: \$\{\{ matrix\.cargo_command == 'zigbuild' \}\}\n        name: Install Zig 0\.15\.2[\s\S]*?(?=\n      - if: \$\{\{ matrix\.cargo_command == 'zigbuild' \}\})/u,
)?.[0];
const rootPublishJob = workflow.match(
  /  publish-root-package:\n[\s\S]*$/u,
)?.[0];
const publishCondition =
  "${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.dry_run == true) }}";
const bunVersion = rootPublishJob?.match(
  /bun-version:\s*(?<version>\d+\.\d+\.\d+)/u,
)?.groups?.version;

function readZigArchitectureMapping(runnerArchitecture) {
  const mapping = zigInstaller?.match(
    new RegExp(
      `\\n            ${runnerArchitecture}\\)\\n              zig_arch=(?<archiveArchitecture>[a-z0-9_]+)\\n              zig_sha256=(?<sha256>[a-f0-9]{64})\\n              ;;`,
      "u",
    ),
  );
  expect(mapping?.groups).toBeDefined();
  return mapping.groups;
}

function readNativePackageMatrixEntry(packageName) {
  const entry = workflow.match(
    new RegExp(
      `\\n          - package_name: ${packageName}\\n(?<entry>[\\s\\S]*?)(?=\\n          - package_name:|\\n    steps:)`,
      "u",
    ),
  )?.groups?.entry;
  expect(entry).toBeDefined();
  return entry;
}

test("Darwin native package matrix uses the supported runner mappings", () => {
  expect(workflow).not.toContain("macos-13");
  expect(readNativePackageMatrixEntry("gcc-ts-bundler-darwin-x64")).toMatch(
    /runs_on: macos-15-intel\n\s+target: x86_64-apple-darwin\n\s+platform: darwin\n\s+arch: x64/u,
  );
  expect(readNativePackageMatrixEntry("gcc-ts-bundler-darwin-arm64")).toMatch(
    /runs_on: macos-14\n\s+target: aarch64-apple-darwin\n\s+platform: darwin\n\s+arch: arm64/u,
  );
});

test("musl jobs install Zig 0.15.2 from verified official archives", () => {
  expect(workflow).not.toContain("mlugg/setup-zig");
  expect(zigInstaller).toBeDefined();
  expect(zigInstaller).toContain("ZIG_VERSION: 0.15.2");
  expect(zigInstaller).toContain("RUNNER_ARCH: ${{ runner.arch }}");
  expect(readZigArchitectureMapping("X64")).toEqual({
    archiveArchitecture: "x86_64",
    sha256: "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
  });
  expect(readZigArchitectureMapping("ARM64")).toEqual({
    archiveArchitecture: "aarch64",
    sha256: "958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f",
  });
  expect(zigInstaller).toContain(
    'archive="zig-${zig_arch}-linux-${ZIG_VERSION}.tar.xz"',
  );
  expect(zigInstaller).toContain(
    '"https://ziglang.org/download/${ZIG_VERSION}/${archive}"',
  );
  expect(zigInstaller).toContain(
    "curl --fail --location --retry 3 --retry-all-errors",
  );
  expect(zigInstaller).toContain("sha256sum --check --status");
  expect(zigInstaller).toContain(
    'echo "Unsupported runner.arch: $RUNNER_ARCH" >&2',
  );
  expect(zigInstaller).toContain('"$zig_dir/zig" version');
  expect(workflow).toContain(
    "cargo install cargo-zigbuild --version 0.23.0 --locked",
  );
});

test("workflow actions use current Node 24-runtime majors", () => {
  expect(workflow).toContain("actions/checkout@v7");
  expect(workflow).toContain("actions/setup-node@v7");
  expect(workflow).toContain("actions/upload-artifact@v7");
  expect(workflow).toContain("actions/download-artifact@v8");
  expect(workflow).not.toMatch(
    /actions\/(?:checkout|setup-node|upload-artifact)@v4/u,
  );
});

test("root publishing restores native artifacts before installing dependencies", () => {
  expect(rootPublishJob).toBeDefined();
  expect(rootPublishJob).toContain("merge-multiple: false");
  expect(rootPublishJob).toMatch(
    /actions\/download-artifact@v8\n        with:\n          pattern: gcc-ts-bundler-\*\n          path: npm[\s\S]*?cp npm\/gcc-ts-bundler-linux-x64-gnu\/index\.node native\/index\.node[\s\S]*?bun install --frozen-lockfile/u,
  );
});

test("root publishing uses a Bun version compatible with bun.lock", () => {
  expect(bunVersion).toBeDefined();
  const [major, minor] = bunVersion.split(".").map(Number);
  expect(major > 1 || (major === 1 && minor >= 4)).toBe(true);
});

test("native package publishing is release-only except opt-in dry runs", () => {
  expect(workflow).toContain("workflow_dispatch:\n    inputs:\n      dry_run:");
  expect(workflow).toContain("type: boolean");
  expect(
    workflow.match(
      new RegExp(
        publishCondition.replace(/[${}()[\].+*?^$|\\]/gu, "\\$&"),
        "gu",
      ),
    ),
  ).toHaveLength(2);
  expect(workflow).toContain(
    'if [ "${{ inputs.dry_run }}" = "true" ]; then\n            args+=(--dry-run)',
  );
  expect(workflow).toContain("release:\n    types:\n      - published");
  expect(workflow).not.toContain(
    "github.event_name == 'workflow_dispatch' && !inputs.dry_run",
  );
});
