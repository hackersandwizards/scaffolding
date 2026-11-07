// Markup as a string and free of Node and Astro imports, so an Astro page, a page bundle and a
// generated static page all carry the same shape.

export type CatalogItem = {
  name: string;
  href: string;
  /** Words under the name, searched with it and the group's name. */
  note?: string;
  /** A short count or kind in a neutral pill, such as "3 states". */
  pill?: string;
  /** A page drawn in the tile at three quarters, centred, loaded when the tile scrolls into view. */
  frame?: string;
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
    ? `<iframe src="${escapeCatalog(item.frame)}" loading="lazy" tabindex="-1" aria-hidden="true" title=""${
        item.frameSize ? ` style="width:${item.frameSize[0]}px;height:${item.frameSize[1]}px"` : ""
      }></iframe>`
    : item.image
      ? `<img src="${escapeCatalog(item.image)}" alt="" loading="lazy">`
      : (item.html ?? "");

// data-hw-shell marks the shell's own brand elements, the tile's card and pill, which a check of the
// repository's own elements skips.
const catalogTile = (item: CatalogItem, group: string) =>
  `<li><a class="hw-card hw-catalogue-tile" data-hw-shell href="${escapeCatalog(item.href)}" data-search="${escapeCatalog(`${group} ${item.name} ${item.note ?? ""}`.toLowerCase())}">${
    item.frame || item.image || item.html
      ? `<span class="hw-catalogue-preview"${
          item.frame && item.frameSize
            ? ` data-frame-width="${item.frameSize[0]}" style="aspect-ratio:${item.frameSize[0]}/${item.frameSize[1]}"`
            : ""
        }>${tilePreview(item)}</span>`
      : ""
  }<span class="hw-catalogue-name">${escapeCatalog(item.name)}</span>${
    item.note ? `<span class="hw-catalogue-note">${escapeCatalog(item.note)}</span>` : ""
  }${item.pill ? `<span class="hw-pill" data-tone="neutral" data-hw-shell>${escapeCatalog(item.pill)}</span>` : ""}</a></li>`;

// Filters the tiles and the rail's names by every word in the search field and hides a group left
// empty, a group of markup while the field holds a word; draws each sized frame whole at its
// tile's width, and centres every other frame's content on the content's own ground, shrunk where
// it is taller than the tile and measured afresh each time, so a refit never shrinks it again, as
// Storybook's "centered" layout does. Marks the rail's label of the group read now with
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
const c=m.childElementCount===1?m.firstElementChild:m,r=c.getBoundingClientRect();if(!r.height)return;
const s=Math.min(0.75,(p.clientHeight-16)/r.height,p.clientWidth/r.width);
if(r.bottom>f.clientHeight)f.style.height=r.bottom+"px";
f.style.transform="translate("+((p.clientWidth-r.width*s)/2-r.left*s)+"px,"+((p.clientHeight-r.height*s)/2-r.top*s)+"px) scale("+s+")";
const ground=[c,m,d.body,d.documentElement].map((e)=>d.defaultView.getComputedStyle(e).backgroundColor).find((b)=>!/^(transparent|rgba\\(.*, 0\\))$/.test(b));
if(ground)p.style.background=ground;};
const all=()=>document.querySelectorAll(".hw-catalogue-preview").forEach(fit);all();
const spy=()=>{for(const root of document.querySelectorAll(".hw-catalogue")){
const groups=[...root.querySelectorAll(".hw-catalogue-group")].filter((g)=>g.getClientRects().length),last=groups.at(-1);
let on=groups.findLast((g)=>g.getBoundingClientRect().top<=innerHeight/3);
const m=document.querySelector("main"),s=m&&m.scrollHeight>m.clientHeight?m:document.scrollingElement;
if(on&&s.scrollTop+s.clientHeight>=s.scrollHeight-1){const hit=groups.find((g)=>"#"+encodeURIComponent(g.id)===location.hash);if(hit&&hit.getBoundingClientRect().top>=0)on=hit;else if(s.scrollTop>0)on=last;}
for(const a of root.querySelectorAll(".hw-catalogue-rail > nav > ul > li > a")){const mine=on&&a.getAttribute("href")==="#"+on.id,was=a.getAttribute("aria-current");
if(mine&&!was){const box=a.closest("nav"),r=a.getBoundingClientRect(),b=box.getBoundingClientRect();a.setAttribute("aria-current","true");if(r.top<b.top||r.bottom>b.bottom)box.scrollTop+=r.top-b.top-8;}
else if(!mine&&was==="true")a.removeAttribute("aria-current");}}};spy();
if(window.hwCatalogue)return;window.hwCatalogue=1;
let frame=0,tick=0;const later=()=>{cancelAnimationFrame(tick);tick=requestAnimationFrame(spy);};
addEventListener("resize",()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{all();spy();});});document.addEventListener("astro:page-load",()=>{all();spy();});
document.addEventListener("scroll",later,{capture:true,passive:true});
document.addEventListener("load",(e)=>{const p=e.target.parentElement;if(e.target instanceof HTMLIFrameElement&&p&&p.matches(".hw-catalogue-preview")){fit(p);e.target.contentDocument?.fonts?.ready.then(()=>fit(p));}},true);
document.addEventListener("input",(e)=>{const f=e.target;if(!(f instanceof HTMLInputElement)||!f.matches(".hw-catalogue-search"))return;
const q=f.value.trim().toLowerCase().split(/\\s+/);const typed=q.join("")!=="";const root=f.closest(".hw-catalogue");
for(const g of root.querySelectorAll(".hw-catalogue-group")){let n=0;const link=root.querySelector('.hw-catalogue-rail a[href="#'+g.id+'"]'),names=link?.nextElementSibling?.children??[];
g.querySelectorAll(".hw-catalogue-tile").forEach((t,i)=>{const hit=q.every((w)=>t.dataset.search.includes(w));t.parentElement.hidden=!hit;if(names[i])names[i].hidden=!hit;if(hit)n++;});
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
    g.items.length ? `<span class="hw-catalogue-count">${g.items.length}</span>` : "";
  const rail = groups
    .map(
      (g) =>
        `<li><a href="#${g.anchor}"><span>${escapeCatalog(g.name)}</span>${count(g)}</a>${g.html === undefined ? `<ul class="hw-catalogue-names">${g.items.map((i) => `<li><a href="${escapeCatalog(i.href)}">${escapeCatalog(i.name)}</a></li>`).join("")}</ul>` : ""}</li>`,
    )
    .join("");
  const sections = groups
    .map(
      (g) =>
        `<section class="hw-catalogue-group" id="${g.anchor}"><h2>${[escapeCatalog(g.name), count(g)].filter(Boolean).join(" ")}</h2>${g.html === undefined ? `<ul class="hw-catalogue-grid">${g.items.map((i) => catalogTile(i, g.name)).join("")}</ul>` : `<div class="hw-catalogue-text">${g.html}</div>`}</section>`,
    )
    .join("");
  return `<div class="hw-catalogue hw-container"><aside class="hw-catalogue-rail"><input class="hw-catalogue-search" type="search" placeholder="${escapeCatalog(search)}" aria-label="${escapeCatalog(search)}"><nav aria-label="${escapeCatalog(groupsLabel)}"><ul>${rail}</ul></nav></aside><div class="hw-catalogue-main"><h1>${escapeCatalog(data.title)}</h1><p class="hw-catalogue-lead">${escapeCatalog(data.lead)}</p><p class="hw-catalogue-provenance">${escapeCatalog(data.provenance)}</p>${data.intro ?? ""}${sections}</div></div>${SCRIPT}`;
}
