"use client";

import { useMemo, useState } from "react";
import FilmCard from "@/components/FilmCard";
import FilmShelf from "@/components/FilmShelf";
import StackedFilmCard from "@/components/StackedFilmCard";
import { videoCodecLabel } from "@/lib/constants";
import type { LibraryFilm } from "@/lib/queries";

type FilterKey = "all" | "collection" | "noposter";
type SortKey = "title" | "year" | "added";
const ALL_CODECS = "all";
const SHELF_SIZE = 20;

type FilmItem = { kind: "film"; film: LibraryFilm; sortTitle: string; year: number; addedAt: number };
type CollectionItem = {
  kind: "collection";
  collectionId: number;
  collectionName: string;
  films: LibraryFilm[];
  sortTitle: string;
  year: number;
  addedAt: number;
};
type DisplayItem = FilmItem | CollectionItem;

function filmItem(f: LibraryFilm): FilmItem {
  return { kind: "film", film: f, sortTitle: f.sortTitle, year: f.year ?? 0, addedAt: new Date(f.createdAt).getTime() };
}

// Chronological order within a collection: release date, falling back to year.
function byRelease(a: LibraryFilm, b: LibraryFilm): number {
  if (a.releaseDate && b.releaseDate) return a.releaseDate.localeCompare(b.releaseDate);
  return (a.year ?? 0) - (b.year ?? 0);
}

// Splits films into standalone films and collection groups (2+ owned members
// in the current filtered set), each group chronologically ordered and
// carrying representative sort keys (its most notable member) so it slots
// into a sorted list naturally. Collections get pulled out entirely here —
// they're rendered in their own row rather than folded into a member's
// "best format" section (a 25-Blu-ray/DVD-mixed set like James Bond has no
// single honest format to sit under).
function buildDisplayItems(films: LibraryFilm[]): { films: FilmItem[]; collections: CollectionItem[] } {
  const byCollection = new Map<number, LibraryFilm[]>();
  for (const f of films) {
    if (f.collectionId === null) continue;
    const list = byCollection.get(f.collectionId) ?? [];
    list.push(f);
    byCollection.set(f.collectionId, list);
  }

  const filmItems: FilmItem[] = [];
  const collectionItems: CollectionItem[] = [];
  const seenCollections = new Set<number>();

  for (const f of films) {
    if (f.collectionId !== null && (byCollection.get(f.collectionId)?.length ?? 0) > 1) {
      if (seenCollections.has(f.collectionId)) continue;
      seenCollections.add(f.collectionId);
      const members = [...byCollection.get(f.collectionId)!].sort(byRelease);
      collectionItems.push({
        kind: "collection",
        collectionId: f.collectionId,
        collectionName: f.collectionName ?? "Collection",
        films: members,
        sortTitle: members.reduce((min, m) => (m.sortTitle < min ? m.sortTitle : min), members[0].sortTitle),
        year: members.reduce((max, m) => Math.max(max, m.year ?? 0), 0),
        addedAt: members.reduce((max, m) => Math.max(max, new Date(m.createdAt).getTime()), 0),
      });
    } else {
      filmItems.push(filmItem(f));
    }
  }

  return { films: filmItems, collections: collectionItems };
}

function sortItems<T extends DisplayItem>(items: T[], sort: SortKey): T[] {
  const sorted = [...items];
  if (sort === "title") sorted.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
  else if (sort === "year") sorted.sort((a, b) => b.year - a.year);
  else sorted.sort((a, b) => b.addedAt - a.addedAt);
  return sorted;
}

// Media-type section a film belongs to, best format first — mirrors the
// disc-format precedence used elsewhere (UHD > BLURAY > DVD). "Other"
// (HD/SD/UNKNOWN) exists so nothing is silently dropped, but per the "empty
// categories don't show" rule it never renders when the library has none.
type FormatSectionKey = "4K" | "Blu-ray" | "DVD" | "Other";
const FORMAT_SECTION_ORDER: FormatSectionKey[] = ["4K", "Blu-ray", "DVD", "Other"];

function formatSectionFor(film: LibraryFilm): FormatSectionKey {
  // Physical-only films have no ripped Versions (so no formats/bestTier) —
  // section them by the disc medium instead, so a scanned Blu-ray sits
  // alongside owned Blu-ray rips rather than falling into "Other".
  const formats = film.formats.length > 0 ? film.formats : film.physicalMedia;
  if (formats.includes("UHD") || film.bestTier.rank === 0) return "4K";
  if (formats.includes("BLURAY")) return "Blu-ray";
  if (formats.includes("DVD")) return "DVD";
  return "Other";
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={`h-4 w-4 text-text-faint transition-transform ${collapsed ? "-rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SectionHeader({
  title,
  count,
  collapsed,
  onToggle,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex items-center gap-2 text-left">
      <ChevronIcon collapsed={collapsed} />
      <h2 className="font-display text-xl tracking-wide">{title}</h2>
      <span className="font-mono text-xs text-text-faint">
        {count} film{count === 1 ? "" : "s"}
      </span>
    </button>
  );
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "collection", label: "In a collection" },
  { key: "noposter", label: "No poster" },
];

const COLLECTIONS_SECTION = "Collections";

export default function LibraryBrowser({
  films,
  continueWatching = [],
  favourites = [],
}: {
  films: LibraryFilm[];
  /** Signed-in user's in-progress films (see getContinueWatchingFilms) —
   *  rendered as its own shelf ahead of "New releases"/"Recently added".
   *  Empty for a signed-out request or a user with nothing in progress;
   *  FilmShelf itself renders nothing when its list is empty. */
  continueWatching?: LibraryFilm[];
  /** Signed-in user's hearted films (see getFavouriteFilms), shelved
   *  after "Recently added". Empty list = no shelf. */
  favourites?: LibraryFilm[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [videoCodec, setVideoCodec] = useState(ALL_CODECS);
  const [audioFormat, setAudioFormat] = useState(ALL_CODECS);
  const [sort, setSort] = useState<SortKey>("title");
  const [stack, setStack] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const newReleases = useMemo(
    () =>
      films
        .filter((f) => f.releaseDate !== null)
        .sort((a, b) => b.releaseDate!.localeCompare(a.releaseDate!))
        .slice(0, SHELF_SIZE),
    [films],
  );

  const recentlyAdded = useMemo(
    () =>
      [...films]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, SHELF_SIZE),
    [films],
  );

  const videoCodecOptions = useMemo(() => {
    const set = new Set<string>();
    films.forEach((f) => f.videoCodecs.forEach((c) => set.add(c)));
    return Array.from(set).sort((a, b) => videoCodecLabel(a).localeCompare(videoCodecLabel(b)));
  }, [films]);

  const audioFormatOptions = useMemo(() => {
    const set = new Set<string>();
    films.forEach((f) => f.audioFormats.forEach((a) => set.add(a)));
    return Array.from(set).sort();
  }, [films]);

  const filtered = useMemo(() => {
    let list = films;

    if (filter === "collection") list = list.filter((f) => f.collectionId !== null);
    else if (filter === "noposter") list = list.filter((f) => !f.posterPath);

    if (videoCodec !== ALL_CODECS) list = list.filter((f) => f.videoCodecs.includes(videoCodec));
    if (audioFormat !== ALL_CODECS)
      list = list.filter((f) => f.audioFormats.includes(audioFormat));

    const q = query.trim().toLowerCase();
    if (q) list = list.filter((f) => f.title.toLowerCase().includes(q));

    return list;
  }, [films, filter, videoCodec, audioFormat, query]);

  // Stacking on: collections are pulled into their own row, format sections
  // only ever see standalone films. Stacking off: no grouping at all — every
  // film (collection member or not) sorts and sections individually.
  const { collectionItems, formatFilmItems } = useMemo(() => {
    if (!stack) return { collectionItems: [] as CollectionItem[], formatFilmItems: filtered.map(filmItem) };
    const { films: standalone, collections } = buildDisplayItems(filtered);
    return { collectionItems: collections, formatFilmItems: standalone };
  }, [filtered, stack]);

  const sortedCollectionItems = useMemo(
    () => sortItems(collectionItems, sort),
    [collectionItems, sort],
  );
  const sortedFormatFilmItems = useMemo(
    () => sortItems(formatFilmItems, sort),
    [formatFilmItems, sort],
  );

  const formatSections = useMemo(() => {
    const byKey = new Map<FormatSectionKey, FilmItem[]>();
    for (const item of sortedFormatFilmItems) {
      const key = formatSectionFor(item.film);
      const list = byKey.get(key) ?? [];
      list.push(item);
      byKey.set(key, list);
    }
    return FORMAT_SECTION_ORDER.map((key) => ({ key, items: byKey.get(key) ?? [] })).filter(
      (s) => s.items.length > 0,
    );
  }, [sortedFormatFilmItems]);

  if (films.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
        <p className="font-display text-2xl tracking-wide text-text-muted">
          No films yet
        </p>
        <p className="max-w-sm text-sm text-text-faint">
          Run a scan from the admin strip in the top-right to index your collection.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative">
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <circle cx="9" cy="9" r="6" />
              <path d="M17 17l-4-4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles…"
              aria-label="Search titles"
              className="w-full rounded-md border border-border bg-bg-elevated py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-text-faint focus-visible:outline-none sm:w-56"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`inline-flex min-h-10 items-center justify-center rounded-full border px-3 py-1 text-xs font-medium tracking-wide transition-colors sm:min-h-0 ${
                  filter === f.key
                    ? "border-accent-border bg-accent-dim text-accent"
                    : "border-border text-text-muted hover:border-border-strong hover:text-text"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Video
            <select
              value={videoCodec}
              onChange={(e) => setVideoCodec(e.target.value)}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text focus-visible:outline-none"
            >
              <option value={ALL_CODECS}>All</option>
              {videoCodecOptions.map((c) => (
                <option key={c} value={c}>
                  {videoCodecLabel(c)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Audio
            <select
              value={audioFormat}
              onChange={(e) => setAudioFormat(e.target.value)}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text focus-visible:outline-none"
            >
              <option value={ALL_CODECS}>All</option>
              {audioFormatOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text focus-visible:outline-none"
            >
              <option value="title">Title</option>
              <option value="year">Year</option>
              <option value="added">Recently added</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={stack}
              onChange={(e) => setStack(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-accent"
            />
            Stack collections
          </label>
        </div>
      </div>

      <p className="text-xs text-text-faint">
        {filtered.length === films.length ? (
          <>
            {films.length} film{films.length === 1 ? "" : "s"}
          </>
        ) : (
          <>
            {filtered.length} of {films.length} films
          </>
        )}
      </p>

      <FilmShelf title="Continue watching" films={continueWatching} />
      <FilmShelf title="New releases" films={newReleases} />
      <FilmShelf title="Recently added" films={recentlyAdded} />
      <FilmShelf title="Favourites" films={favourites} />

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-24 text-center">
          <p className="text-sm text-text-muted">No films match.</p>
          <p className="text-xs text-text-faint">Try a different search or filter.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {sortedCollectionItems.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionHeader
                title={COLLECTIONS_SECTION}
                count={sortedCollectionItems.reduce((sum, item) => sum + item.films.length, 0)}
                collapsed={collapsedSections.has(COLLECTIONS_SECTION)}
                onToggle={() => toggleSection(COLLECTIONS_SECTION)}
              />
              {!collapsedSections.has(COLLECTIONS_SECTION) && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
                  {sortedCollectionItems.map((item) => (
                    <StackedFilmCard
                      key={`c${item.collectionId}`}
                      collectionId={item.collectionId}
                      collectionName={item.collectionName}
                      films={item.films}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {formatSections.map(({ key, items }) => (
            <section key={key} className="flex flex-col gap-3">
              <SectionHeader
                title={key}
                count={items.length}
                collapsed={collapsedSections.has(key)}
                onToggle={() => toggleSection(key)}
              />
              {!collapsedSections.has(key) && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
                  {items.map((item) => (
                    <FilmCard key={item.film.id} film={item.film} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
