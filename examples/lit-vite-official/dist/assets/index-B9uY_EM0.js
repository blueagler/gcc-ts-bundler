var l=globalThis,p=l.ShadowRoot&&(l.ShadyCSS===void 0||l.ShadyCSS.nativeShadow)&&`adoptedStyleSheets`in Document.prototype&&`replace`in CSSStyleSheet.prototype,r=Symbol();class aa{constructor(e){if(this.U=!0,r!==r)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e}toString(){return this.cssText}}var ba=(n,i)=>{if(p)n.adoptedStyleSheets=i.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(let t of i){i=document.createElement(`style`);let a=l.litNonce;a!==void 0&&i.setAttribute(`nonce`,a),i.textContent=t.cssText,n.appendChild(i)}},ca=p?e=>e:e=>{if(e instanceof CSSStyleSheet){let t=``;for(let n of e.cssRules)t+=n.cssText;e=new aa(t)}return e},da=Object.is,ea=Object.defineProperty,fa=Object.getOwnPropertyDescriptor,ha=Object.getOwnPropertyNames,ia=Object.getOwnPropertySymbols,ja=Object.getPrototypeOf,u=globalThis,ka=u.trustedTypes,la=ka?ka.emptyScript:``,ma=u.reactiveElementPolyfillSupport,v={Q(e,t){switch(t){case Boolean:e=e?la:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},G(e,t){var n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},x=(e,t)=>!da(e,t),y={F:!0,type:String,l:v,reflect:!1,useDefault:!1,N:x},na;(na=Symbol).metadata??(na.metadata=Symbol(`metadata`)),u.litPropertyMetadata??=new WeakMap;function z(e){if(!e.hasOwnProperty(`elementProperties`)){var t=ja(e);oa(t),t.n!==void 0&&(e.n=[...t.n]),e.i=new Map(t.i)}}function oa(e){if(!e.hasOwnProperty(`finalized`)){if(e.finalized=!0,z(e),e.hasOwnProperty(`properties`)){var t=e.g,n=[...ha(t),...ia(t)];for(let i of n)pa(e,i,t[i])}if(t=e[Symbol.metadata],t!==null&&(t=globalThis.litPropertyMetadata.get(t),t!==void 0))for(let[n,i]of t)e.i.set(n,i);e.e=new Map;for(let[n,i]of e.i)t=C(n,i),t!==void 0&&e.e.set(t,n);if(n=e.h,t=[],Array.isArray(n)){n=new Set(n.flat(1/0).reverse());for(let e of n)t.unshift(ca(e))}else n!==void 0&&t.push(ca(n));e.elementStyles=t}}function qa(e,t,n){var i=Symbol(),{get:a,set:o}=fa(e.prototype,t)??{get(){return this[i]},set(e){this[i]=e}};return{get:a,set(e){var i=a?.call(this);o?.call(this,e),D(this,t,i,n)},configurable:!0,enumerable:!0}}function pa(e,t,n=y){n.state&&(n.F=!1),z(e),e.prototype.hasOwnProperty(t)&&((n=Object.create(n)).wrapped=!0),e.i.set(t,n),n.ka||(n=qa(e,t,n),n!==void 0&&ea(e.prototype,t,n))}function D(e,t,n,i,a=!1,o){if(t!==void 0){let s=e.constructor;if(!1===a&&(o=e[t]),i??=s.i.get(t)??y,!((i.N??x)(o,n)||i.useDefault&&i.reflect&&o===e.u?.get(t)&&!e.hasAttribute(C(t,i))))return;E(e,t,n,i)}!1===e.o&&(e.J=ra(e))}function C(e,t){return t=t.F,!1===t?void 0:typeof t==`string`?t:typeof e==`string`?e.toLowerCase():void 0}function sa(e){e.J=new Promise(t=>e.K=t),e.g=new Map,ua(e),D(e),e.constructor.n?.forEach(t=>t(e))}function ua(e){var t=new Map,n=e.constructor.i;for(let i of n.keys())e.hasOwnProperty(i)&&(t.set(i,e[i]),delete e[i]);t.size>0&&(e.v=t)}function E(e,t,n,{useDefault:i,reflect:a,wrapped:o},s){i&&!(e.u??=new Map).has(t)&&(e.u.set(t,s??n??e[t]),!0!==o||s!==void 0)||(e.g.has(t)||(e.h||i||(n=void 0),e.g.set(t,n)),!0===a&&e.e!==t&&(e.w??=new Set).add(t))}async function ra(e){e.o=!0;try{await e.J}catch(e){Promise.reject(e)}var t=va(e);return t!=null&&await t,!e.o}function va(e){if(e.o){if(!e.h){if(e.y??=e.x(),e.v){for(let[t,n]of e.v)e[t]=n;e.v=void 0}var t=e.constructor.i;if(t.size>0)for(let[n,i]of t)t=e[n],!0!==i.wrapped||e.g.has(n)||t===void 0||E(e,n,void 0,i,t)}t=!1;var n=e.g;try{t=!0,e.A?.forEach(e=>e.ha?.()),e.I(n)}catch(n){throw t=!1,wa(e),n}t&&xa(e)}}function wa(e){e.g=new Map,e.o=!1}function xa(e){e.A?.forEach(e=>e.ia?.()),e.h||=!0}class F extends HTMLElement{static addInitializer(e){z(this),(this.n??=[]).push(e)}static get observedAttributes(){return oa(this),this.e&&[...this.e.keys()]}constructor(){super(),this.v=void 0,this.h=this.o=!1,this.e=null,sa(this)}x(){var e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ba(e,this.constructor.elementStyles),e}connectedCallback(){this.y??=this.x(),this.K(!0),this.A?.forEach(e=>e.fa?.())}K(){}disconnectedCallback(){this.A?.forEach(e=>e.ga?.())}attributeChangedCallback(e,t,n){if(t=this.constructor,e=t.e.get(e),e!==void 0&&this.e!==e){t=t.i.get(e)??y;let i=typeof t.l==`function`?{G:t.l}:t.l?.G===void 0?v:t.l;this.e=e,n=i.G(n,t.type),this[e]=n??this.u?.get(e)??n,this.e=null}}I(){this.w&&=this.w.forEach(e=>{var t=this[e],n=this.constructor.i.get(e),i=C(e,n);i!==void 0&&!0===n.reflect&&(t=(n.l?.Q===void 0?v:n.l).Q(t,n.type),this.e=e,t==null?this.removeAttribute(i):this.setAttribute(i,t),this.e=null)}),wa(this)}}F.elementStyles=[],F.shadowRootOptions={mode:`open`},F.elementProperties=new Map,F.finalized=new Map,ma?.({$:F}),(u.h??=[]).push(`2.1.2`);var ya={F:!0,type:String,l:v,reflect:!1,N:x},za=(e=ya,t,n)=>{var i=n.kind,a=n.metadata,o=globalThis.litPropertyMetadata.get(a);if(o===void 0&&globalThis.litPropertyMetadata.set(a,o=new Map),i===`setter`&&((e=Object.create(e)).wrapped=!0),o.set(n.name,e),i===`accessor`){let i=n.name;return{set(n){var a=t.get.call(this);t.set.call(this,n),D(this,i,a,e,!0,n)},ja(t){return t!==void 0&&E(this,i,void 0,e,t),t}}}if(i===`setter`){let i=n.name;return function(n){var a=this[i];t.call(this,n),D(this,i,a,e,!0,n)}}throw Error(`Unsupported decorator location: `+i)},G=globalThis,H=G.trustedTypes,Aa=H?H.createPolicy(`lit-html`,{createHTML:e=>e}):void 0,I=`lit$${Math.random().toFixed(9).slice(2)}$`,Ba=`?`+I,Ca=`<${Ba}>`,J=document,K=e=>e===null||typeof e!=`object`&&typeof e!=`function`,L=Array.isArray,M=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Da=/--\x3e/g,Ea=/>/g,N=RegExp(`>|[ 	
\f\r](?:([^\\s"'>=/]+)([ 	
\f\r]*=[ 	
\f\r]*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,`g`),Fa=/'/g,Ga=/"/g,Ha=/^(?:script|style|textarea|title)$/i,Ia=(e=>(t,...n)=>({_$litType$:e,strings:t,values:n}))(1),O=Symbol.for(`lit-noChange`),P=Symbol.for(`lit-nothing`),Ja=new WeakMap,Q=J.createTreeWalker(J,129);function Ka(e,t){if(!L(e)||!e.hasOwnProperty(`raw`))throw Error(`invalid template strings array`);return Aa===void 0?t:Aa.createHTML(t)}function La(e){var t=J.createElement(`template`);return t.innerHTML=e,t}class Ma{constructor({strings:e,_$litType$:t}){this.parts=[];var n=0,i=0,a=e.length-1,o=this.parts,s=e.length-1,c=[],d,f=t===2?`<svg>`:t===3?`<math>`:``,m=M;for(let t=0;t<s;t++){let n=e[t],i,a,o=-1;for(var h=0;h<n.length&&(m.lastIndex=h,a=m.exec(n),a!==null);)h=m.lastIndex,m===M?a[1]===`!--`?m=Da:a[1]===void 0?a[2]===void 0?a[3]!==void 0&&(m=N):(Ha.test(a[2])&&(d=RegExp(`</`+a[2],`g`)),m=N):m=Ea:m===N?a[0]===`>`?(m=d??M,o=-1):a[1]===void 0?o=-2:(o=m.lastIndex-a[2].length,i=a[1],m=a[3]===void 0?N:a[3]===`"`?Ga:Fa):m===Ga||m===Fa?m=N:m===Da||m===Ea?m=M:(m=N,d=void 0);h=m===N&&e[t+1].startsWith(`/>`)?` `:``,f+=m===M?n+Ca:o>=0?(c.push(i),n.slice(0,o)+`$lit$`+n.slice(o)+I+h):n+I+(o===-2?t:h)}e=[Ka(e,f+(e[s]||`<?>`)+(t===2?`</svg>`:t===3?`</math>`:``)),c];var[g,_]=e;for(this.el=La(g),Q.currentNode=this.el.content,(t===2||t===3)&&(t=this.el.content.firstChild,t.replaceWith(...t.childNodes));(t=Q.nextNode())!==null&&o.length<a;){if(t.nodeType===1){if(t.hasAttributes())for(let a of t.getAttributeNames())a.endsWith(`$lit$`)?(s=_[i++],e=t.getAttribute(a).split(I),s=/([.?@])?(.*)/.exec(s),o.push({type:1,index:n,name:s[2],strings:e,W:s[1]===`.`?Na:s[1]===`?`?Oa:s[1]===`@`?Ra:R}),t.removeAttribute(a)):a.startsWith(I)&&(o.push({type:6,index:n}),t.removeAttribute(a));if(Ha.test(t.tagName)&&(e=t.textContent.split(I),s=e.length-1,s>0)){for(t.textContent=H?H.emptyScript:``,c=0;c<s;c++)t.append(e[c],J.createComment(``)),Q.nextNode(),o.push({type:2,index:++n});t.append(e[s],J.createComment(``))}}else if(t.nodeType===8)if(t.data===Ba)o.push({type:2,index:n});else for(e=-1;(e=t.data.indexOf(I,e+1))!==-1;)o.push({type:7,index:n}),e+=I.length-1;n++}}}function S(e,t,n=e,i){if(t===O)return t;var a=i===void 0?n.T:n.M?.[i],o=K(t)?void 0:t.da;return a?.constructor!==o&&(a?.aa?.(!1),o===void 0?a=void 0:(a=new o(e),a.ca(e,n,i)),i===void 0?n.T=a:(n.M??=[])[i]=a),a!==void 0&&(t=S(e,a.ba(e,t.values),a,i)),t}class Sa{constructor(e){this.e=[],this.D=e}p(e){var t=0;for(let n of this.e)n!==void 0&&(n.strings===void 0?n.j(e[t]):(n.j(e,n,t),t+=n.strings.length-2)),t++}}function T(e,t=e.g.nextSibling,n){for(e.u?.(!1,!0,n);t!==e.C;)n=t.nextSibling,t.remove(),t=n}function Ta(e,t){e.e!==P&&K(e.e)?e.g.nextSibling.data=t:U(e,J.createTextNode(t)),e.e=t}function U(e,t){e.e!==t&&(T(e),e.e=V(e,t))}function V(e,t){return e.g.parentNode.insertBefore(t,e.C)}class W{constructor(e,t,n,i){this.type=2,this.e=P,this.g=e,this.C=t,this.o=n,this.h=i}j(e,t=this){if(e=S(this,e,t),K(e))e===P||e==null||e===``?(this.e!==P&&T(this),this.e=P):e!==this.e&&e!==O&&Ta(this,e);else if(e._$litType$!==void 0){t=e.values;var n=e._$litType$;if(typeof n==`number`?(n=e,e=Ja.get(n.strings),n=(e===void 0&&Ja.set(n.strings,e=new Ma(n)),e)):n=(n.el===void 0&&(n.el=La(Ka(n.Y,n.Y[0]))),n),e=n,this.e?.D===e)this.e.p(t);else{e=new Sa(e);var i;n=e;var a=this.h;let o=n.D.parts,s=(a?.ea??J).importNode(n.D.el.content,!0);Q.currentNode=s;let c=Q.nextNode(),d=0,f=0,m=o[0];for(;m!==void 0;)d===m.index&&(m.type===2?i=new W(c,c.nextSibling,n,a):m.type===1?i=new m.W(c,m.name,m.strings,n,a):m.type===6&&(i=new Ua(c)),n.e.push(i),m=o[++f]),d!==m?.index&&(c=Q.nextNode(),d++);i=(Q.currentNode=J,s),e.p(t),U(this,i),this.e=e}}else e.nodeType===void 0?L(e)||typeof e?.[Symbol.iterator]==`function`?this.k(e):Ta(this,e):U(this,e)}k(e){L(this.e)||(this.e=[],T(this));var t=this.e,n,i=0;for(let a of e)i===t.length?t.push(n=new W(V(this,J.createComment(``)),V(this,J.createComment(``)),this,this.h)):n=t[i],n.j(a),i++;i<t.length&&(T(this,n&&n.C.nextSibling,i),t.length=i)}P(e){this.o===void 0&&this.u?.(e)}}class R{constructor(e,t,n,i,a){this.type=1,this.e=P,this.element=e,this.name=t,this.g=a,n.length>2||n[0]!==``||n[1]!==``?(this.e=Array(n.length-1).fill(new String),this.strings=n):this.e=P}j(e,t=this,n){var i=this.strings,a=!1;if(i===void 0)e=S(this,e,t,0),(a=!K(e)||e!==this.e&&e!==O)&&(this.e=e);else{let o=e,s,c;for(e=i[0],s=0;s<i.length-1;s++)c=S(this,o[n+s],t,s),c===O&&(c=this.e[s]),a||=!K(c)||c!==this.e[s],c===P?e=P:e!==P&&(e+=(c??``)+i[s+1]),this.e[s]=c}a&&this.m(e)}m(e){e===P?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??``)}}class Na extends R{constructor(){super(...arguments),this.type=3}m(e){this.element[this.name]=e===P?void 0:e}}class Oa extends R{constructor(){super(...arguments),this.type=4}m(e){this.element.toggleAttribute(this.name,!!e&&e!==P)}}class Ra extends R{constructor(e,t,n,i,a){super(e,t,n,i,a),this.type=5}j(e,t=this){if((e=S(this,e,t,0)??P)!==O){t=this.e;var n=e===P&&t!==P||e.capture!==t.capture||e.once!==t.once||e.passive!==t.passive,i=e!==P&&(t===P||n);n&&this.element.removeEventListener(this.name,this,t),i&&this.element.addEventListener(this.name,this,e),this.e=e}}handleEvent(e){typeof this.e==`function`?this.e.call(this.g?.host??this.element,e):this.e.handleEvent(e)}}class Ua{constructor(e){this.element=e,this.type=6}j(e){S(this,e)}}(0,G.litHtmlPolyfillSupport)?.(Ma,W),(G.g??=[]).push(`3.3.3`);var X=globalThis;class Y extends F{constructor(){super(...arguments),this.B={host:this},this.z=void 0}x(){var e=super.x(),t;return(t=this.B).H??(t.H=e.firstChild),e}I(e){var t=this.L();this.h||(this.B.isConnected=this.isConnected),super.I(e),e=this.y;var n=this.B,i=n?.H??e,a=i.V;a===void 0&&(a=n?.H??null,i.V=a=new W(e.insertBefore(J.createComment(``),a),a,void 0,n??{})),this.z=(a.j(t),a)}connectedCallback(){super.connectedCallback(),this.z?.P(!0)}disconnectedCallback(){super.disconnectedCallback(),this.z?.P(!1)}L(){return O}}Y.finalized=!0,X.litElementHydrateSupport?.({S:Y}),(0,X.litElementPolyfillSupport)?.({S:Y}),(X.e??=[]).push(`4.2.2`);function Va(e,t,n,i){var a=arguments.length,o=a<3?t:i===null?i=Object.getOwnPropertyDescriptor(t,n):i,s;if(typeof Reflect==`object`&&typeof Reflect.X==`function`)o=Reflect.X(e,t,n,i);else for(var c=e.length-1;c>=0;c--)(s=e[c])&&(o=(a<3?s(o):a>3?s(t,n,o):s(t,n))||o);return a>3&&o&&Object.defineProperty(t,n,o),o}var Wa=class extends Y{constructor(...e){super(...e),this.count=0}L(){return Ia`
      <section id="center">
        <div class="hero">
          <img src=${`/assets/hero-CLDdwZDr.png`} class="base" width="170" height="179" alt="" />
          <img src=${`data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20xmlns:xlink='http://www.w3.org/1999/xlink'%20aria-hidden='true'%20role='img'%20class='iconify%20iconify--logos'%20width='25.6'%20height='32'%20preserveAspectRatio='xMidYMid%20meet'%20viewBox='0%200%20256%20320'%3e%3cpath%20fill='%2300E8FF'%20d='m64%20192l25.926-44.727l38.233-19.114l63.974%2063.974l10.833%2061.754L192%20320l-64-64l-38.074-25.615z'%3e%3c/path%3e%3cpath%20fill='%23283198'%20d='M128%20256V128l64-64v128l-64%2064ZM0%20256l64%2064l9.202-60.602L64%20192l-37.542%2023.71L0%20256Z'%3e%3c/path%3e%3cpath%20fill='%23324FFF'%20d='M64%20192V64l64-64v128l-64%2064Zm128%20128V192l64-64v128l-64%2064ZM0%20256V128l64%2064l-64%2064Z'%3e%3c/path%3e%3cpath%20fill='%230FF'%20d='M64%20320V192l64%2064z'%3e%3c/path%3e%3c/svg%3e`} class="framework" alt="Lit logo" />
          <img src=${`/assets/vite-BF8QNONU.svg`} class="vite" alt="Vite logo" />
        </div>
        <div>
          <slot></slot>
          <p>
            Edit <code>src/my-element.ts</code> and save to test
            <code>HMR</code>
          </p>
        </div>
        <button
          type="button"
          class="counter"
          @click=${this.R}
          part="button"
        >
          Count is ${this.count}
        </button>
      </section>

      <div class="ticks"></div>

      <section id="next-steps">
        <div id="docs">
          <svg class="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#documentation-icon"></use>
          </svg>
          <h2>Documentation</h2>
          <p>Your questions, answered</p>
          <ul>
            <li>
              <a href="https://vite.dev/" target="_blank">
                <img class="logo" src=${`/assets/vite-BF8QNONU.svg`} alt="" />
                Explore Vite
              </a>
            </li>
            <li>
              <a href="https://lit.dev/" target="_blank">
                <img class="button-icon" src=${`data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20xmlns:xlink='http://www.w3.org/1999/xlink'%20aria-hidden='true'%20role='img'%20class='iconify%20iconify--logos'%20width='25.6'%20height='32'%20preserveAspectRatio='xMidYMid%20meet'%20viewBox='0%200%20256%20320'%3e%3cpath%20fill='%2300E8FF'%20d='m64%20192l25.926-44.727l38.233-19.114l63.974%2063.974l10.833%2061.754L192%20320l-64-64l-38.074-25.615z'%3e%3c/path%3e%3cpath%20fill='%23283198'%20d='M128%20256V128l64-64v128l-64%2064ZM0%20256l64%2064l9.202-60.602L64%20192l-37.542%2023.71L0%20256Z'%3e%3c/path%3e%3cpath%20fill='%23324FFF'%20d='M64%20192V64l64-64v128l-64%2064Zm128%20128V192l64-64v128l-64%2064ZM0%20256V128l64%2064l-64%2064Z'%3e%3c/path%3e%3cpath%20fill='%230FF'%20d='M64%20320V192l64%2064z'%3e%3c/path%3e%3c/svg%3e`} alt="" />
                Learn more
              </a>
            </li>
          </ul>
        </div>
        <div id="social">
          <svg class="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#social-icon"></use>
          </svg>
          <h2>Connect with us</h2>
          <p>Join the Vite community</p>
          <ul>
            <li>
              <a href="https://github.com/vitejs/vite" target="_blank">
                <svg class="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#github-icon"></use>
                </svg>
                GitHub
              </a>
            </li>
            <li>
              <a href="https://chat.vite.dev/" target="_blank">
                <svg class="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#discord-icon"></use>
                </svg>
                Discord
              </a>
            </li>
            <li>
              <a href="https://x.com/vite_js" target="_blank">
                <svg class="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#x-icon"></use>
                </svg>
                X.com
              </a>
            </li>
            <li>
              <a href="https://bsky.app/profile/vite.dev" target="_blank">
                <svg class="button-icon" role="presentation" aria-hidden="true">
                  <use href="/icons.svg#bluesky-icon"></use>
                </svg>
                Bluesky
              </a>
            </li>
          </ul>
        </div>
      </section>

      <div class="ticks"></div>
      <section id="spacer"></section>
    `}R(){this.count++}},Z=(((e,...t)=>(t=e.length===1?e[0]:t.reduce((t,n,i)=>{if(!0===n.U)n=n.cssText;else if(typeof n!=`number`)throw Error(`Value passed to 'css' function must be a 'css' function result: `+n+`. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`);return t+n+e[i+1]},e[0]),new aa(t)))`
    :host {
      --text: #6b6375;
      --text-h: #08060d;
      --bg: #fff;
      --border: #e5e4e7;
      --code-bg: #f4f3ec;
      --accent: #aa3bff;
      --accent-bg: rgba(170, 59, 255, 0.1);
      --accent-border: rgba(170, 59, 255, 0.5);
      --social-bg: rgba(244, 243, 236, 0.5);
      --shadow:
        rgba(0, 0, 0, 0.1) 0 10px 15px -3px, rgba(0, 0, 0, 0.05) 0 4px 6px -2px;

      --sans: system-ui, 'Segoe UI', Roboto, sans-serif;
      --heading: system-ui, 'Segoe UI', Roboto, sans-serif;
      --mono: ui-monospace, Consolas, monospace;

      font: 18px/145% var(--sans);
      letter-spacing: 0.18px;

      width: 1126px;
      max-width: 100%;
      margin: 0 auto;
      text-align: center;
      border-inline: 1px solid var(--border);
      min-height: 100svh;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      color: var(--text);
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --text: #9ca3af;
        --text-h: #f3f4f6;
        --bg: #16171d;
        --border: #2e303a;
        --code-bg: #1f2028;
        --accent: #c084fc;
        --accent-bg: rgba(192, 132, 252, 0.15);
        --accent-border: rgba(192, 132, 252, 0.5);
        --social-bg: rgba(47, 48, 58, 0.5);
        --shadow:
          rgba(0, 0, 0, 0.4) 0 10px 15px -3px,
          rgba(0, 0, 0, 0.25) 0 4px 6px -2px;
      }

      #social .button-icon {
        filter: invert(1) brightness(2);
      }
    }

    h1,
    h2,
    ::slotted(h1),
    ::slotted(h2) {
      font-family: var(--heading);
      font-weight: 500;
      color: var(--text-h);
    }

    h1,
    ::slotted(h1) {
      font-size: 56px;
      letter-spacing: -1.68px;
      margin: 32px 0;
    }

    h2 {
      font-size: 24px;
      line-height: 118%;
      letter-spacing: -0.24px;
      margin: 0 0 8px;
    }

    p {
      margin: 0;
    }

    code {
      font-family: var(--mono);
      font-size: 15px;
      line-height: 135%;
      display: inline-flex;
      padding: 4px 8px;
      border-radius: 4px;
      color: var(--text-h);
      background: var(--code-bg);
    }

    .counter {
      font-family: var(--mono);
      font-size: 16px;
      display: inline-flex;
      padding: 5px 10px;
      border-radius: 5px;
      color: var(--accent);
      background: var(--accent-bg);
      border: 2px solid transparent;
      transition: border-color 0.3s;
      margin-bottom: 24px;
      cursor: pointer;
    }

    .counter:hover {
      border-color: var(--accent-border);
    }

    .counter:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .hero {
      position: relative;
    }

    .hero .base,
    .hero .framework,
    .hero .vite {
      inset-inline: 0;
      margin: 0 auto;
    }

    .hero .base {
      width: 170px;
      position: relative;
      z-index: 0;
    }

    .hero .framework,
    .hero .vite {
      position: absolute;
    }

    .hero .framework {
      z-index: 1;
      top: 34px;
      height: 28px;
      transform: perspective(2000px) rotateZ(300deg) rotateX(44deg)
        rotateY(39deg) scale(1.4);
    }

    .hero .vite {
      z-index: 0;
      top: 107px;
      height: 26px;
      width: auto;
      color: var(--vite-logo);
      transform: perspective(2000px) rotateZ(300deg) rotateX(40deg)
        rotateY(39deg) scale(0.8);
    }

    #center {
      display: flex;
      flex-direction: column;
      gap: 25px;
      place-content: center;
      place-items: center;
      flex-grow: 1;
    }

    #next-steps {
      display: flex;
      border-top: 1px solid var(--border);
      text-align: left;
    }

    #next-steps > div {
      flex: 1 1 0;
      padding: 32px;
    }

    #next-steps .icon {
      margin-bottom: 16px;
      width: 22px;
      height: 22px;
    }

    #docs {
      border-right: 1px solid var(--border);
    }

    #next-steps ul {
      list-style: none;
      padding: 0;
      display: flex;
      gap: 8px;
      margin: 32px 0 0;
    }

    #next-steps ul .logo {
      height: 18px;
    }

    #next-steps ul .logo svg {
      height: 100%;
      width: auto;
    }

    #next-steps ul a {
      color: var(--text-h);
      font-size: 16px;
      border-radius: 6px;
      background: var(--social-bg);
      display: flex;
      padding: 6px 12px;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      transition: box-shadow 0.3s;
    }

    #next-steps ul a:hover {
      box-shadow: var(--shadow);
    }

    #next-steps ul .button-icon {
      height: 18px;
      width: 18px;
    }

    #spacer {
      height: 88px;
      border-top: 1px solid var(--border);
    }

    .ticks {
      position: relative;
      width: 100%;
    }

    .ticks::before,
    .ticks::after {
      content: '';
      position: absolute;
      top: -4.5px;
      border: 5px solid transparent;
    }

    .ticks::before {
      left: 0;
      border-left-color: var(--border);
    }

    .ticks::after {
      right: 0;
      border-right-color: var(--border);
    }

    @media (max-width: 1024px) {
      :host {
        font-size: 16px;
        width: 100%;
        max-width: 100%;
      }

      h1,
      ::slotted(h1) {
        font-size: 36px;
        margin: 20px 0;
      }

      h2,
      ::slotted(h2) {
        font-size: 20px;
      }

      #center {
        padding: 32px 20px 24px;
        gap: 18px;
      }

      #next-steps {
        flex-direction: column;
        text-align: center;
      }

      #next-steps > div {
        padding: 24px 20px;
      }

      #docs {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }

      #next-steps ul {
        margin-top: 20px;
        flex-wrap: wrap;
        justify-content: center;
      }

      #next-steps ul li {
        flex: 1 1 calc(50% - 8px);
      }

      #next-steps ul a {
        width: 100%;
        justify-content: center;
        box-sizing: border-box;
      }

      #spacer {
        height: 48px;
      }
    }
  `,Wa);Va([function(e){return(t,n)=>{if(typeof n==`object`)t=za(e,t,n);else{let i=t.hasOwnProperty(n);t=(pa(t.constructor,n,e),i?Object.getOwnPropertyDescriptor(t,n):void 0)}return t}}({type:Number})],Z.prototype,`count`,void 0),Z=Va([(e=>(t,n)=>{n===void 0?customElements.define(e,t):n.addInitializer(()=>{customElements.define(e,t)})})(`my-element`)],Z);export{};