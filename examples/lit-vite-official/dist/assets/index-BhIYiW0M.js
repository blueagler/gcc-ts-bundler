var l=globalThis,p=l.ShadowRoot&&(l.ShadyCSS===void 0||l.ShadyCSS.nativeShadow)&&`adoptedStyleSheets`in Document.prototype&&`replace`in CSSStyleSheet.prototype,r=Symbol(),u=new WeakMap;class aa{constructor(e,t){if(this.ea=!0,r!==r)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.e=t}get styleSheet(){var e=this.g,t=this.e;if(p&&e===void 0){let n=t!==void 0&&t.length===1;n&&(e=u.get(t)),e===void 0&&((this.g=e=new CSSStyleSheet).replaceSync(this.cssText),n&&u.set(t,e))}return e}toString(){return this.cssText}}var ba=(e,t)=>{if(p)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(let n of t){t=document.createElement(`style`);let i=l.litNonce;i!==void 0&&t.setAttribute(`nonce`,i),t.textContent=n.cssText,e.appendChild(t)}},ca=p?e=>e:e=>{if(e instanceof CSSStyleSheet){let t=``;for(let n of e.cssRules)t+=n.cssText;e=new aa(t)}return e},da=Object.is,ea=Object.defineProperty,fa=Object.getOwnPropertyDescriptor,ha=Object.getOwnPropertyNames,ia=Object.getOwnPropertySymbols,ja=Object.getPrototypeOf,v=globalThis,ka=v.trustedTypes,la=ka?ka.emptyScript:``,ma=v.reactiveElementPolyfillSupport,x={$(e,t){switch(t){case Boolean:e=e?la:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},O(e,t){var n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},y=(e,t)=>!da(e,t),z={N:!0,type:String,l:x,H:!1,ba:!1,V:y},na;(na=Symbol).metadata??(na.metadata=Symbol(`metadata`)),v.litPropertyMetadata??=new WeakMap;function C(e){if(!e.hasOwnProperty(`elementProperties`)){var t=ja(e);oa(t),t.o!==void 0&&(e.o=[...t.o]),e.h=new Map(t.h)}}function oa(e){if(!e.hasOwnProperty(`finalized`)){if(e.finalized=!0,C(e),e.hasOwnProperty(`properties`)){var t=e.Aa,n=[...ha(t),...ia(t)];for(let i of n)pa(e,i,t[i])}if(t=e[Symbol.metadata],t!==null&&(t=globalThis.litPropertyMetadata.get(t),t!==void 0))for(let[n,i]of t)e.h.set(n,i);e.A=new Map;for(let[n,i]of e.h)t=D(n,i),t!==void 0&&e.A.set(t,n);if(n=e.la,t=[],Array.isArray(n)){n=new Set(n.flat(1/0).reverse());for(let e of n)t.unshift(ca(e))}else n!==void 0&&t.push(ca(n));e.elementStyles=t}}function qa(e,t,n){var i=Symbol(),{get:a,set:o}=fa(e.prototype,t)??{get(){return this[i]},set(e){this[i]=e}};return{get:a,set(e){var i=a?.call(this);o?.call(this,e),E(this,t,i,n)},configurable:!0,enumerable:!0}}function pa(e,t,n=z){n.state&&(n.N=!1),C(e),e.prototype.hasOwnProperty(t)&&((n=Object.create(n)).R=!0),e.h.set(t,n),n.za||(n=qa(e,t,n),n!==void 0&&ea(e.prototype,t,n))}function E(e,t,n,i,a=!1,o){if(t!==void 0){let s=e.constructor;if(!1===a&&(o=e[t]),i??=s.h.get(t)??z,!((i.V??y)(o,n)||i.ba&&i.H&&o===e.B?.get(t)&&!e.hasAttribute(D(t,i))))return;F(e,t,n,i)}!1===e.z&&(e.T=ra(e))}function D(e,t){return t=t.N,!1===t?void 0:typeof t==`string`?t:typeof e==`string`?e.toLowerCase():void 0}function sa(e){e.T=new Promise(t=>e.U=t),e.w=new Map,ua(e),E(e),e.constructor.o?.forEach(t=>t(e))}function ua(e){var t=new Map,n=e.constructor.h;for(let i of n.keys())e.hasOwnProperty(i)&&(t.set(i,e[i]),delete e[i]);t.size>0&&(e.C=t)}function F(e,t,n,{ba:i,H:a,R:o},s){i&&!(e.B??=new Map).has(t)&&(e.B.set(t,s??n??e[t]),!0!==o||s!==void 0)||(e.w.has(t)||(e.y||i||(n=void 0),e.w.set(t,n)),!0===a&&e.u!==t&&(e.D??=new Set).add(t))}async function ra(e){e.z=!0;try{await e.T}catch(e){Promise.reject(e)}var t=va(e);return t!=null&&await t,!e.z}function va(e){if(e.z){if(!e.y){if(e.I??=e.F(),e.C){for(let[t,n]of e.C)e[t]=n;e.C=void 0}var t=e.constructor.h;if(t.size>0)for(let[n,i]of t)t=e[n],!0!==i.R||e.w.has(n)||t===void 0||F(e,n,void 0,i,t)}t=!1;var n=e.w;try{t=!0,e.L?.forEach(e=>e.va?.()),e.update(n)}catch(n){throw t=!1,wa(e),n}t&&xa(e)}}function wa(e){e.w=new Map,e.z=!1}function xa(e){e.L?.forEach(e=>e.wa?.()),e.y||=!0}class G extends HTMLElement{static addInitializer(e){C(this),(this.o??=[]).push(e)}static get observedAttributes(){return oa(this),this.A&&[...this.A.keys()]}constructor(){super(),this.C=void 0,this.y=this.z=!1,this.u=null,sa(this)}F(){var e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ba(e,this.constructor.elementStyles),e}connectedCallback(){this.I??=this.F(),this.U(!0),this.L?.forEach(e=>e.ta?.())}U(){}disconnectedCallback(){this.L?.forEach(e=>e.ua?.())}attributeChangedCallback(e,t,n){if(t=this.constructor,e=t.A.get(e),e!==void 0&&this.u!==e){t=t.h.get(e)??z;let i=typeof t.l==`function`?{O:t.l}:t.l?.O===void 0?x:t.l;this.u=e,n=i.O(n,t.type),this[e]=n??this.B?.get(e)??n,this.u=null}}update(){this.D&&=this.D.forEach(e=>{var t=this[e],n=this.constructor.h.get(e),i=D(e,n);i!==void 0&&!0===n.H&&(t=(n.l?.$===void 0?x:n.l).$(t,n.type),this.u=e,t==null?this.removeAttribute(i):this.setAttribute(i,t),this.u=null)}),wa(this)}}G.elementStyles=[],G.shadowRootOptions={mode:`open`},G.elementProperties=new Map,G.finalized=new Map,ma?.({na:G}),(v.G??=[]).push(`2.1.2`);var ya={N:!0,type:String,l:x,H:!1,V:y},za=(e=ya,t,n)=>{var i=n.ya,a=n.metadata,o=globalThis.litPropertyMetadata.get(a);if(o===void 0&&globalThis.litPropertyMetadata.set(a,o=new Map),i===`setter`&&((e=Object.create(e)).R=!0),o.set(n.name,e),i===`accessor`){let i=n.name;return{set(n){var a=t.get.call(this);t.set.call(this,n),E(this,i,a,e,!0,n)},xa(t){return t!==void 0&&F(this,i,void 0,e,t),t}}}if(i===`setter`){let i=n.name;return function(n){var a=this[i];t.call(this,n),E(this,i,a,e,!0,n)}}throw Error(`Unsupported decorator location: `+i)},H=globalThis,I=H.trustedTypes,Aa=I?I.createPolicy(`lit-html`,{createHTML:e=>e}):void 0,J=`lit$${Math.random().toFixed(9).slice(2)}$`,Ba=`?`+J,Ca=`<${Ba}>`,K=document,L=e=>e===null||typeof e!=`object`&&typeof e!=`function`,M=Array.isArray,N=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Da=/--\x3e/g,Ea=/>/g,O=RegExp(`>|[ 	
\f\r](?:([^\\s"'>=/]+)([ 	
\f\r]*=[ 	
\f\r]*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,`g`),Fa=/'/g,Ga=/"/g,Ha=/^(?:script|style|textarea|title)$/i,Ia=(e=>(t,...n)=>({M:e,i:t,values:n}))(1),P=Symbol.for(`lit-noChange`),Q=Symbol.for(`lit-nothing`),Ja=new WeakMap,R=K.createTreeWalker(K,129);function Ka(e,t){if(!M(e)||!e.hasOwnProperty(`raw`))throw Error(`invalid template strings array`);return Aa===void 0?t:Aa.createHTML(t)}function La(e){var t=K.createElement(`template`);return t.innerHTML=e,t}class Ma{constructor({i:e,M:t}){this.X=[];var n=0,i=0,a=e.length-1,o=this.X,s=e.length-1,c=[],d,f=t===2?`<svg>`:t===3?`<math>`:``,m=N;for(let t=0;t<s;t++){let n=e[t],i,a,o=-1;for(var h=0;h<n.length&&(m.lastIndex=h,a=m.exec(n),a!==null);)h=m.lastIndex,m===N?a[1]===`!--`?m=Da:a[1]===void 0?a[2]===void 0?a[3]!==void 0&&(m=O):(Ha.test(a[2])&&(d=RegExp(`</`+a[2],`g`)),m=O):m=Ea:m===O?a[0]===`>`?(m=d??N,o=-1):a[1]===void 0?o=-2:(o=m.lastIndex-a[2].length,i=a[1],m=a[3]===void 0?O:a[3]===`"`?Ga:Fa):m===Ga||m===Fa?m=O:m===Da||m===Ea?m=N:(m=O,d=void 0);h=m===O&&e[t+1].startsWith(`/>`)?` `:``,f+=m===N?n+Ca:o>=0?(c.push(i),n.slice(0,o)+`$lit$`+n.slice(o)+J+h):n+J+(o===-2?t:h)}e=[Ka(e,f+(e[s]||`<?>`)+(t===2?`</svg>`:t===3?`</math>`:``)),c];var[g,_]=e;for(this.x=La(g),R.currentNode=this.x.content,(t===2||t===3)&&(t=this.x.content.firstChild,t.replaceWith(...t.childNodes));(t=R.nextNode())!==null&&o.length<a;){if(t.nodeType===1){if(t.hasAttributes())for(let a of t.getAttributeNames())a.endsWith(`$lit$`)?(s=_[i++],e=t.getAttribute(a).split(J),s=/([.?@])?(.*)/.exec(s),o.push({type:1,index:n,name:s[2],i:e,ha:s[1]===`.`?Na:s[1]===`?`?Oa:s[1]===`@`?Pa:S}),t.removeAttribute(a)):a.startsWith(J)&&(o.push({type:6,index:n}),t.removeAttribute(a));if(Ha.test(t.tagName)&&(e=t.textContent.split(J),s=e.length-1,s>0)){for(t.textContent=I?I.emptyScript:``,c=0;c<s;c++)t.append(e[c],K.createComment(``)),R.nextNode(),o.push({type:2,index:++n});t.append(e[s],K.createComment(``))}}else if(t.nodeType===8){if(t.data===Ba)o.push({type:2,index:n});else for(e=-1;(e=t.data.indexOf(J,e+1))!==-1;)o.push({type:7,index:n}),e+=J.length-1}n++}}}function T(e,t,n=e,i){if(t===P)return t;var a=i===void 0?n.da:n.S?.[i],o=L(t)?void 0:t.ra;return a?.constructor!==o&&(a?.oa?.(!1),o===void 0?a=void 0:(a=new o(e),a.qa(e,n,i)),i===void 0?n.da=a:(n.S??=[])[i]=a),a!==void 0&&(t=T(e,a.pa(e,t.values),a,i)),t}class Sa{constructor(e,t){this.e=[],this.J=e,this.g=t}get parentNode(){return this.g.parentNode}p(e){var t=0;for(let n of this.e)n!==void 0&&(n.i===void 0?n.j(e[t]):(n.j(e,n,t),t+=n.i.length-2)),t++}}function U(e,t=e.g.nextSibling,n){for(e.ma?.(!1,!0,n);t!==e.v;)n=t.nextSibling,t.remove(),t=n}function Ta(e,t){e.e!==Q&&L(e.e)?e.g.nextSibling.data=t:V(e,K.createTextNode(t)),e.e=t}function V(e,t){e.e!==t&&(U(e),e.e=e.g.parentNode.insertBefore(t,e.v))}class W{constructor(e,t,n,i){this.type=2,this.e=Q,this.g=e,this.v=t,this.G=n,this.aa=i}get parentNode(){var e=this.g.parentNode,t=this.G;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}j(e,t=this){if(e=T(this,e,t),L(e))e===Q||e==null||e===``?(this.e!==Q&&U(this),this.e=Q):e!==this.e&&e!==P&&Ta(this,e);else if(e.M!==void 0){t=e.values;var n=e.M;if(typeof n==`number`?(n=e,e=Ja.get(n.i),n=(e===void 0&&Ja.set(n.i,e=new Ma(n)),e)):n=(n.x===void 0&&(n.x=La(Ka(n.ja,n.ja[0]))),n),e=n,this.e?.J===e)this.e.p(t);else{e=new Sa(e,this);var i;n=e;var a=this.aa;let o=n.J.X,s=(a?.sa??K).importNode(n.J.x.content,!0);R.currentNode=s;let c=R.nextNode(),d=0,f=0,m=o[0];for(;m!==void 0;)d===m.index&&(m.type===2?i=new W(c,c.nextSibling,n,a):m.type===1?i=new m.ha(c,m.name,m.i,n,a):m.type===6&&(i=new Ua(c)),n.e.push(i),m=o[++f]),d!==m?.index&&(c=R.nextNode(),d++);i=(R.currentNode=K,s),e.p(t),V(this,i),this.e=e}}else e.nodeType===void 0?M(e)||typeof e?.[Symbol.iterator]==`function`?this.k(e):Ta(this,e):V(this,e)}k(e){M(this.e)||(this.e=[],U(this));var t=this.e,n,i=0;for(let a of e)i===t.length?t.push(n=new W(this.g.parentNode.insertBefore(K.createComment(``),this.v),this.g.parentNode.insertBefore(K.createComment(``),this.v),this,this.aa)):n=t[i],n.j(a),i++;i<t.length&&(U(this,n&&n.v.nextSibling,i),t.length=i)}Z(e){this.G===void 0&&this.ma?.(e)}}class S{get tagName(){return this.element.tagName}constructor(e,t,n,i,a){this.type=1,this.e=Q,this.element=e,this.name=t,this.g=a,n.length>2||n[0]!==``||n[1]!==``?(this.e=Array(n.length-1).fill(new String),this.i=n):this.e=Q}j(e,t=this,n){var i=this.i,a=!1;if(i===void 0)e=T(this,e,t,0),(a=!L(e)||e!==this.e&&e!==P)&&(this.e=e);else{let o=e,s,c;for(e=i[0],s=0;s<i.length-1;s++)c=T(this,o[n+s],t,s),c===P&&(c=this.e[s]),a||=!L(c)||c!==this.e[s],c===Q?e=Q:e!==Q&&(e+=(c??``)+i[s+1]),this.e[s]=c}a&&this.m(e)}m(e){e===Q?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??``)}}class Na extends S{constructor(){super(...arguments),this.type=3}m(e){this.element[this.name]=e===Q?void 0:e}}class Oa extends S{constructor(){super(...arguments),this.type=4}m(e){this.element.toggleAttribute(this.name,!!e&&e!==Q)}}class Pa extends S{constructor(e,t,n,i,a){super(e,t,n,i,a),this.type=5}j(e,t=this){if((e=T(this,e,t,0)??Q)!==P){t=this.e;var n=e===Q&&t!==Q||e.capture!==t.capture||e.once!==t.once||e.passive!==t.passive,i=e!==Q&&(t===Q||n);n&&this.element.removeEventListener(this.name,this,t),i&&this.element.addEventListener(this.name,this,e),this.e=e}}handleEvent(e){typeof this.e==`function`?this.e.call(this.g?.host??this.element,e):this.e.handleEvent(e)}}class Ua{constructor(e){this.element=e,this.type=6}j(e){T(this,e)}}(0,H.litHtmlPolyfillSupport)?.(Ma,W),(H.g??=[]).push(`3.3.3`);var X=globalThis;class Y extends G{constructor(){super(...arguments),this.Q={host:this},this.K=void 0}F(){var e=super.F(),t;return(t=this.Q).P??(t.P=e.firstChild),e}update(e){var t=this.Y();this.y||(this.Q.isConnected=this.isConnected),super.update(e),e=this.I;var n=this.Q,i=n?.P??e,a=i.fa;a===void 0&&(a=n?.P??null,i.fa=a=new W(e.insertBefore(K.createComment(``),a),a,void 0,n??{})),this.K=(a.j(t),a)}connectedCallback(){super.connectedCallback(),this.K?.Z(!0)}disconnectedCallback(){super.disconnectedCallback(),this.K?.Z(!1)}Y(){return P}}Y.finalized=!0,X.litElementHydrateSupport?.({ca:Y}),(0,X.litElementPolyfillSupport)?.({ca:Y}),(X.e??=[]).push(`4.2.2`);function Va(e,t,n,i){var a=arguments.length,o=a<3?t:i===null?i=Object.getOwnPropertyDescriptor(t,n):i,s;if(typeof Reflect==`object`&&typeof Reflect.ia==`function`)o=Reflect.ia(e,t,n,i);else for(var c=e.length-1;c>=0;c--)(s=e[c])&&(o=(a<3?s(o):a>3?s(t,n,o):s(t,n))||o);return a>3&&o&&Object.defineProperty(t,n,o),o}var Wa=class extends Y{constructor(...e){super(...e),this.count=0}Y(){return Ia`
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
          @click=${this.ga}
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
    `}ga(){this.count++}},Z=(Wa.la=((e,...t)=>(t=e.length===1?e[0]:t.reduce((t,n,i)=>{if(!0===n.ea)n=n.cssText;else if(typeof n!=`number`)throw Error(`Value passed to 'css' function must be a 'css' function result: `+n+`. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`);return t+n+e[i+1]},e[0]),new aa(t,e)))`
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