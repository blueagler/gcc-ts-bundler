import type { ExternAnalysisContext } from "./context";
import { collectContracts as collectRegistryContracts } from "./contracts/registry";
import {
  collectBoundaryAwareExternLines as collectUsageExternLines,
  collectBoundaryAwareUsageMemberNames as collectUsageMemberNames,
} from "./contracts/usage";
export { createEmptyContractRegistry } from "./shared";

import {
  collectStructuralContractMembers,
  ContractRegistry,
  renderStructuralExternLine,
} from "./shared";

export const collectContracts = collectRegistryContracts;

export function collectCandidateExternLines(registry: ContractRegistry) {
  const properties = new Set<string>();
  for (const contract of registry.interfaceContracts.values()) {
    for (const member of collectStructuralContractMembers(
      contract.symbol,
      registry,
    )) {
      properties.add(member);
    }
  }
  for (const contract of registry.typeAliasContracts.values()) {
    for (const member of contract.members) {
      properties.add(member);
    }
  }
  for (const contract of registry.classContracts.values()) {
    for (const member of contract.instanceMembers) {
      properties.add(member);
    }
  }

  return new Set(
    [...properties]
      .sort((left, right) => left.localeCompare(right))
      .map((property) => renderStructuralExternLine(property)),
  );
}

export function collectBoundaryAwareExternLines(
  analysis: ExternAnalysisContext,
) {
  return collectUsageExternLines(analysis);
}

export function collectBoundaryAwareUsageMemberNames(
  analysis: ExternAnalysisContext,
) {
  return collectUsageMemberNames(analysis);
}
