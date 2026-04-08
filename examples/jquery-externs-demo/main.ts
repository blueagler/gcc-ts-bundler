import $ from "jquery";

const status = $("#status");
const toggleButton = $("#toggle-button");
const resetButton = $("#reset-button");

function renderStatus() {
  const isActive = status.hasClass("active");
  status
    .text(isActive ? "Active" : "Idle")
    .toggleClass("active", isActive);
}

toggleButton.on("click", () => {
  status.toggleClass("active");
  renderStatus();
});

resetButton.on("click", () => {
  status.removeClass("active");
  renderStatus();
});

renderStatus();
