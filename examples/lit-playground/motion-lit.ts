import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  animate,
  AnimateController,
  fade,
  flyBelow,
} from "@lit-labs/motion";

import { motionLetterStyles } from "./styles.js";

@customElement("motion-lit")
export class MotionLit extends LitElement {
  static styles = motionLetterStyles;

  private readonly lit = ["L", "I", "T"];

  @property({ type: Array }) accessor letters = [...this.lit];

  private readonly duration = 1000;
  private readonly controller = new AnimateController(this, {
    defaultOptions: {
      keyframeOptions: {
        duration: this.duration,
        fill: "backwards",
      },
    },
    onComplete: () => this.changeLayout(),
  });

  constructor() {
    super();
    this.addEventListener("click", this.clickHandler);
  }

  override render() {
    const delayTime = this.duration / (this.letters.length * 2.5 || 1);
    return html`
      ${this.letters.map(
        (letter, index) => html`
          <span
            class="letter"
            ${animate({
              keyframeOptions: {
                delay: index * delayTime,
              },
              properties: ["opacity"],
              in: fade,
              out: flyBelow,
            })}
          >
            ${letter}
          </span>
        `,
      )}
      <div class="info">Click to toggle</div>
    `;
  }

  private readonly clickHandler = () => {
    if (this.controller.isAnimating) {
      this.controller.togglePlay();
      return;
    }

    this.changeLayout();
  };

  private changeLayout() {
    this.letters = this.letters.length > 0 ? [] : [...this.lit];
  }
}
