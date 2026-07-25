/**
 * Changelog feed controller — progressive enhancement for tag filtering and
 * "load older" reveal. No framework; vanilla DOM. Re-inits on Astro view
 * transitions via `astro:page-load`.
 */

function initChangelog(): void {
  const feed = document.querySelector<HTMLElement>("[data-changelog-feed]");
  if (!feed) return;
  if (feed.dataset.clInit === "1") return;
  feed.dataset.clInit = "1";

  const entries = Array.from(feed.querySelectorAll<HTMLElement>("[data-entry]"));
  const emptyState = feed.querySelector<HTMLElement>("[data-changelog-empty]");
  const loadMore = feed.querySelector<HTMLAnchorElement>("[data-load-more]");
  const chips = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-filter-tag]"),
  );

  const pageSizeRaw = feed.dataset.pageSize ?? "";
  const pageSize = pageSizeRaw ? parseInt(pageSizeRaw, 10) : entries.length;
  const overflowEntries = entries.filter((e) => e.hasAttribute("data-overflow"));

  let activeTag = "";
  let revealed = 0;

  const entryTags = (el: HTMLElement): string[] =>
    (el.dataset.tags ?? "").split(",").filter(Boolean);
  const matches = (el: HTMLElement): boolean =>
    activeTag === "" || entryTags(el).includes(activeTag);

  function recompute(): void {
    const filtering = activeTag !== "";
    let visibleCount = 0;
    let lastVisible: HTMLElement | null = null;
    for (const el of entries) {
      const isOverflow = el.hasAttribute("data-overflow");
      let visible = matches(el);
      if (visible && !filtering && isOverflow) {
        visible = overflowEntries.indexOf(el) < revealed;
      }
      el.hidden = !visible;
      if (visible) {
        visibleCount += 1;
        lastVisible = el;
      }
    }
    // Close the rail at the last visible node — drop its dangling segment.
    for (const el of entries) {
      el.toggleAttribute("data-rail-end", el === lastVisible);
    }
    if (emptyState) emptyState.hidden = visibleCount > 0;
    if (loadMore) loadMore.hidden = filtering || revealed >= overflowEntries.length;
  }

  function setTag(tag: string): void {
    activeTag = tag;
    for (const chip of chips) {
      chip.setAttribute(
        "aria-pressed",
        (chip.dataset.filterTag ?? "") === tag ? "true" : "false",
      );
    }
    const url = new URL(window.location.href);
    if (tag) url.searchParams.set("tag", tag);
    else url.searchParams.delete("tag");
    window.history.replaceState({}, "", url);
    recompute();
  }

  for (const chip of chips) {
    chip.addEventListener("click", () => setTag(chip.dataset.filterTag ?? ""));
  }
  if (loadMore) {
    loadMore.addEventListener("click", (e) => {
      e.preventDefault();
      revealed = Math.min(revealed + pageSize, overflowEntries.length);
      recompute();
    });
  }

  const initialTag = new URL(window.location.href).searchParams.get("tag") ?? "";
  const known = chips.some((c) => (c.dataset.filterTag ?? "") === initialTag);
  if (initialTag && known) setTag(initialTag);
  else recompute();
}

document.addEventListener("DOMContentLoaded", initChangelog);
document.addEventListener("astro:page-load", initChangelog);
