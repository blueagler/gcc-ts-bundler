<script setup vapor>
import { computed, ref } from "vue";

defineProps({
  clickCount: {
    required: true,
    type: Number,
  },
});

const memo = ref("Keep the authored source small, then let the native pipeline handle chunk rewriting.");

const noteLength = computed(() => memo.value.trim().length);

const panelStyle = {
  background: "rgba(255, 250, 243, 0.78)",
  border: "1px solid rgba(24, 48, 40, 0.1)",
  borderRadius: "34px",
  boxShadow: "0 24px 60px rgba(32, 51, 42, 0.1)",
  display: "grid",
  gap: "22px",
  padding: "28px",
};
</script>

<template>
  <section :style="panelStyle">
    <div :style="{ display: 'grid', gap: '8px' }">
      <div :style="{ fontSize: '13px', fontWeight: '800', letterSpacing: '0.12em', opacity: 0.64, textTransform: 'uppercase' }">
        Notes panel
      </div>
      <h3 :style="{ fontSize: '30px', lineHeight: 1, margin: 0 }">Editable state proves the lazy panel is alive.</h3>
      <p :style="{ lineHeight: 1.65, margin: 0, maxWidth: '780px', opacity: 0.82 }">
        This panel keeps a local text area and a computed character count. It is a second async
        `.vue` chunk compiled through the same Vapor prepass.
      </p>
    </div>

    <div :style="{ display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(220px, 0.8fr)' }">
      <label :style="{ display: 'grid', gap: '10px' }">
        <span :style="{ fontWeight: '800' }">Build memo</span>
        <textarea
          v-model="memo"
          :style="{
            background: 'rgba(255, 255, 255, 0.86)',
            border: '1px solid rgba(24, 48, 40, 0.14)',
            borderRadius: '24px',
            color: '#183028',
            font: 'inherit',
            lineHeight: 1.55,
            minHeight: '180px',
            padding: '16px',
            resize: 'vertical',
          }"
        />
      </label>

      <aside
        :style="{
          background: 'rgba(255, 255, 255, 0.76)',
          borderRadius: '28px',
          display: 'grid',
          gap: '10px',
          padding: '20px',
        }"
      >
        <div :style="{ fontSize: '12px', fontWeight: '800', letterSpacing: '0.12em', opacity: 0.6, textTransform: 'uppercase' }">
          Draft summary
        </div>
        <div :style="{ fontSize: '36px', fontWeight: '800' }">{{ noteLength }}</div>
        <div :style="{ fontWeight: '700' }">Characters</div>
        <div :style="{ lineHeight: 1.55, opacity: 0.78 }">
          The panel keeps its own local state while still being lazy-loaded and compiled from a
          standalone SFC.
        </div>
      </aside>
    </div>
  </section>
</template>
