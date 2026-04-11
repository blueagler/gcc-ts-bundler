<script setup vapor>
import { computed, ref } from "vue";

const props = defineProps({
  clickCount: {
    required: true,
    type: Number,
  },
});

const multiplier = ref(3);
const intensity = ref("steady");

const derivedScore = computed(() => props.clickCount * multiplier.value + 12);

const panelStyle = {
  background: "linear-gradient(145deg, rgba(28, 56, 47, 0.96), rgba(53, 88, 73, 0.92))",
  borderRadius: "34px",
  boxShadow: "0 24px 60px rgba(24, 48, 40, 0.18)",
  color: "#f7f4ed",
  display: "grid",
  gap: "22px",
  padding: "28px",
};

const dialStyle = {
  alignItems: "center",
  display: "flex",
  gap: "12px",
  flexWrap: "wrap",
};

function chooseLevel(id) {
  intensity.value = id;
}

function levelStyle(id) {
  return {
    background:
      intensity.value === id ? "rgba(255, 250, 243, 0.22)" : "rgba(255, 250, 243, 0.1)",
    border: "1px solid rgba(255, 250, 243, 0.24)",
    borderRadius: "22px",
    color: "#f7f4ed",
    cursor: "pointer",
    display: "grid",
    gap: "6px",
    padding: "14px 16px",
    textAlign: "left",
  };
}
</script>

<template>
  <section :style="panelStyle">
    <div :style="{ display: 'grid', gap: '8px' }">
      <div :style="{ fontSize: '13px', fontWeight: '800', letterSpacing: '0.12em', opacity: 0.74, textTransform: 'uppercase' }">
        Metrics panel
      </div>
      <h3 :style="{ fontSize: '30px', lineHeight: 1, margin: 0 }">Reactive controls inside a lazy-loaded Vapor component.</h3>
      <p :style="{ lineHeight: 1.65, margin: 0, maxWidth: '780px', opacity: 0.84 }">
        This panel adds local refs, a computed score, and a small interaction dial. It is still
        loaded only after the user switches away from the shell.
      </p>
    </div>

    <div :style="{ display: 'grid', gap: '18px', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(220px, 0.8fr)' }">
      <div :style="{ display: 'grid', gap: '14px' }">
        <div :style="dialStyle">
          <label :style="{ fontWeight: '700' }">Multiplier</label>
          <input v-model="multiplier" type="range" min="1" max="8" />
          <span :style="{ fontWeight: '800' }">{{ multiplier }}</span>
        </div>

        <div
          :style="{
            display: 'grid',
            gap: '12px',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          }"
        >
          <button
            type="button"
            :style="levelStyle('steady')"
            @click="chooseLevel('steady')"
          >
            <span :style="{ fontSize: '18px', fontWeight: '800' }">Steady</span>
            <span :style="{ lineHeight: 1.45, opacity: 0.8 }">
              Balanced motion and chunk timing.
            </span>
          </button>
          <button
            type="button"
            :style="levelStyle('burst')"
            @click="chooseLevel('burst')"
          >
            <span :style="{ fontSize: '18px', fontWeight: '800' }">Burst</span>
            <span :style="{ lineHeight: 1.45, opacity: 0.8 }">
              Aggressive compile and lazy split energy.
            </span>
          </button>
          <button
            type="button"
            :style="levelStyle('silent')"
            @click="chooseLevel('silent')"
          >
            <span :style="{ fontSize: '18px', fontWeight: '800' }">Silent</span>
            <span :style="{ lineHeight: 1.45, opacity: 0.8 }">
              Keep the UI calm and the chunks late.
            </span>
          </button>
        </div>
      </div>

      <aside
        :style="{
          background: 'rgba(255, 250, 243, 0.12)',
          border: '1px solid rgba(255, 250, 243, 0.18)',
          borderRadius: '28px',
          display: 'grid',
          gap: '10px',
          padding: '20px',
        }"
      >
        <div :style="{ fontSize: '12px', fontWeight: '800', letterSpacing: '0.12em', opacity: 0.66, textTransform: 'uppercase' }">
          Derived score
        </div>
        <div :style="{ fontSize: '38px', fontWeight: '800' }">{{ derivedScore }}</div>
        <div :style="{ fontWeight: '700' }">Mode: {{ intensity }}</div>
        <div :style="{ lineHeight: 1.55, opacity: 0.8 }">
          Root clicks ({{ clickCount }}) combine with the local multiplier to keep this panel reactive.
        </div>
      </aside>
    </div>
  </section>
</template>
