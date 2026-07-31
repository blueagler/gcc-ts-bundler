import type {
  PlatformDeclarationUnit,
  PlatformExternIndex,
  PlatformExternSeeds,
} from "./types";

const INTRINSIC_TYPES = new Set(["Function", "Object"]);

export function slicePlatformExterns(
  index: PlatformExternIndex,
  seeds: PlatformExternSeeds,
): string | null {
  const selected = new Map<string, PlatformDeclarationUnit>();
  const queue: PlatformDeclarationUnit[] = [];
  const overridesByOwner = new Map<string, PlatformDeclarationUnit[]>();
  for (const unit of index.browserUnits) {
    if (!unit.override || !unit.owner) continue;
    const overrides = overridesByOwner.get(unit.owner);
    if (overrides) overrides.push(unit);
    else overridesByOwner.set(unit.owner, [unit]);
  }

  const add = (unit: PlatformDeclarationUnit) => {
    if (!unit.fileName.startsWith("browser/") || selected.has(unit.id)) return;
    selected.set(unit.id, unit);
    queue.push(unit);
  };
  const addName = (name: string): boolean => {
    const units = index.unitsByName.get(name);
    if (!units)
      return index.languageNames.has(name) || INTRINSIC_TYPES.has(name);
    for (const unit of units) add(unit);
    return true;
  };

  for (const name of [...seeds.globals, ...seeds.typeNames]) {
    if (!addName(name)) return null;
  }
  for (const property of seeds.properties) {
    const units = index.unitsByProperty.get(property);
    if (!units) return null;
    for (const unit of units) add(unit);
  }

  for (let indexInQueue = 0; indexInQueue < queue.length; indexInQueue += 1) {
    const unit = queue[indexInQueue];
    if (!unit) continue;
    for (const name of unit.names) {
      for (const override of overridesByOwner.get(name) ?? []) add(override);
    }
    for (const dependency of unit.dependencies) {
      if (!addName(dependency)) return null;
    }
    forEachAncestorPropertyUnit(index, unit, add);
  }

  const browser = orderSelectedUnits(index, selected);
  // `--env CUSTOM` still loads Closure's version-matched language externs;
  // adding their sources here would redeclare every ECMAScript builtin.
  const chunks = ["/** @externs */"];
  for (const unit of browser) chunks.push(unit.text.trim());
  chunks.push("");
  return chunks.join("\n\n");
}

function orderSelectedUnits(
  index: PlatformExternIndex,
  selected: ReadonlyMap<string, PlatformDeclarationUnit>,
): PlatformDeclarationUnit[] {
  const ordered: PlatformDeclarationUnit[] = [];
  const complete = new Set<string>();
  const active = new Set<string>();
  const stable = [...selected.values()].sort(compareSourceOrder);

  const visit = (unit: PlatformDeclarationUnit) => {
    if (complete.has(unit.id) || active.has(unit.id)) return;
    active.add(unit.id);
    for (const dependency of unit.dependencies) {
      for (const candidate of index.unitsByName.get(dependency) ?? []) {
        if (selected.has(candidate.id)) visit(candidate);
      }
    }
    forEachAncestorPropertyUnit(index, unit, (candidate) => {
      if (selected.has(candidate.id)) visit(candidate);
    });
    active.delete(unit.id);
    complete.add(unit.id);
    ordered.push(unit);
  };

  for (const unit of stable) visit(unit);
  return ordered;
}

function forEachAncestorPropertyUnit(
  index: PlatformExternIndex,
  unit: PlatformDeclarationUnit,
  callback: (candidate: PlatformDeclarationUnit) => void,
) {
  if (!unit.override || !unit.owner || !unit.property) return;
  for (const ancestor of collectAncestors(index, unit.owner)) {
    for (const candidate of index.unitsByProperty.get(unit.property) ?? []) {
      if (candidate.owner === ancestor) callback(candidate);
    }
  }
}

function compareSourceOrder(
  left: PlatformDeclarationUnit,
  right: PlatformDeclarationUnit,
) {
  return (
    left.fileOrder - right.fileOrder ||
    left.statementOrder - right.statementOrder
  );
}

function collectAncestors(
  index: PlatformExternIndex,
  owner: string,
): Set<string> {
  const ancestors = new Set<string>();
  const queue = [owner];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const unit of index.unitsByName.get(current) ?? []) {
      for (const ancestor of unit.heritage) {
        if (!ancestors.has(ancestor)) {
          ancestors.add(ancestor);
          queue.push(ancestor);
        }
      }
    }
  }
  return ancestors;
}
