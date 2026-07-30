import type { Foo } from "./nowhere";
export interface Bar { a: number }
export type Baz = Bar;
export const impl: Bar = { a: 1 };
export { type Foo };
