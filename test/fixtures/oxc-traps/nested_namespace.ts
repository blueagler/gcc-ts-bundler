namespace A {
  export namespace B {
    export function f(): number { return 2; }
  }
}
export const v = A.B.f();
