export interface ClosureIrFileMetadata {
  decoratedOutputText?: string;
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
  kind: "class" | "function";
  name: string;
}

export interface ClosureIrTypeDeclaration {
  snippet: string;
}

export interface FunctionObjectParamRecord {
  snippet: string;
  typeName: string;
}
