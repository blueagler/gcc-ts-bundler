// risk 3: a top-level name that shadows an imported binding of the same name.
// Direct-binding decisions across chunks hinge on telling these two apart.
import { label as importedLabel } from "./nowhere";
const label = (): string => "LOCAL";
export function read(): string {
  return label() + importedLabel;
}
export function inner(): string {
  const label = "BLOCK";
  return label;
}
