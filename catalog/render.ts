// Markup as a string and free of Node and Astro imports, so an Astro page, a page bundle and a
// generated static page all carry the same shape.

export type CatalogItem = {
  name: string;
  href: string;
  /** Words under the name, searched with it and the group's name. */
  note?: string;
  /** A short count or kind in a neutral pill, such as "3 states". */
  pill?: string;
  /** A page drawn in the tile at three quarters, loaded when the tile scrolls into view. */
  frame?: string;
  /** The frame's viewport in CSS px, such as [1440, 810] for a slide: drawn whole, scaled to the
   * tile's width, instead of at three quarters in a fixed height. */
  frameSize?: [number, number];
  /** An image drawn in the tile. */
  image?: string;
  /** Markup drawn in the tile, trusted. */
  html?: string;
};

export type CatalogGroup = { name: string; items: CatalogItem[] };

export type CatalogData = {
  title: string;
  lead: string;
  /** One line in mono: where the shown values come from, such as the brand version, and how many
   * entries the page holds, in words ("26 components"): the title carries no count. */
  provenance: string;
  groups: CatalogGroup[];
  /** Markup between the provenance line and the first group, trusted: the system's foundations. */
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

const catalogTile = (item: CatalogItem, group: string) =>
  `<li><a class="hw-card hw-catalogue-tile" href="${escapeCatalog(item.href)}" data-search="${escapeCatalog(`${group} ${item.name} ${item.note ?? ""}`.toLowerCase())}">${
    item.frame || item.image || item.html
      ? `<span class="hw-catalogue-preview"${
          item.frame && item.frameSize
            ? ` data-frame-width="${item.frameSize[0]}" style="aspect-ratio:${item.frameSize[0]}/${item.frameSize[1]}"`
            : ""
        }>${tilePreview(item)}</span>`
      : ""
  }<span class="hw-catalogue-name">${escapeCatalog(item.name)}</span>${
    item.note ? `<span class="hw-catalogue-note">${escapeCatalog(item.note)}</span>` : ""
  }${item.pill ? `<span class="hw-pill" data-tone="neutral">${escapeCatalog(item.pill)}</span>` : ""}</a></li>`;

// Filters the tiles by every word in the search field and hides a group left empty, and scales each
// sized frame to its tile's width; delegated on the document, so it holds across Astro's client
// router swaps and runs once.
const SCRIPT = `<script>(()=>{const fit=()=>{for(const p of document.querySelectorAll(".hw-catalogue-preview[data-frame-width]"))p.firstElementChild.style.transform="scale("+p.clientWidth/p.dataset.frameWidth+")";};fit();if(window.hwCatalogue)return;window.hwCatalogue=1;addEventListener("resize",fit);document.addEventListener("astro:page-load",fit);document.addEventListener("input",(e)=>{const f=e.target;if(!(f instanceof HTMLInputElement)||!f.matches(".hw-catalogue-search"))return;const q=f.value.trim().toLowerCase().split(/\\s+/);const root=f.closest(".hw-catalogue");for(const g of root.querySelectorAll(".hw-catalogue-group")){let n=0;for(const t of g.querySelectorAll(".hw-catalogue-tile")){const hit=q.every((w)=>t.dataset.search.includes(w));t.parentElement.hidden=!hit;if(hit)n++;}g.hidden=n===0;const link=root.querySelector('.hw-catalogue-rail a[href="#'+g.id+'"]');if(link)link.parentElement.hidden=n===0;}});})();</script>`;

export function renderCatalog(data: CatalogData): string {
  const { search = "Search", groups: groupsLabel = "Groups" } = data.labels ?? {};
  const groups = data.groups.filter((g) => g.items.length > 0);
  const rail = groups
    .map(
      (g) =>
        `<li><a href="#${anchorOf(g.name)}"><span>${escapeCatalog(g.name)}</span><span class="hw-catalogue-count">${g.items.length}</span></a></li>`,
    )
    .join("");
  const sections = groups
    .map(
      (g) =>
        `<section class="hw-catalogue-group" id="${anchorOf(g.name)}"><h2>${escapeCatalog(g.name)} <span class="hw-catalogue-count">${g.items.length}</span></h2><ul class="hw-catalogue-grid">${g.items.map((i) => catalogTile(i, g.name)).join("")}</ul></section>`,
    )
    .join("");
  return `<div class="hw-catalogue hw-container"><aside class="hw-catalogue-rail"><input class="hw-catalogue-search" type="search" placeholder="${escapeCatalog(search)}" aria-label="${escapeCatalog(search)}"><nav aria-label="${escapeCatalog(groupsLabel)}"><ul>${rail}</ul></nav></aside><div class="hw-catalogue-main"><h1>${escapeCatalog(data.title)}</h1><p class="hw-catalogue-lead">${escapeCatalog(data.lead)}</p><p class="hw-catalogue-provenance">${escapeCatalog(data.provenance)}</p>${data.intro ?? ""}${sections}</div></div>${SCRIPT}`;
}
