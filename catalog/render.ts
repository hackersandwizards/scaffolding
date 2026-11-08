// Markup as a string and free of Node and Astro imports, so an Astro page, a page bundle and a
// generated static page all carry the same shape.

export type CatalogItem = {
  name: string;
  href: string;
  /** Words under the name, searched with it and the group's name. */
  note?: string;
  /** Further words the search finds and the tile does not show, such as a story's file name. */
  search?: string;
  /** A short count or kind in a neutral pill, such as "3 states". */
  pill?: string;
  /** A page drawn in the tile at three quarters, centred, loaded once the page has painted and the
   * tile nears the view; an element the page marks `data-hw-preview` is drawn alone. */
  frame?: string;
  /** Draw the frame from the page's HTML (`srcdoc`), for a site whose pages refuse framing, such as
   * by `X-Frame-Options: DENY`. Over HTTP only. */
  frameSrcdoc?: boolean;
  /** The frame's viewport in CSS px, such as [1440, 810] for a slide: drawn whole, scaled to the
   * tile's width, instead of at three quarters in a fixed height. */
  frameSize?: [number, number];
  /** An image drawn in the tile. */
  image?: string;
  /** Markup drawn in the tile, trusted. */
  html?: string;
};

/** A group of tiles, or with `html` a group of trusted markup, such as the system's foundations,
 * shown while the search is empty. */
export type CatalogGroup = { name: string; items: CatalogItem[]; html?: string };

export type CatalogData = {
  title: string;
  lead: string;
  /** One line: where the shown values come from, such as the brand version, and how many
   * entries the page holds, in words ("26 components"): the title carries no count. */
  provenance: string;
  groups: CatalogGroup[];
  /** Markup between the provenance line and the first group, trusted. */
  intro?: string;
  /** The rail's words, English unless the page passes its own. */
  labels?: { search?: string; groups?: string };
};

const escapeCatalog = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const anchorOf = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

const tilePreview = (item: CatalogItem) =>
  item.frame
    ? `<iframe data-src="${escapeCatalog(item.frame)}"${item.frameSrcdoc ? " data-srcdoc" : ""} tabindex="-1" aria-hidden="true" title=""${
        item.frameSize ? ` style="width:${item.frameSize[0]}px;height:${item.frameSize[1]}px"` : ""
      }></iframe>`
    : item.image
      ? `<img src="${escapeCatalog(item.image)}" alt="" loading="lazy">`
      : (item.html ?? "");

// data-hw-shell marks the shell's own brand elements, the tile's card and pill, which a check of the
// repository's own elements skips.
const catalogTile = (item: CatalogItem, group: string) =>
  `<li><a class="hw-card hw-catalog-tile" data-hw-shell href="${escapeCatalog(item.href)}" data-search="${escapeCatalog(`${group} ${item.name} ${item.note ?? ""} ${item.search ?? ""}`.toLowerCase())}">${
    item.frame || item.image || item.html
      ? `<span class="hw-catalog-preview"${
          item.frame && item.frameSize
            ? ` data-frame-width="${item.frameSize[0]}" style="aspect-ratio:${item.frameSize[0]}/${item.frameSize[1]}"`
            : ""
        }>${tilePreview(item)}</span>`
      : ""
  }<span class="hw-catalog-name">${escapeCatalog(item.name)}</span>${
    item.note ? `<span class="hw-catalog-note">${escapeCatalog(item.note)}</span>` : ""
  }${item.pill ? `<span class="hw-pill" data-tone="neutral" data-hw-shell>${escapeCatalog(item.pill)}</span>` : ""}</a></li>`;

// Filters the tiles and the rail's names by every word in the search field and hides a group left
// empty, a group of markup while the field holds a word. Loads a frame once the page reports its
// first paint (2 s after load where none comes; two animation frames still started before it) and
// the tile comes within 200 px of the view, so the frames neither delay the first paint nor load
// all at once (Chrome's loading="lazy" loaded 30 of 40 frames up front). A hidden page, such as a
// headless check's tab without focus, never paints and its observer never reports (0 of 39 tiles
// in 10 s): with no first paint to protect and nobody scrolling, it loads every tile at once, so
// a check reads them all. A frame with data-srcdoc draws from the
// page's HTML, a <base> keeping its relative links. Draws each sized frame whole at its tile's
// width, and centres every other frame's content, shrunk where it is taller than the tile and
// measured afresh each time, so a refit never shrinks it again, as Storybook's "centered" layout
// does, 8 px clear of each side, on the ground around it: the element marked data-hw-preview alone,
// everything else and the page's canvas hidden once the ground is read, fitted to what it paints
// (its own box where it has a ground, background image, border, shadow or is a control or image,
// else its text and such boxes inside, so a full-width wrapper centres its button rather than its
// own box); else <main>'s only child or <main>. Marks the rail's label of the group read now with
// aria-current="true": the last group whose top has passed a third of the viewport; once one has
// and the page can scroll no further, the group the address names where its top shows, else, once
// the page has scrolled, the last group, so a click on a group the page cannot scroll up to that
// third marks that group; a mark another script set, such as "page", stays. The rail's names
// scroll, never the page, to keep that label in view. Delegated on the document, scroll caught in
// the capture phase since Astrobook scrolls <main> rather than the window, so it holds across
// Astro's client router swaps and runs once.
const SCRIPT = `<script>(()=>{
const fit=(p)=>{const f=p.firstElementChild;if(!(f instanceof HTMLIFrameElement))return;
if(p.dataset.frameWidth){f.style.transform="scale("+p.clientWidth/p.dataset.frameWidth+")";return;}
const d=f.contentDocument,m=d&&(d.querySelector("main")||d.body);if(!m||!m.firstElementChild)return;f.style.height=f.style.transform="";
const own=d.querySelector("[data-hw-preview]"),css=(e)=>d.defaultView.getComputedStyle(e),clear=(b)=>/^(transparent|rgba\\(.*, 0\\))$/.test(b);
const paints=(e,k)=>!clear(k.backgroundColor)||k.backgroundImage!=="none"||parseFloat(k.borderTopWidth)||parseFloat(k.borderLeftWidth)||k.boxShadow!=="none"||/^(IMG|svg|VIDEO|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.tagName);
const drawn=(e,k)=>paints(e,k)?[e.getBoundingClientRect()]:[...e.childNodes].flatMap((n)=>{if(n.nodeType===3&&n.textContent.trim()){const g=d.createRange();g.selectNodeContents(n);return [...g.getClientRects()];}const nk=n.nodeType===1&&css(n);return nk&&nk.display!=="none"?drawn(n,nk):[];}).filter((q)=>q.width&&q.height);
const c=own||(m.childElementCount===1?m.firstElementChild:m);let r=c.getBoundingClientRect();
if(own){const rs=drawn(own,css(own));if(rs.length){const x=Math.min(...rs.map((q)=>q.left)),y=Math.min(...rs.map((q)=>q.top));r=new DOMRect(x,y,Math.max(...rs.map((q)=>q.right))-x,Math.max(...rs.map((q)=>q.bottom))-y);}}
if(!r.height)return;
const s=Math.min(0.75,(p.clientHeight-16)/r.height,(p.clientWidth-16)/r.width);
if(r.bottom>f.clientHeight)f.style.height=r.bottom+"px";
f.style.transform="translate("+((p.clientWidth-r.width*s)/2-r.left*s)+"px,"+((p.clientHeight-r.height*s)/2-r.top*s)+"px) scale("+s+")";
let ground;for(let e=own?own.parentElement:c;e&&!ground;e=e.parentElement)if(!clear(css(e).backgroundColor))ground=css(e).backgroundColor;
if(ground)p.style.background=ground;
if(own&&!d.getElementById("hw-preview-only"))d.head.insertAdjacentHTML("beforeend",'<style id="hw-preview-only">html,body{background:none!important}body{visibility:hidden}[data-hw-preview]{visibility:visible}</style>');};
const all=()=>document.querySelectorAll(".hw-catalog-preview").forEach(fit);all();
const load=(f)=>{const u=f.dataset.src;if(!u)return;delete f.dataset.src;if(!f.hasAttribute("data-srcdoc")){f.src=u;return;}
fetch(new URL(u,location.href)).then((r)=>r.ok&&r.text().then((h)=>{f.srcdoc=h.replace(/<head\b[^>]*>/i,'$&<base href="'+r.url+'">');})).catch(()=>{});};
let started=0;const start=()=>{if(started++)return;const frames=document.querySelectorAll(".hw-catalog-preview iframe[data-src]");if(document.hidden){frames.forEach(load);return;}const m=document.querySelector("main"),root=m&&m.scrollHeight>m.clientHeight?m:null;
const near=new IntersectionObserver((seen)=>{for(const e of seen)if(e.isIntersecting){near.unobserve(e.target);load(e.target);}},{root,rootMargin:"200px 0px"});
frames.forEach((f)=>near.observe(f));};
if(document.hidden)start();
if(PerformanceObserver.supportedEntryTypes?.includes("paint"))new PerformanceObserver((_,o)=>{o.disconnect();start();}).observe({type:"paint",buffered:true});
addEventListener("load",()=>setTimeout(start,2000),{once:true});
const spy=()=>{for(const root of document.querySelectorAll(".hw-catalog")){
const groups=[...root.querySelectorAll(".hw-catalog-group")].filter((g)=>g.getClientRects().length),last=groups.at(-1);
let on=groups.findLast((g)=>g.getBoundingClientRect().top<=innerHeight/3);
const m=document.querySelector("main"),s=m&&m.scrollHeight>m.clientHeight?m:document.scrollingElement;
if(on&&s.scrollTop+s.clientHeight>=s.scrollHeight-1){const hit=groups.find((g)=>"#"+encodeURIComponent(g.id)===location.hash);if(hit&&hit.getBoundingClientRect().top>=0)on=hit;else if(s.scrollTop>0)on=last;}
for(const a of root.querySelectorAll(".hw-catalog-rail > nav > ul > li > a")){const mine=on&&a.getAttribute("href")==="#"+on.id,was=a.getAttribute("aria-current");
if(mine&&!was){const box=a.closest("nav"),r=a.getBoundingClientRect(),b=box.getBoundingClientRect();a.setAttribute("aria-current","true");if(r.top<b.top||r.bottom>b.bottom)box.scrollTop+=r.top-b.top-8;}
else if(!mine&&was==="true")a.removeAttribute("aria-current");}}};spy();
if(window.hwCatalog)return;window.hwCatalog=1;
let frame=0,tick=0;const later=()=>{cancelAnimationFrame(tick);tick=requestAnimationFrame(spy);};
addEventListener("resize",()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{all();spy();});});document.addEventListener("astro:page-load",()=>{all();spy();});
document.addEventListener("scroll",later,{capture:true,passive:true});
document.addEventListener("load",(e)=>{const p=e.target.parentElement;if(e.target instanceof HTMLIFrameElement&&p&&p.matches(".hw-catalog-preview")){fit(p);e.target.contentDocument?.fonts?.ready.then(()=>fit(p));}},true);
document.addEventListener("input",(e)=>{const f=e.target;if(!(f instanceof HTMLInputElement)||!f.matches(".hw-catalog-search"))return;
const q=f.value.trim().toLowerCase().split(/\\s+/);const typed=q.join("")!=="";const root=f.closest(".hw-catalog");
for(const g of root.querySelectorAll(".hw-catalog-group")){let n=0;const link=root.querySelector('.hw-catalog-rail a[href="#'+g.id+'"]'),names=link?.nextElementSibling?.children??[];
g.querySelectorAll(".hw-catalog-tile").forEach((t,i)=>{const hit=q.every((w)=>t.dataset.search.includes(w));t.parentElement.hidden=!hit;if(names[i])names[i].hidden=!hit;if(hit)n++;});
const off=n===0&&typed;g.hidden=off;if(link)link.parentElement.hidden=off;}later();});
})();</script>`;

export function renderCatalog(data: CatalogData): string {
  const { search = "Search", groups: groupsLabel = "Groups" } = data.labels ?? {};
  // A group of markup holding only whitespace draws nothing, as an empty group of tiles.
  const anchors = new Map<string, string>();
  const groups = data.groups
    .filter((g) => g.items.length > 0 || g.html?.trim())
    .map((g) => {
      const anchor = anchorOf(g.name);
      if (anchors.has(anchor))
        throw new Error(
          `catalog: the groups "${anchors.get(anchor)}" and "${g.name}" both draw as #${anchor}: rename one, such as its stories folder`,
        );
      anchors.set(anchor, g.name);
      return { ...g, anchor };
    });
  const count = (g: CatalogGroup) =>
    g.items.length ? `<span class="hw-catalog-count">${g.items.length}</span>` : "";
  const rail = groups
    .map(
      (g) =>
        `<li><a href="#${g.anchor}"><span>${escapeCatalog(g.name)}</span>${count(g)}</a>${g.html === undefined ? `<ul class="hw-catalog-names">${g.items.map((i) => `<li><a href="${escapeCatalog(i.href)}">${escapeCatalog(i.name)}</a></li>`).join("")}</ul>` : ""}</li>`,
    )
    .join("");
  const sections = groups
    .map(
      (g) =>
        `<section class="hw-catalog-group" id="${g.anchor}"><h2>${[escapeCatalog(g.name), count(g)].filter(Boolean).join(" ")}</h2>${g.html === undefined ? `<ul class="hw-catalog-grid">${g.items.map((i) => catalogTile(i, g.name)).join("")}</ul>` : `<div class="hw-catalog-text">${g.html}</div>`}</section>`,
    )
    .join("");
  return `<div class="hw-catalog hw-container"><aside class="hw-catalog-rail"><input class="hw-catalog-search" type="search" placeholder="${escapeCatalog(search)}" aria-label="${escapeCatalog(search)}"><nav aria-label="${escapeCatalog(groupsLabel)}"><ul>${rail}</ul></nav></aside><div class="hw-catalog-main"><h1>${escapeCatalog(data.title)}</h1><p class="hw-catalog-lead">${escapeCatalog(data.lead)}</p><p class="hw-catalog-provenance">${escapeCatalog(data.provenance)}</p>${data.intro ?? ""}${sections}</div></div>${SCRIPT}`;
}
