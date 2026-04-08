import "./motion-playground-app.js";

void Promise.all([
  waitForDocumentBody(),
]).then(() => {
  const app = document.createElement("motion-playground-app");
  document.body.replaceChildren(app);
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
