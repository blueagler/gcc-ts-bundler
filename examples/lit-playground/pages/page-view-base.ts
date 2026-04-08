import { LitElement } from "lit";

export class PageViewBase extends LitElement {
  protected override createRenderRoot() {
    return this;
  }
}
