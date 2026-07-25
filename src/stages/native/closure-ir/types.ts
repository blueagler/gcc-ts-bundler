export interface ClosureIrFileMetadata {
  decoratedOutputText: string | undefined;
  enumDeclarations: ClosureIrEnumDeclaration[];
  filePath: string;
  topLevelDocs: ClosureIrTopLevelDoc[];
  typeDeclarations: ClosureIrTypeDeclaration[];
}

export interface ClosureIrEnumDeclaration {
  exported: boolean;
  members: Array<{
    name: string;
    value: boolean | number | string;
  }>;
  name: string;
  valueType: "boolean" | "number" | "string";
}

export interface ClosureIrTopLevelDoc {
  jsdoc: string;
  kind:
    | "class"
    | "constructor"
    | "field"
    | "function"
    | "getter"
    | "method"
    | "objectGetter"
    | "objectMethod"
    | "objectProperty"
    | "objectSetter"
    | "setter"
    | "variable";
  name: string;
  owner?: string;
  static?: boolean;
}

export interface ClosureIrTypeDeclaration {
  snippet: string;
}

export interface FunctionObjectParamRecord {
  snippet: string;
  typeName: string;
}
