import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/native-packages.yml", import.meta.url),
  "utf8",
);
const zigInstaller = workflow.match(
  /      - if: \$\{\{ matrix\.cargo_command == 'zigbuild' \}\}\n        name: Install Zig 0\.15\.2[\s\S]*?(?=\n      - if: \$\{\{ matrix\.cargo_command == 'zigbuild' \}\})/u,
)?.[0];

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
});

test("native package publishing stays release-only", () => {
  expect(workflow).toContain("if: ${{ github.event_name == 'release' }}");
  expect(
    workflow.match(/if: \$\{\{ github\.event_name == 'release' \}\}/gu),
  ).toHaveLength(2);
});
