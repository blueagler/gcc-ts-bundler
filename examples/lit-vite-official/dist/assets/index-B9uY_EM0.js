function l(a,b,c,d){var g=arguments.length,f=g<3?b:d===null?d=Object.getOwnPropertyDescriptor(b,c):d,e;if(typeof Reflect==`object`&&typeof Reflect.da==`function`)f=Reflect.da(a,b,c,d);else for(var h=a.length-1;h>=0;h--)(e=a[h])&&(f=(g<3?e(f):g>3?e(b,c,f):e(b,c))||f);return g>3&&f&&Object.defineProperty(b,c,f),f}var p=globalThis,r=p.ShadowRoot&&(p.ShadyCSS===void 0||p.ShadyCSS.nativeShadow)&&`adoptedStyleSheets`in Document.prototype&&`replace`in CSSStyleSheet.prototype,u=Symbol(),aa=new WeakMap;class ba{constructor(a,b){if(this.aa=!0,u!==u)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=a,this.e=b}get styleSheet(){var a=this.g,b=this.e;if(r&&a===void 0){let c=b!==void 0&&b.length===1;c&&(a=aa.get(b)),a===void 0&&((this.g=a=new CSSStyleSheet).replaceSync(this.cssText),c&&aa.set(b,a))}return a}toString(){return this.cssText}}var ca=(a,b)=>{if(r)a.adoptedStyleSheets=b.map(c=>c instanceof CSSStyleSheet?c:c.styleSheet);else for(let c of b){b=document.createElement(`style`);let d=p.litNonce;d!==void 0&&b.setAttribute(`nonce`,d),b.textContent=c.cssText,a.appendChild(b)}},da=r?a=>a:a=>{if(a instanceof CSSStyleSheet){let b=``;for(let c of a.cssRules)b+=c.cssText;a=new ba(b)}return a},ea=Object.is,fa=Object.defineProperty,ha=Object.getOwnPropertyDescriptor,ia=Object.getOwnPropertyNames,ja=Object.getOwnPropertySymbols,ka=Object.getPrototypeOf,v=globalThis,la=v.trustedTypes,ma=la?la.emptyScript:``,na=v.reactiveElementPolyfillSupport,x={W(a,b){switch(b){case Boolean:a=a?ma:null;break;case Object:case Array:a=a==null?a:JSON.stringify(a)}return a},K(a,b){var c=a;switch(b){case Boolean:c=a!==null;break;case Number:c=a===null?null:Number(a);break;case Object:case Array:try{c=JSON.parse(a)}catch{c=null}}return c}},y=(a,b)=>!ea(a,b),z={J:!0,type:String,n:x,y:!1,X:!1,S:y},oa;(oa=Symbol).metadata??(oa.metadata=Symbol(`metadata`)),v.e??=new WeakMap;function C(a){if(!a.hasOwnProperty(`elementProperties`)){var b=ka(a);pa(b),b.u!==void 0&&(a.u=[...b.u]),a.j=new Map(b.j)}}function pa(a){if(!a.hasOwnProperty(`finalized`)){if(a.finalized=!0,C(a),a.hasOwnProperty(`properties`)){var b=a.g,c=[...ia(b),...ja(b)];for(let d of c)qa(a,d,b[d])}if(b=a[Symbol.metadata],b!==null&&(b=globalThis.e.get(b),b!==void 0))for(let[d,g]of b)a.j.set(d,g);a.e=new Map;for(let[d,g]of a.j)b=D(d,g),b!==void 0&&a.e.set(b,d);if(c=a.h,b=[],Array.isArray(c)){c=new Set(c.flat(1/0).reverse());for(let d of c)b.unshift(da(d))}else c!==void 0&&b.push(da(c));a.elementStyles=b}}function ra(a,b,c){var d=Symbol(),{get:g,set:f}=ha(a.prototype,b)??{get(){return this[d]},set(e){this[d]=e}};return{get:g,set(e){var h=g?.call(this);f?.call(this,e),E(this,b,h,c)},configurable:!0,enumerable:!0}}function qa(a,b,c=z){c.state&&(c.J=!1),C(a),a.prototype.hasOwnProperty(b)&&((c=Object.create(c)).M=!0),a.j.set(b,c),c.sa||(c=ra(a,b,c),c!==void 0&&fa(a.prototype,b,c))}function E(a,b,c,d,g=!1,f){if(b!==void 0){let e=a.constructor;if(!1===g&&(f=a[b]),d??=e.j.get(b)??z,!((d.S??y)(f,c)||d.X&&d.y&&f===a.v?.get(b)&&!a.hasAttribute(D(b,d))))return;F(a,b,c,d)}!1===a.i&&(a.O=sa(a))}function D(a,b){return b=b.J,!1===b?void 0:typeof b==`string`?b:typeof a==`string`?a.toLowerCase():void 0}function ta(a){a.O=new Promise(b=>a.P=b),a.g=new Map,va(a),E(a),a.constructor.u?.forEach(b=>b(a))}function va(a){var b=new Map,c=a.constructor.j;for(let d of c.keys())a.hasOwnProperty(d)&&(b.set(d,a[d]),delete a[d]);b.size>0&&(a.z=b)}function F(a,b,c,{X:d,y:g,M:f},e){d&&!(a.v??=new Map).has(b)&&(a.v.set(b,e??c??a[b]),!0!==f||e!==void 0)||(a.g.has(b)||(a.h||d||(c=void 0),a.g.set(b,c)),!0===g&&a.e!==b&&(a.A??=new Set).add(b))}async function sa(a){a.i=!0;try{await a.O}catch(c){Promise.reject(c)}var b=wa(a);return b!=null&&await b,!a.i}function wa(a){if(a.i){if(!a.h){if(a.C??=a.B(),a.z){for(let[d,g]of a.z)a[d]=g;a.z=void 0}var b=a.constructor.j;if(b.size>0)for(let[d,g]of b)b=a[d],!0!==g.M||a.g.has(d)||b===void 0||F(a,d,void 0,g,b)}b=!1;var c=a.g;try{b=!0,a.F?.forEach(d=>d.oa?.()),a.N(c)}catch(d){throw b=!1,xa(a),d}b&&ya(a)}}function xa(a){a.g=new Map,a.i=!1}function ya(a){a.F?.forEach(b=>b.pa?.()),a.h||=!0}class G extends HTMLElement{static addInitializer(a){C(this),(this.u??=[]).push(a)}static get observedAttributes(){return pa(this),this.e&&[...this.e.keys()]}constructor(){super(),this.z=void 0,this.h=this.i=!1,this.e=null,ta(this)}B(){var a=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ca(a,this.constructor.elementStyles),a}connectedCallback(){this.C??=this.B(),this.P(!0),this.F?.forEach(a=>a.ma?.())}P(){}disconnectedCallback(){this.F?.forEach(a=>a.na?.())}attributeChangedCallback(a,b,c){if(b=this.constructor,a=b.e.get(a),a!==void 0&&this.e!==a){b=b.j.get(a)??z;let d=typeof b.n==`function`?{K:b.n}:b.n?.K===void 0?x:b.n;this.e=a,c=d.K(c,b.type),this[a]=c??this.v?.get(a)??c,this.e=null}}N(){this.A&&=this.A.forEach(a=>{var b=this[a],c=this.constructor.j.get(a),d=D(a,c);d!==void 0&&!0===c.y&&(b=(c.n?.W===void 0?x:c.n).W(b,c.type),this.e=a,b==null?this.removeAttribute(d):this.setAttribute(d,b),this.e=null)}),xa(this)}}G.elementStyles=[],G.shadowRootOptions={mode:`open`},G.elementProperties=new Map,G.finalized=new Map,na?.({ga:G}),(v.i??=[]).push(`2.1.2`);var za={J:!0,type:String,n:x,y:!1,S:y},Aa=(a=za,b,c)=>{var d=c.ra,g=c.metadata,f=globalThis.e.get(g);if(f===void 0&&globalThis.e.set(g,f=new Map),d===`setter`&&((a=Object.create(a)).M=!0),f.set(c.name,a),d===`accessor`){let e=c.name;return{set(h){var m=b.get.call(this);b.set.call(this,h),E(this,e,m,a,!0,h)},qa(h){return h!==void 0&&F(this,e,void 0,a,h),h}}}if(d===`setter`){let e=c.name;return function(h){var m=this[e];b.call(this,h),E(this,e,m,a,!0,h)}}throw Error(`Unsupported decorator location: `+d)},H=globalThis,I=H.trustedTypes,Ba=I?I.createPolicy(`lit-html`,{createHTML:a=>a}):void 0,J=`lit$${Math.random().toFixed(9).slice(2)}$`,Ca=`?`+J,Da=`<${Ca}>`,K=document,L=a=>a===null||typeof a!=`object`&&typeof a!=`function`,M=Array.isArray,N=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Ea=/--\x3e/g,Fa=/>/g,O=RegExp(`>|[ 	
\f\r](?:([^\\s"'>=/]+)([ 	
\f\r]*=[ 	
\f\r]*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,`g`),Ga=/'/g,Ha=/"/g,Ia=/^(?:script|style|textarea|title)$/i,Ja=(a=>(b,...c)=>({I:a,l:b,values:c}))(1),P=Symbol.for(`lit-noChange`),Q=Symbol.for(`lit-nothing`),Ka=new WeakMap,R=K.createTreeWalker(K,129);function La(a,b){if(!M(a)||!a.hasOwnProperty(`raw`))throw Error(`invalid template strings array`);return Ba===void 0?b:Ba.createHTML(b)}function Ma(a){var b=K.createElement(`template`);return b.innerHTML=a,b}class Na{constructor({l:a,I:b}){this.U=[];var c=0,d=0,g=a.length-1,f=this.U,e=a.length-1,h=[],m,t=b===2?`<svg>`:b===3?`<math>`:``,k=N;for(let q=0;q<e;q++){let A=a[q],ua,n,w=-1;for(var B=0;B<A.length&&(k.lastIndex=B,n=k.exec(A),n!==null);)B=k.lastIndex,k===N?n[1]===`!--`?k=Ea:n[1]===void 0?n[2]===void 0?n[3]!==void 0&&(k=O):(Ia.test(n[2])&&(m=RegExp(`</`+n[2],`g`)),k=O):k=Fa:k===O?n[0]===`>`?(k=m??N,w=-1):n[1]===void 0?w=-2:(w=k.lastIndex-n[2].length,ua=n[1],k=n[3]===void 0?O:n[3]===`"`?Ha:Ga):k===Ha||k===Ga?k=O:k===Ea||k===Fa?k=N:(k=O,m=void 0);B=k===O&&a[q+1].startsWith(`/>`)?` `:``,t+=k===N?A+Da:w>=0?(h.push(ua),A.slice(0,w)+`$lit$`+A.slice(w)+J+B):A+J+(w===-2?q:B)}a=[La(a,t+(a[e]||`<?>`)+(b===2?`</svg>`:b===3?`</math>`:``)),h];var[Pa,Qa]=a;for(this.x=Ma(Pa),R.currentNode=this.x.content,(b===2||b===3)&&(b=this.x.content.firstChild,b.replaceWith(...b.childNodes));(b=R.nextNode())!==null&&f.length<g;){if(b.nodeType===1){if(b.hasAttributes())for(let q of b.getAttributeNames())q.endsWith(`$lit$`)?(e=Qa[d++],a=b.getAttribute(q).split(J),e=/([.?@])?(.*)/.exec(e),f.push({type:1,index:c,name:e[2],l:a,ca:e[1]===`.`?Oa:e[1]===`?`?Ra:e[1]===`@`?Sa:S}),b.removeAttribute(q)):q.startsWith(J)&&(f.push({type:6,index:c}),b.removeAttribute(q));if(Ia.test(b.tagName)&&(a=b.textContent.split(J),e=a.length-1,e>0)){for(b.textContent=I?I.emptyScript:``,h=0;h<e;h++)b.append(a[h],K.createComment(``)),R.nextNode(),f.push({type:2,index:++c});b.append(a[e],K.createComment(``))}}else if(b.nodeType===8)if(b.data===Ca)f.push({type:2,index:c});else for(a=-1;(a=b.data.indexOf(J,a+1))!==-1;)f.push({type:7,index:c}),a+=J.length-1;c++}}}function T(a,b,c=a,d){if(b===P)return b;var g=d===void 0?c.$:c.R?.[d],f=L(b)?void 0:b.ka;return g?.constructor!==f&&(g?.ha?.(!1),f===void 0?g=void 0:(g=new f(a),g.ja(a,c,d)),d===void 0?c.$=g:(c.R??=[])[d]=g),g!==void 0&&(b=T(a,g.ia(a,b.values),g,d)),b}class Ta{constructor(a,b){this.e=[],this.H=a,this.g=b}get parentNode(){return this.g.parentNode}p(a){var b=0;for(let c of this.e)c!==void 0&&(c.l===void 0?c.m(a[b]):(c.m(a,c,b),b+=c.l.length-2)),b++}}function U(a,b=a.g.nextSibling,c){for(a.v?.(!1,!0,c);b!==a.w;)c=b.nextSibling,b.remove(),b=c}function Ua(a,b){a.e!==Q&&L(a.e)?a.g.nextSibling.data=b:V(a,K.createTextNode(b)),a.e=b}function V(a,b){a.e!==b&&(U(a),a.e=a.g.parentNode.insertBefore(b,a.w))}class W{constructor(a,b,c,d){this.type=2,this.e=Q,this.g=a,this.w=b,this.h=c,this.i=d}get parentNode(){var a=this.g.parentNode,b=this.h;return b!==void 0&&a?.nodeType===11&&(a=b.parentNode),a}m(a,b=this){if(a=T(this,a,b),L(a))a===Q||a==null||a===``?(this.e!==Q&&U(this),this.e=Q):a!==this.e&&a!==P&&Ua(this,a);else if(a.I!==void 0){b=a.values;var c=a.I;if(typeof c==`number`?(c=a,a=Ka.get(c.l),c=(a===void 0&&Ka.set(c.l,a=new Na(c)),a)):c=(c.x===void 0&&(c.x=Ma(La(c.ea,c.ea[0]))),c),a=c,this.e?.H===a)this.e.p(b);else{a=new Ta(a,this);var d;c=a;var g=this.i;let f=c.H.U,e=(g?.la??K).importNode(c.H.x.content,!0);R.currentNode=e;let h=R.nextNode(),m=0,t=0,k=f[0];for(;k!==void 0;)m===k.index&&(k.type===2?d=new W(h,h.nextSibling,c,g):k.type===1?d=new k.ca(h,k.name,k.l,c,g):k.type===6&&(d=new Va),c.e.push(d),k=f[++t]),m!==k?.index&&(h=R.nextNode(),m++);d=(R.currentNode=K,e),a.p(b),V(this,d),this.e=a}}else a.nodeType===void 0?M(a)||typeof a?.[Symbol.iterator]==`function`?this.k(a):Ua(this,a):V(this,a)}k(a){M(this.e)||(this.e=[],U(this));var b=this.e,c,d=0;for(let g of a)d===b.length?b.push(c=new W(this.g.parentNode.insertBefore(K.createComment(``),this.w),this.g.parentNode.insertBefore(K.createComment(``),this.w),this,this.i)):c=b[d],c.m(g),d++;d<b.length&&(U(this,c&&c.w.nextSibling,d),b.length=d)}V(a){this.h===void 0&&this.v?.(a)}}class S{get tagName(){return this.g.tagName}constructor(a,b,c,d,g){this.type=1,this.e=Q,this.g=a,this.name=b,this.h=g,c.length>2||c[0]!==``||c[1]!==``?(this.e=Array(c.length-1).fill(new String),this.l=c):this.e=Q}m(a,b=this,c){var d=this.l,g=!1;if(d===void 0)a=T(this,a,b,0),(g=!L(a)||a!==this.e&&a!==P)&&(this.e=a);else{let f=a,e,h;for(a=d[0],e=0;e<d.length-1;e++)h=T(this,f[c+e],b,e),h===P&&(h=this.e[e]),g||=!L(h)||h!==this.e[e],h===Q?a=Q:a!==Q&&(a+=(h??``)+d[e+1]),this.e[e]=h}g&&this.o(a)}o(a){a===Q?this.g.removeAttribute(this.name):this.g.setAttribute(this.name,a??``)}}class Oa extends S{constructor(){super(...arguments),this.type=3}o(a){this.g[this.name]=a===Q?void 0:a}}class Ra extends S{constructor(){super(...arguments),this.type=4}o(a){this.g.toggleAttribute(this.name,!!a&&a!==Q)}}class Sa extends S{constructor(a,b,c,d,g){super(a,b,c,d,g),this.type=5}m(a,b=this){if((a=T(this,a,b,0)??Q)!==P){b=this.e;var c=a===Q&&b!==Q||a.capture!==b.capture||a.once!==b.once||a.passive!==b.passive,d=a!==Q&&(b===Q||c);c&&this.g.removeEventListener(this.name,this,b),d&&this.g.addEventListener(this.name,this,a),this.e=a}}handleEvent(a){typeof this.e==`function`?this.e.call(this.h?.host??this.g,a):this.e.handleEvent(a)}}class Va{constructor(){this.type=6}m(a){T(this,a)}}(0,H.litHtmlPolyfillSupport)?.(Na,W),(H.h??=[]).push(`3.3.3`);var X=globalThis;class Y extends G{constructor(){super(...arguments),this.G={host:this},this.D=void 0}B(){var a=super.B(),b;return(b=this.G).L??(b.L=a.firstChild),a}N(a){var b=this.Q();this.h||(this.G.isConnected=this.isConnected),super.N(a),a=this.C;var c=this.G,d=c?.L??a,g=d.ba;g===void 0&&(g=c?.L??null,d.ba=g=new W(a.insertBefore(K.createComment(``),g),g,void 0,c??{})),this.D=(g.m(b),g)}connectedCallback(){super.connectedCallback(),this.D?.V(!0)}disconnectedCallback(){super.disconnectedCallback(),this.D?.V(!1)}Q(){return P}}Y.finalized=!0,X.litElementHydrateSupport?.({Z:Y}),(0,X.litElementPolyfillSupport)?.({Z:Y}),(X.g??=[]).push(`4.2.2`);var Wa=class extends Y{constructor(...a){super(...a),this.count=0}Q(){return Ja`
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
    `}Y(){this.count++}},Z=(((a,...b)=>(b=a.length===1?a[0]:b.reduce((c,d,g)=>{if(!0===d.aa)d=d.cssText;else if(typeof d!=`number`)throw Error(`Value passed to 'css' function must be a 'css' function result: `+d+`. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`);return c+d+a[g+1]},a[0]),new ba(b,a)))`
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
  `,Wa);l([function(a){return(b,c)=>{if(typeof c==`object`)b=Aa(a,b,c);else{let d=b.hasOwnProperty(c);b=(qa(b.constructor,c,a),d?Object.getOwnPropertyDescriptor(b,c):void 0)}return b}}({type:Number})],Z.prototype,`count`,void 0),Z=l([(a=>(b,c)=>{c===void 0?customElements.define(a,b):c.addInitializer(()=>{customElements.define(a,b)})})(`my-element`)],Z);export{};