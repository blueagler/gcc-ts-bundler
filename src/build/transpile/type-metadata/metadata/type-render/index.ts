export type { ClosureDocRenderContext } from "./context";
export {
  canonicalSymbolId,
  createClosureDocRenderContext,
  referencesForTemplate,
  registerDeclaredTypeSymbol,
} from "./context";
export { toClosureType } from "./to-closure";
export type { FunctionLikeDeclaration, SignatureParamInfo } from "./function";
export {
  collectSignatureParamInfos,
  signatureToClosureFunctionType,
} from "./function";
export {
  getTypedDeclarationClosureType,
  isWorthAnnotatingVariableType,
  toClosureHeritageType,
} from "./heritage";
export { applyTypeArguments } from "./named";
