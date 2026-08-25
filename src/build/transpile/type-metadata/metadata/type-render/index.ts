export type { ClosureDocRenderContext } from "./context";
export {
  canonicalSymbolId,
  createClosureDocRenderContext,
  referencesForTemplate,
  registerDeclaredTypeSymbol,
} from "./context";
export type { FunctionLikeDeclaration, SignatureParamInfo } from "./function";
export {
  collectSignatureParamInfos,
  signatureToClosureFunctionType,
} from "./function";
export { applyTypeArguments } from "./named";
export {
  getTypedDeclarationClosureType,
  isWorthAnnotatingVariableType,
  toClosureHeritageType,
  toClosureType,
} from "./core";
