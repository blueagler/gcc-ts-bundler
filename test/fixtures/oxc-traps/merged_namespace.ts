// risk 2: nested namespaces plus a merged second declaration block. The merged
// block does not survive today's lowering (Closure rejects the emitted module),
// so this trap exists to be *watched*, not to be a passing baseline.
export namespace Outer {
  export const version = 3;
  export namespace Inner {
    export const tag = "INNER";
    export function twice(value: number): number {
      return value * 2;
    }
    export namespace Deep {
      export function thrice(value: number): number {
        return twice(value) + value;
      }
    }
  }
  export function describe(): string {
    return `${version}:${Inner.tag}`;
  }
}
export namespace Outer {
  export function versionTwice(): number {
    return Inner.twice(version);
  }
}
