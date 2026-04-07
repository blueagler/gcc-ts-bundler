const loadFeature = () => import("./feature");

const button = document.getElementById("load");
const result = document.getElementById("result");

if (button && result) {
  button.addEventListener("click", async () => {
    result.textContent = "loading";
    const feature = await loadFeature();
    result.textContent = feature.renderMessage();
  });
}
