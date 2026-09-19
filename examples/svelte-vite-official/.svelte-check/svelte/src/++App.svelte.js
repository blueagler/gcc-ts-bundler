///<reference types="svelte" />
;
import svelteLogo from './assets/svelte.svg'
import viteLogo from './assets/vite.svg'
import heroImg from './assets/hero.png'
import Counter from './lib/Counter.svelte';
function $$render() {

  
  
  
  
;
async () => {

 { svelteHTML.createElement("section", { "id":`center`,});
   { svelteHTML.createElement("div", { "class":`hero`,});
      { svelteHTML.createElement("img", {        "src":heroImg,"class":`base`,"width":`170`,"height":`179`,"alt":"",});}
     { svelteHTML.createElement("img", {      "src":svelteLogo,"class":`framework`,"alt":`Svelte logo`,});}
     { svelteHTML.createElement("img", {      "src":viteLogo,"class":`vite`,"alt":`Vite logo`,});}
   }
   { svelteHTML.createElement("div", {});
     { svelteHTML.createElement("h1", {});  }
     { svelteHTML.createElement("p", {});  { svelteHTML.createElement("code", {});  }      { svelteHTML.createElement("code", {});  } }
   }
   { const $$_retnuoC1C = __sveltets_2_ensureComponent(Counter); new $$_retnuoC1C({ target: __sveltets_2_any(), props: {}});}
 }

 { svelteHTML.createElement("div", { "class":`ticks`,}); }

 { svelteHTML.createElement("section", { "id":`next-steps`,});
   { svelteHTML.createElement("div", { "id":`docs`,});
     { svelteHTML.createElement("svg", {     "class":`icon`,"role":`presentation`,"aria-hidden":`true`,});
       { svelteHTML.createElement("use", { "href":`/icons.svg#documentation-icon`,}); }
     }
     { svelteHTML.createElement("h2", {});  }
     { svelteHTML.createElement("p", {});   }
     { svelteHTML.createElement("ul", {});
       { svelteHTML.createElement("li", {});
         { svelteHTML.createElement("a", {     "href":`https://vite.dev/`,"target":`_blank`,"rel":`noreferrer`,});
            { svelteHTML.createElement("img", {    "class":`logo`,"src":viteLogo,"alt":"",});}
           
         }
       }
       { svelteHTML.createElement("li", {});
         { svelteHTML.createElement("a", {     "href":`https://svelte.dev/`,"target":`_blank`,"rel":`noreferrer`,});
            { svelteHTML.createElement("img", {    "class":`button-icon`,"src":svelteLogo,"alt":"",});}
           
         }
       }
     }
   }
   { svelteHTML.createElement("div", { "id":`social`,});
     { svelteHTML.createElement("svg", {     "class":`icon`,"role":`presentation`,"aria-hidden":`true`,});
       { svelteHTML.createElement("use", { "href":`/icons.svg#social-icon`,}); }
     }
     { svelteHTML.createElement("h2", {});   }
     { svelteHTML.createElement("p", {});    }
     { svelteHTML.createElement("ul", {});
       { svelteHTML.createElement("li", {});
         { svelteHTML.createElement("a", {     "href":`https://github.com/vitejs/vite`,"target":`_blank`,"rel":`noreferrer`,});
           { svelteHTML.createElement("svg", {     "class":`button-icon`,"role":`presentation`,"aria-hidden":`true`,});
             { svelteHTML.createElement("use", { "href":`/icons.svg#github-icon`,}); }
           }
          
         }
       }
       { svelteHTML.createElement("li", {});
         { svelteHTML.createElement("a", {     "href":`https://chat.vite.dev/`,"target":`_blank`,"rel":`noreferrer`,});
           { svelteHTML.createElement("svg", {     "class":`button-icon`,"role":`presentation`,"aria-hidden":`true`,});
             { svelteHTML.createElement("use", { "href":`/icons.svg#discord-icon`,}); }
           }
          
         }
       }
       { svelteHTML.createElement("li", {});
         { svelteHTML.createElement("a", {     "href":`https://x.com/vite_js`,"target":`_blank`,"rel":`noreferrer`,});
           { svelteHTML.createElement("svg", {     "class":`button-icon`,"role":`presentation`,"aria-hidden":`true`,});
             { svelteHTML.createElement("use", { "href":`/icons.svg#x-icon`,}); }
           }
          
         }
       }
       { svelteHTML.createElement("li", {});
         { svelteHTML.createElement("a", {     "href":`https://bsky.app/profile/vite.dev`,"target":`_blank`,"rel":`noreferrer`,});
           { svelteHTML.createElement("svg", {     "class":`button-icon`,"role":`presentation`,"aria-hidden":`true`,});
             { svelteHTML.createElement("use", { "href":`/icons.svg#bluesky-icon`,}); }
           }
          
         }
       }
     }
   }
 }

 { svelteHTML.createElement("div", { "class":`ticks`,}); }
 { svelteHTML.createElement("section", { "id":`spacer`,}); }
};
return { props: /** @type {Record<string, never>} */ ({}), exports: {}, bindings: "", slots: {}, events: {} }}
export const App__SvelteComponent_ = __sveltets_2_isomorphic_component(__sveltets_2_partial(__sveltets_2_with_any_event($$render())));
/*Ωignore_startΩ*//** @typedef {InstanceType<typeof App__SvelteComponent_>} App__SvelteComponent_ */
/*Ωignore_endΩ*/export default App__SvelteComponent_;