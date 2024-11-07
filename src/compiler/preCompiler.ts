import { parseAsync, transformFromAstAsync } from "@babel/core";
//@ts-ignore
import typescriptSyntaxPlugin from "@babel/plugin-syntax-typescript";

export async function customTransform(code: string): Promise<string> {
  const ast = (await parseAsync(code, {
    babelrc: false,
    plugins: [[typescriptSyntaxPlugin]],
  }))!;

  return (await transformFromAstAsync(ast, code, {
    babelrc: false,
    plugins: [[typescriptSyntaxPlugin]],
  }))!.code!;
}
