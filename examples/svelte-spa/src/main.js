import "../.m3-compiled/theme.js";
import { mount } from "svelte";

import App from "./App.svelte.js";

const target = document.getElementById("app");
target ? mount(App, { target }) : null;
