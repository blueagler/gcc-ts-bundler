///<reference types="svelte" />
;function $$render() {

  let count: number = $state(0)
  const increment = () => {
    count += 1
  }
;
async () => {

 { svelteHTML.createElement("button", {     "type":`button`,"class":`counter`,"onclick":increment,});
    count;
 }
};
return { props: {} as Record<string, never>, exports: {}, bindings: __sveltets_$$bindings(''), slots: {}, events: {} }}
const Counter__SvelteComponent_ = __sveltets_2_fn_component($$render());
/*Ωignore_startΩ*/type Counter__SvelteComponent_ = ReturnType<typeof Counter__SvelteComponent_>;
/*Ωignore_endΩ*/export default Counter__SvelteComponent_;