<script setup vapor>
import { defineVaporAsyncComponent, ref } from "vue";

const clickCount = ref(0);
const activePanel = ref("studio");
const panelCount = 3;

const loadPanel = (loader) =>
  defineVaporAsyncComponent(() =>
    loader().then((module) => module[0] ?? module.default ?? module),
  );

const StudioPanel = loadPanel(() => import("./panels/StudioPanel.vue"));
const MetricsPanel = loadPanel(() => import("./panels/MetricsPanel.vue"));
const NotesPanel = loadPanel(() => import("./panels/NotesPanel.vue"));

const pageStyle = {
  display: "grid",
  gap: "28px",
  margin: "0 auto",
  maxWidth: "1120px",
  minHeight: "100vh",
  padding: "40px 24px 72px",
};

const heroStyle = {
  backdropFilter: "blur(18px)",
  background: "rgba(255, 250, 243, 0.76)",
  border: "1px solid rgba(24, 48, 40, 0.1)",
  borderRadius: "34px",
  boxShadow: "0 24px 60px rgba(32, 51, 42, 0.12)",
  display: "grid",
  gap: "24px",
  padding: "32px",
};

const eyebrowStyle = {
  alignSelf: "start",
  background: "rgba(24, 48, 40, 0.08)",
  borderRadius: "999px",
  fontSize: "13px",
  fontWeight: "800",
  letterSpacing: "0.12em",
  padding: "9px 14px",
  textTransform: "uppercase",
  width: "fit-content",
};

const heroCopyStyle = {
  display: "grid",
  gap: "14px",
  maxWidth: "760px",
};

const statsGridStyle = {
  display: "grid",
  gap: "14px",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
};

const statCardStyle = {
  background: "rgba(255, 255, 255, 0.82)",
  borderRadius: "24px",
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.7)",
  display: "grid",
  gap: "6px",
  padding: "18px",
};

const actionRowStyle = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
};

const primaryButtonStyle = {
  background: "linear-gradient(135deg, #204c3d 0%, #3d6a58 100%)",
  border: "none",
  borderRadius: "999px",
  color: "#f7f4ed",
  cursor: "pointer",
  fontSize: "15px",
  fontWeight: "800",
  padding: "12px 18px",
};

const chipStyle = {
  background: "rgba(255, 255, 255, 0.76)",
  border: "1px solid rgba(24, 48, 40, 0.12)",
  borderRadius: "999px",
  display: "inline-flex",
  fontSize: "14px",
  fontWeight: "700",
  gap: "8px",
  padding: "10px 14px",
};

const tabsWrapStyle = {
  display: "grid",
  gap: "14px",
};

function selectPanel(id) {
  activePanel.value = id;
}

function makeTabStyle(id) {
  return {
    alignItems: "flex-start",
    background:
      activePanel.value === id
        ? "linear-gradient(135deg, #1d4738 0%, #2f6652 100%)"
        : "rgba(255, 255, 255, 0.78)",
    border:
      activePanel.value === id
        ? "1px solid rgba(29, 71, 56, 0.3)"
        : "1px solid rgba(24, 48, 40, 0.12)",
    borderRadius: "24px",
    color: activePanel.value === id ? "#f7f4ed" : "#183028",
    cursor: "pointer",
    display: "grid",
    gap: "6px",
    padding: "16px 18px",
    textAlign: "left",
  };
}
</script>

<template>
  <div :style="pageStyle">
    <section :style="heroStyle">
      <div :style="eyebrowStyle">Vue Vapor + Closure</div>
      <div :style="heroCopyStyle">
        <h1
          :style="{
            fontSize: 'clamp(2.6rem, 7vw, 5rem)',
            letterSpacing: '-0.05em',
            lineHeight: 0.94,
            margin: 0,
          }"
        >
          Precompile `.vue` files, keep lazy imports native, then run the result through
          `ADVANCED`.
        </h1>
        <p
          :style="{
            fontSize: '18px',
            lineHeight: 1.6,
            margin: 0,
            maxWidth: '720px',
            opacity: 0.82,
          }"
        >
          This fixture compiles single-file components with the Vue Vapor compiler path first.
          The generated JS then goes through gcc-ts-bundler with bundler-runtime chunk loading.
        </p>
      </div>

      <div :style="actionRowStyle">
        <button type="button" :style="primaryButtonStyle" @click="clickCount += 1">
          Count: {{ clickCount }}
        </button>
        <div :style="chipStyle">Panels: {{ panelCount }}</div>
        <div :style="chipStyle">Runtime: Vue 3.6 beta Vapor</div>
        <div :style="chipStyle">Chunk loader: bundler-runtime</div>
      </div>

      <div :style="statsGridStyle">
        <div :style="statCardStyle">
          <div :style="{ fontSize: '12px', fontWeight: '800', opacity: 0.62, textTransform: 'uppercase' }">
            Compiler path
          </div>
          <div :style="{ fontSize: '24px', fontWeight: '800' }">&lt;script setup vapor&gt;</div>
        </div>
        <div :style="statCardStyle">
          <div :style="{ fontSize: '12px', fontWeight: '800', opacity: 0.62, textTransform: 'uppercase' }">
            App mount
          </div>
          <div :style="{ fontSize: '24px', fontWeight: '800' }">createVaporApp</div>
        </div>
        <div :style="statCardStyle">
          <div :style="{ fontSize: '12px', fontWeight: '800', opacity: 0.62, textTransform: 'uppercase' }">
            Lazy split
          </div>
          <div :style="{ fontSize: '24px', fontWeight: '800' }">3 async panels</div>
        </div>
      </div>
    </section>

    <section :style="tabsWrapStyle">
      <div :style="{ display: 'grid', gap: '10px' }">
        <h2 :style="{ fontSize: '30px', margin: 0 }">Swap lazy Vapor panels</h2>
        <p :style="{ lineHeight: 1.6, margin: 0, maxWidth: '780px', opacity: 0.8 }">
          Each button below activates a `defineVaporAsyncComponent()` import. The initial shell
          stays in the main chunk while the panel modules remain lazy.
        </p>
      </div>

      <div
        :style="{
          display: 'grid',
          gap: '12px',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        }"
      >
        <button
          type="button"
          :style="makeTabStyle('studio')"
          @click="selectPanel('studio')"
        >
          <span :style="{ fontSize: '18px', fontWeight: '800' }">Studio</span>
          <span :style="{ fontSize: '14px', lineHeight: 1.45, opacity: 0.8 }">
            Hero metrics and launch framing.
          </span>
        </button>
        <button
          type="button"
          :style="makeTabStyle('metrics')"
          @click="selectPanel('metrics')"
        >
          <span :style="{ fontSize: '18px', fontWeight: '800' }">Metrics</span>
          <span :style="{ fontSize: '14px', lineHeight: 1.45, opacity: 0.8 }">
            Tiny reactive controls inside a lazy panel.
          </span>
        </button>
        <button
          type="button"
          :style="makeTabStyle('notes')"
          @click="selectPanel('notes')"
        >
          <span :style="{ fontSize: '18px', fontWeight: '800' }">Notes</span>
          <span :style="{ fontSize: '14px', lineHeight: 1.45, opacity: 0.8 }">
            Editable state inside a second lazy view.
          </span>
        </button>
      </div>
    </section>

    <StudioPanel v-if="activePanel === 'studio'" :click-count="clickCount" />
    <MetricsPanel v-else-if="activePanel === 'metrics'" :click-count="clickCount" />
    <NotesPanel v-else :click-count="clickCount" />
  </div>
</template>
