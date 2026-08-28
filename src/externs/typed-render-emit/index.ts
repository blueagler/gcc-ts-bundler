import ts from "@typescript/typescript6";

import {
  emitClass,
  emitEnum,
  emitFunction,
  emitInterface,
  emitNamespace,
  emitTypeAlias,
  emitUnknown,
  emitValue,
} from "./kinds";
import type { RenderState } from "../typed-render";

export { reserveSeedSymbol } from "./reserve";

export function emitSymbol(symbol: ts.Symbol, state: RenderState) {
  const name = state.nameForSymbol.get(symbol);
  const module = state.moduleForSymbol.get(symbol);
  if (!name || !module) return;
  const declarations = symbol.declarations ?? [];
  const declaration = declarations[0];
  if (!declaration) {
    emitUnknown(name, state);
    return;
  }
  if (symbol.flags & ts.SymbolFlags.Class) {
    emitClass(name, declarations.filter(ts.isClassDeclaration), state, module);
  } else if (symbol.flags & ts.SymbolFlags.Interface) {
    emitInterface(
      name,
      declarations.filter(ts.isInterfaceDeclaration),
      state,
      module,
    );
  } else if (symbol.flags & ts.SymbolFlags.TypeAlias) {
    emitTypeAlias(
      name,
      declarations.filter(ts.isTypeAliasDeclaration)[0],
      state,
      module,
    );
  } else if (symbol.flags & ts.SymbolFlags.Enum) {
    emitEnum(name, declarations.filter(ts.isEnumDeclaration)[0], state);
  } else if (symbol.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Method)) {
    emitFunction(name, symbol, state, module);
  } else if (
    symbol.flags &
    (ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule)
  ) {
    emitNamespace(name, symbol, state, module);
  } else {
    emitValue(name, symbol, declaration, state, module);
  }
}
