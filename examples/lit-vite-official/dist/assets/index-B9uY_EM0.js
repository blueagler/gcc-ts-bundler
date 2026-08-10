function l(e,t,n,i){var a=arguments.length,o=a<3?t:i===null?i=Object.getOwnPropertyDescriptor(t,n):i,s;if(typeof Reflect==`object`&&typeof Reflect.da==`function`)o=Reflect.da(e,t,n,i);else for(var c=e.length-1;c>=0;c--)(s=e[c])&&(o=(a<3?s(o):a>3?s(t,n,o):s(t,n))||o);return a>3&&o&&Object.defineProperty(t,n,o),o}var p=globalThis,r=p.ShadowRoot&&(p.ShadyCSS===void 0||p.ShadyCSS.nativeShadow)&&`adoptedStyleSheets`in Document.prototype&&`replace`in CSSStyleSheet.prototype,u=Symbol(),aa=new WeakMap;class ba{constructor(e,t){if(this.aa=!0,u!==u)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.e=t}get styleSheet(){var e=this.g,n=this.e;if(r&&e===void 0){let t=n!==void 0&&n.length===1;t&&(e=aa.get(n)),e===void 0&&((this.g=e=new CSSStyleSheet).replaceSync(this.cssText),t&&aa.set(n,e))}return e}toString(){return this.cssText}}var ca=(n,i)=>{if(r)n.adoptedStyleSheets=i.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(let t of i){i=document.createElement(`style`);let a=p.litNonce;a!==void 0&&i.setAttribute(`nonce`,a),i.textContent=t.cssText,n.appendChild(i)}},da=r?e=>e:e=>{if(e instanceof CSSStyleSheet){let t=``;for(let n of e.cssRules)t+=n.cssText;e=new ba(t)}return e},ea=Object.is,fa=Object.defineProperty,ha=Object.getOwnPropertyDescriptor,ia=Object.getOwnPropertyNames,ja=Object.getOwnPropertySymbols,ka=Object.getPrototypeOf,v=globalThis,la=v.trustedTypes,ma=la?la.emptyScript:``,na=v.reactiveElementPolyfillSupport,x={W(e,t){switch(t){case Boolean:e=e?ma:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},K(e,t){var n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},y=(e,t)=>!ea(e,t),z={J:!0,type:String,n:x,y:!1,X:!1,S:y},oa;(oa=Symbol).metadata??(oa.metadata=Symbol(`metadata`)),v.e??=new WeakMap;function C(e){if(!e.hasOwnProperty(`elementProperties`)){var t=ka(e);pa(t),t.u!==void 0&&(e.u=[...t.u]),e.j=new Map(t.j)}}function pa(e){if(!e.hasOwnProperty(`finalized`)){if(e.finalized=!0,C(e),e.hasOwnProperty(`properties`)){var t=e.g,n=[...ia(t),...ja(t)];for(let i of n)qa(e,i,t[i])}if(t=e[Symbol.metadata],t!==null&&(t=globalThis.e.get(t),t!==void 0))for(let[n,i]of t)e.j.set(n,i);e.e=new Map;for(let[n,i]of e.j)t=D(n,i),t!==void 0&&e.e.set(t,n);if(n=e.h,t=[],Array.isArray(n)){n=new Set(n.flat(1/0).reverse());for(let e of n)t.unshift(da(e))}else n!==void 0&&t.push(da(n));e.elementStyles=t}}function ra(e,t,n){var i=Symbol(),{get:a,set:o}=ha(e.prototype,t)??{get(){return this[i]},set(e){this[i]=e}};return{get:a,set(e){var i=a?.call(this);o?.call(this,e),E(this,t,i,n)},configurable:!0,enumerable:!0}}function qa(e,t,n=z){n.state&&(n.J=!1),C(e),e.prototype.hasOwnProperty(t)&&((n=Object.create(n)).M=!0),e.j.set(t,n),n.sa||(n=ra(e,t,n),n!==void 0&&fa(e.prototype,t,n))}function E(e,t,n,i,a=!1,o){if(t!==void 0){let s=e.constructor;if(!1===a&&(o=e[t]),i??=s.j.get(t)??z,!((i.S??y)(o,n)||i.X&&i.y&&o===e.v?.get(t)&&!e.hasAttribute(D(t,i))))return;F(e,t,n,i)}!1===e.i&&(e.O=sa(e))}function D(e,t){return t=t.J,!1===t?void 0:typeof t==`string`?t:typeof e==`string`?e.toLowerCase():void 0}function ta(e){e.O=new Promise(t=>e.P=t),e.g=new Map,va(e),E(e),e.constructor.u?.forEach(t=>t(e))}function va(e){var t=new Map,n=e.constructor.j;for(let i of n.keys())e.hasOwnProperty(i)&&(t.set(i,e[i]),delete e[i]);t.size>0&&(e.z=t)}function F(e,t,n,{X:i,y:a,M:o},s){i&&!(e.v??=new Map).has(t)&&(e.v.set(t,s??n??e[t]),!0!==o||s!==void 0)||(e.g.has(t)||(e.h||i||(n=void 0),e.g.set(t,n)),!0===a&&e.e!==t&&(e.A??=new Set).add(t))}async function sa(e){e.i=!0;try{await e.O}catch(e){Promise.reject(e)}var t=wa(e);return t!=null&&await t,!e.i}function wa(e){if(e.i){if(!e.h){if(e.C??=e.B(),e.z){for(let[t,n]of e.z)e[t]=n;e.z=void 0}var t=e.constructor.j;if(t.size>0)for(let[n,i]of t)t=e[n],!0!==i.M||e.g.has(n)||t===void 0||F(e,n,void 0,i,t)}t=!1;var n=e.g;try{t=!0,e.F?.forEach(e=>e.oa?.()),e.N(n)}catch(n){throw t=!1,xa(e),n}t&&ya(e)}}function xa(e){e.g=new Map,e.i=!1}function ya(e){e.F?.forEach(e=>e.pa?.()),e.h||=!0}class G extends HTMLElement{static addInitializer(e){C(this),(this.u??=[]).push(e)}static get observedAttributes(){return pa(this),this.e&&[...this.e.keys()]}constructor(){super(),this.z=void 0,this.h=this.i=!1,this.e=null,ta(this)}B(){var e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ca(e,this.constructor.elementStyles),e}connectedCallback(){this.C??=this.B(),this.P(!0),this.F?.forEach(e=>e.ma?.())}P(){}disconnectedCallback(){this.F?.forEach(e=>e.na?.())}attributeChangedCallback(e,t,n){if(t=this.constructor,e=t.e.get(e),e!==void 0&&this.e!==e){t=t.j.get(e)??z;let i=typeof t.n==`function`?{K:t.n}:t.n?.K===void 0?x:t.n;this.e=e,n=i.K(n,t.type),this[e]=n??this.v?.get(e)??n,this.e=null}}N(){this.A&&=this.A.forEach(e=>{var t=this[e],n=this.constructor.j.get(e),i=D(e,n);i!==void 0&&!0===n.y&&(t=(n.n?.W===void 0?x:n.n).W(t,n.type),this.e=e,t==null?this.removeAttribute(i):this.setAttribute(i,t),this.e=null)}),xa(this)}}G.elementStyles=[],G.shadowRootOptions={mode:`open`},G.elementProperties=new Map,G.finalized=new Map,na?.({ga:G}),(v.i??=[]).push(`2.1.2`);var za={J:!0,type:String,n:x,y:!1,S:y},Aa=(e=za,t,n)=>{var i=n.ra,a=n.metadata,o=globalThis.e.get(a);if(o===void 0&&globalThis.e.set(a,o=new Map),i===`setter`&&((e=Object.create(e)).M=!0),o.set(n.name,e),i===`accessor`){let i=n.name;return{set(n){var a=t.get.call(this);t.set.call(this,n),E(this,i,a,e,!0,n)},qa(t){return t!==void 0&&F(this,i,void 0,e,t),t}}}if(i===`setter`){let i=n.name;return function(n){var a=this[i];t.call(this,n),E(this,i,a,e,!0,n)}}throw Error(`Unsupported decorator location: `+i)},H=globalThis,I=H.trustedTypes,Ba=I?I.createPolicy(`lit-html`,{createHTML:e=>e}):void 0,J=`lit$${Math.random().toFixed(9).slice(2)}$`,Ca=`?`+J,Da=`<${Ca}>`,K=document,L=e=>e===null||typeof e!=`object`&&typeof e!=`function`,M=Array.isArray,N=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Ea=/--\x3e/g,Fa=/>/g,O=RegExp(`>|[ 	
\f\r](?:([^\\s"'>=/]+)([ 	
\f\r]*=[ 	
\f\r]*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,`g`),Ga=/'/g,Ha=/"/g,Ia=/^(?:script|style|textarea|title)$/i,Ja=(e=>(t,...n)=>({I:e,l:t,values:n}))(1),P=Symbol.for(`lit-noChange`),Q=Symbol.for(`lit-nothing`),Ka=new WeakMap,R=K.createTreeWalker(K,129);function La(e,t){if(!M(e)||!e.hasOwnProperty(`raw`))throw Error(`invalid template strings array`);return Ba===void 0?t:Ba.createHTML(t)}function Ma(e){var t=K.createElement(`template`);return t.innerHTML=e,t}class Na{constructor({l:e,I:t}){this.U=[];var n=0,i=0,a=e.length-1,o=this.U,s=e.length-1,c=[],d,f=t===2?`<svg>`:t===3?`<math>`:``,m=N;for(let t=0;t<s;t++){let n=e[t],i,a,o=-1;for(var h=0;h<n.length&&(m.lastIndex=h,a=m.exec(n),a!==null);)h=m.lastIndex,m===N?a[1]===`!--`?m=Ea:a[1]===void 0?a[2]===void 0?a[3]!==void 0&&(m=O):(Ia.test(a[2])&&(d=RegExp(`</`+a[2],`g`)),m=O):m=Fa:m===O?a[0]===`>`?(m=d??N,o=-1):a[1]===void 0?o=-2:(o=m.lastIndex-a[2].length,i=a[1],m=a[3]===void 0?O:a[3]===`"`?Ha:Ga):m===Ha||m===Ga?m=O:m===Ea||m===Fa?m=N:(m=O,d=void 0);h=m===O&&e[t+1].startsWith(`/>`)?` `:``,f+=m===N?n+Da:o>=0?(c.push(i),n.slice(0,o)+`$lit$`+n.slice(o)+J+h):n+J+(o===-2?t:h)}e=[La(e,f+(e[s]||`<?>`)+(t===2?`</svg>`:t===3?`</math>`:``)),c];var[g,_]=e;for(this.x=Ma(g),R.currentNode=this.x.content,(t===2||t===3)&&(t=this.x.content.firstChild,t.replaceWith(...t.childNodes));(t=R.nextNode())!==null&&o.length<a;){if(t.nodeType===1){if(t.hasAttributes())for(let a of t.getAttributeNames())a.endsWith(`$lit$`)?(s=_[i++],e=t.getAttribute(a).split(J),s=/([.?@])?(.*)/.exec(s),o.push({type:1,index:n,name:s[2],l:e,ca:s[1]===`.`?Oa:s[1]===`?`?Ra:s[1]===`@`?Sa:S}),t.removeAttribute(a)):a.startsWith(J)&&(o.push({type:6,index:n}),t.removeAttribute(a));if(Ia.test(t.tagName)&&(e=t.textContent.split(J),s=e.length-1,s>0)){for(t.textContent=I?I.emptyScript:``,c=0;c<s;c++)t.append(e[c],K.createComment(``)),R.nextNode(),o.push({type:2,index:++n});t.append(e[s],K.createComment(``))}}else if(t.nodeType===8)if(t.data===Ca)o.push({type:2,index:n});else for(e=-1;(e=t.data.indexOf(J,e+1))!==-1;)o.push({type:7,index:n}),e+=J.length-1;n++}}}function T(e,t,n=e,i){if(t===P)return t;var a=i===void 0?n.$:n.R?.[i],o=L(t)?void 0:t.ka;return a?.constructor!==o&&(a?.ha?.(!1),o===void 0?a=void 0:(a=new o(e),a.ja(e,n,i)),i===void 0?n.$=a:(n.R??=[])[i]=a),a!==void 0&&(t=T(e,a.ia(e,t.values),a,i)),t}class Ta{constructor(e,t){this.e=[],this.H=e,this.g=t}get parentNode(){return this.g.parentNode}p(e){var t=0;for(let n of this.e)n!==void 0&&(n.l===void 0?n.m(e[t]):(n.m(e,n,t),t+=n.l.length-2)),t++}}function U(e,t=e.g.nextSibling,n){for(e.v?.(!1,!0,n);t!==e.w;)n=t.nextSibling,t.remove(),t=n}function Ua(e,t){e.e!==Q&&L(e.e)?e.g.nextSibling.data=t:V(e,K.createTextNode(t)),e.e=t}function V(e,t){e.e!==t&&(U(e),e.e=e.g.parentNode.insertBefore(t,e.w))}class W{constructor(e,t,n,i){this.type=2,this.e=Q,this.g=e,this.w=t,this.h=n,this.i=i}get parentNode(){var e=this.g.parentNode,t=this.h;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}m(e,t=this){if(e=T(this,e,t),L(e))e===Q||e==null||e===``?(this.e!==Q&&U(this),this.e=Q):e!==this.e&&e!==P&&Ua(this,e);else if(e.I!==void 0){t=e.values;var n=e.I;if(typeof n==`number`?(n=e,e=Ka.get(n.l),n=(e===void 0&&Ka.set(n.l,e=new Na(n)),e)):n=(n.x===void 0&&(n.x=Ma(La(n.ea,n.ea[0]))),n),e=n,this.e?.H===e)this.e.p(t);else{e=new Ta(e,this);var i;n=e;var a=this.i;let o=n.H.U,s=(a?.la??K).importNode(n.H.x.content,!0);R.currentNode=s;let c=R.nextNode(),d=0,f=0,m=o[0];for(;m!==void 0;)d===m.index&&(m.type===2?i=new W(c,c.nextSibling,n,a):m.type===1?i=new m.ca(c,m.name,m.l,n,a):m.type===6&&(i=new Va),n.e.push(i),m=o[++f]),d!==m?.index&&(c=R.nextNode(),d++);i=(R.currentNode=K,s),e.p(t),V(this,i),this.e=e}}else e.nodeType===void 0?M(e)||typeof e?.[Symbol.iterator]==`function`?this.k(e):Ua(this,e):V(this,e)}k(e){M(this.e)||(this.e=[],U(this));var t=this.e,n,i=0;for(let a of e)i===t.length?t.push(n=new W(this.g.parentNode.insertBefore(K.createComment(``),this.w),this.g.parentNode.insertBefore(K.createComment(``),this.w),this,this.i)):n=t[i],n.m(a),i++;i<t.length&&(U(this,n&&n.w.nextSibling,i),t.length=i)}V(e){this.h===void 0&&this.v?.(e)}}class S{get tagName(){return this.g.tagName}constructor(e,t,n,i,a){this.type=1,this.e=Q,this.g=e,this.name=t,this.h=a,n.length>2||n[0]!==``||n[1]!==``?(this.e=Array(n.length-1).fill(new String),this.l=n):this.e=Q}m(e,t=this,n){var i=this.l,a=!1;if(i===void 0)e=T(this,e,t,0),(a=!L(e)||e!==this.e&&e!==P)&&(this.e=e);else{let o=e,s,c;for(e=i[0],s=0;s<i.length-1;s++)c=T(this,o[n+s],t,s),c===P&&(c=this.e[s]),a||=!L(c)||c!==this.e[s],c===Q?e=Q:e!==Q&&(e+=(c??``)+i[s+1]),this.e[s]=c}a&&this.o(e)}o(e){e===Q?this.g.removeAttribute(this.name):this.g.setAttribute(this.name,e??``)}}class Oa extends S{constructor(){super(...arguments),this.type=3}o(e){this.g[this.name]=e===Q?void 0:e}}class Ra extends S{constructor(){super(...arguments),this.type=4}o(e){this.g.toggleAttribute(this.name,!!e&&e!==Q)}}class Sa extends S{constructor(e,t,n,i,a){super(e,t,n,i,a),this.type=5}m(e,t=this){if((e=T(this,e,t,0)??Q)!==P){t=this.e;var n=e===Q&&t!==Q||e.capture!==t.capture||e.once!==t.once||e.passive!==t.passive,i=e!==Q&&(t===Q||n);n&&this.g.removeEventListener(this.name,this,t),i&&this.g.addEventListener(this.name,this,e),this.e=e}}handleEvent(e){typeof this.e==`function`?this.e.call(this.h?.host??this.g,e):this.e.handleEvent(e)}}class Va{constructor(){this.type=6}m(e){T(this,e)}}(0,H.litHtmlPolyfillSupport)?.(Na,W),(H.h??=[]).push(`3.3.3`);var X=globalThis;class Y extends G{constructor(){super(...arguments),this.G={host:this},this.D=void 0}B(){var e=super.B(),t;return(t=this.G).L??(t.L=e.firstChild),e}N(e){var t=this.Q();this.h||(this.G.isConnected=this.isConnected),super.N(e),e=this.C;var n=this.G,i=n?.L??e,a=i.ba;a===void 0&&(a=n?.L??null,i.ba=a=new W(e.insertBefore(K.createComment(``),a),a,void 0,n??{})),this.D=(a.m(t),a)}connectedCallback(){super.connectedCallback(),this.D?.V(!0)}disconnectedCallback(){super.disconnectedCallback(),this.D?.V(!1)}Q(){return P}}Y.finalized=!0,X.litElementHydrateSupport?.({Z:Y}),(0,X.litElementPolyfillSupport)?.({Z:Y}),(X.g??=[]).push(`4.2.2`);var Wa=class extends Y{constructor(...e){super(...e),this.count=0}Q(){return Ja`
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
          @click=${this.Y}
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
    `}Y(){this.count++}},Z=(((e,...t)=>(t=e.length===1?e[0]:t.reduce((t,n,i)=>{if(!0===n.aa)n=n.cssText;else if(typeof n!=`number`)throw Error(`Value passed to 'css' function must be a 'css' function result: `+n+`. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`);return t+n+e[i+1]},e[0]),new ba(t,e)))`
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
  `,Wa);l([function(e){return(t,n)=>{if(typeof n==`object`)t=Aa(e,t,n);else{let i=t.hasOwnProperty(n);t=(qa(t.constructor,n,e),i?Object.getOwnPropertyDescriptor(t,n):void 0)}return t}}({type:Number})],Z.prototype,`count`,void 0),Z=l([(e=>(t,n)=>{n===void 0?customElements.define(e,t):n.addInitializer(()=>{customElements.define(e,t)})})(`my-element`)],Z);export{};