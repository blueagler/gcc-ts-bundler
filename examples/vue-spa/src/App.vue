<script setup lang="ts">
import { defineAsyncComponent, ref } from "vue";
import HelloWorld from "./components/HelloWorld.vue";

const showDetails = ref(false);
const LazyDetails = defineAsyncComponent(
  () => import("./components/LazyDetails.vue"),
);
</script>

<template>
  <main>
    <h1>Vite + Vue</h1>
    <HelloWorld msg="You did it!" />
    <button type="button" @click="showDetails = !showDetails">
      {{ showDetails ? "Hide details" : "Show details" }}
    </button>
    <LazyDetails v-if="showDetails" />
  </main>
</template>
