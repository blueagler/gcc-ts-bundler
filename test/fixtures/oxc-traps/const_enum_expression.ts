// risk 1: member values that are constant *expressions* over earlier members.
// oxc's TS transform leaves these unfolded; our inliner must fold them, because
// a `const enum` has no runtime object to read from.
export const enum Dir {
  Up = 1,
  Down = 1 + Up,
  Both = Down << 2,
  Neg = -Down,
  Mask = Both | Dir.Up,
  Half = (Both + 2) / 5,
  Next,
}
export const values = [Dir.Up, Dir.Down, Dir.Both, Dir.Neg, Dir.Mask, Dir.Half, Dir.Next];
