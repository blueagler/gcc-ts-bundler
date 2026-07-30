function dec(target: any, key?: any): any {}
@dec
export class Widget {
  @dec accessor count = 0;
  @dec method(@dec x: number) { return x; }
}
