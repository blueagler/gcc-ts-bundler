import "./app.css";
import { mount } from "svelte";

import App from "./App.svelte";

const target = document.getElementById("app");
target ? mount(App, { target }) : null;
