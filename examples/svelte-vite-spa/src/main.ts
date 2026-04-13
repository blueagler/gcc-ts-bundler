import "./app.css";
import { mount } from "svelte";

import App from "./App.svelte";

const target = document.querySelector<HTMLDivElement>("#app");

if (target === null) {
  throw new Error("Expected a #app mount target in index.html");
}

mount(App, { target });
