export type { ClosureDocRenderContext } from "./context";
export {
  canonicalSymbolId,
  createClosureDocRenderContext,
  referencesForTemplate,
  registerDeclaredTypeSymbol,
} from "./context";
export type { FunctionLikeDeclaration, SignatureParamInfo } from "./to-closure";
export {
  applyTypeArguments,
  collectSignatureParamInfos,
  getTypedDeclarationClosureType,
  isWorthAnnotatingVariableType,
  signatureToClosureFunctionType,
  toClosureHeritageType,
  toClosureType,
} from "./to-closure";
