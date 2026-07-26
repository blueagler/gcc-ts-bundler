<script setup lang="ts">
import { computed, ref } from "vue";

const items = ref(["chunked", "lazy", "optimized"]);
const summary = computed(() => items.value.join(" + "));
</script>

<template>
  <section class="details">
    <h3>Lazy details</h3>
    <p>This component arrived in its own chunk: {{ summary }}.</p>
    <ul>
      <li v-for="item in items" :key="item">{{ item }}</li>
    </ul>
  </section>
</template>
