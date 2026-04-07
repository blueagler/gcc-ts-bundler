import { mountMotionPlaygroundApp } from "./motion-playground-app.js";

void Promise.all([
  waitForDocumentBody(),
]).then(() => {
  mountMotionPlaygroundApp(document.body);
});

function waitForDocumentBody() {
  if (document.body) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}
