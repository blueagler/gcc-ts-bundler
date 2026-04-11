<script setup vapor>
defineProps({
  clickCount: {
    required: true,
    type: Number,
  },
});

const cardGridStyle = {
  display: "grid",
  gap: "16px",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const panelStyle = {
  background: "rgba(255, 250, 243, 0.78)",
  border: "1px solid rgba(24, 48, 40, 0.1)",
  borderRadius: "34px",
  boxShadow: "0 24px 60px rgba(32, 51, 42, 0.1)",
  display: "grid",
  gap: "22px",
  padding: "28px",
};

const storyCardStyle = {
  background: "rgba(255, 255, 255, 0.82)",
  borderRadius: "24px",
  display: "grid",
  gap: "10px",
  padding: "18px",
};
</script>

<template>
  <section :style="panelStyle">
    <div :style="{ display: 'grid', gap: '8px' }">
      <div :style="{ fontSize: '13px', fontWeight: '800', letterSpacing: '0.12em', opacity: 0.64, textTransform: 'uppercase' }">
        Studio panel
      </div>
      <h3 :style="{ fontSize: '30px', lineHeight: 1, margin: 0 }">Main-shell copy with a lazy Vapor body.</h3>
      <p :style="{ lineHeight: 1.65, margin: 0, maxWidth: '760px', opacity: 0.82 }">
        This first lazy panel stays focused on the compilation path itself: SFC parsing,
        Vapor-only code generation, then Closure-managed chunking after the precompile step.
      </p>
    </div>

    <div :style="cardGridStyle">
      <article :style="storyCardStyle">
        <div :style="{ fontSize: '12px', fontWeight: '800', opacity: 0.6, textTransform: 'uppercase' }">
          Build shape
        </div>
        <div :style="{ fontSize: '22px', fontWeight: '800' }">
          Pure Vapor
        </div>
        <p :style="{ lineHeight: 1.55, margin: 0, opacity: 0.76 }">
          No VDOM app shell. The SFC compiler emits the Vapor path directly.
        </p>
      </article>

      <article :style="storyCardStyle">
        <div :style="{ fontSize: '12px', fontWeight: '800', opacity: 0.6, textTransform: 'uppercase' }">
          Native emit
        </div>
        <div :style="{ fontSize: '22px', fontWeight: '800' }">
          Precompiled
        </div>
        <p :style="{ lineHeight: 1.55, margin: 0, opacity: 0.76 }">
          `.vue` files become plain ESM before the bundler sees them.
        </p>
      </article>

      <article :style="storyCardStyle">
        <div :style="{ fontSize: '12px', fontWeight: '800', opacity: 0.6, textTransform: 'uppercase' }">
          Interaction count
        </div>
        <div :style="{ fontSize: '22px', fontWeight: '800' }">
          {{ clickCount }}
        </div>
        <p :style="{ lineHeight: 1.55, margin: 0, opacity: 0.76 }">
          The root count still flows into this lazy component as normal reactive state.
        </p>
      </article>
    </div>
  </section>
</template>
