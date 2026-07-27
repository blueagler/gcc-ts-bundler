export {
  collectBoundaryAwareExternLines,
  collectBoundaryAwareUsageMemberNames,
} from "./usage";
import {
  collectStructuralContractMembers,
  renderStructuralExternLine,
} from "../shared";
import type { ContractRegistry } from "../shared";

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
