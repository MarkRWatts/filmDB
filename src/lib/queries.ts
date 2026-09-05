// Data access + shaping for the UI. Server-only (imports the Prisma client
// directly — every caller is a Server Component). Anything handed to a
// Client Component is plain data: BigInt sizeBytes is converted to a number
// here, Dates are ISO strings, so nothing needs re-shaping downstream.

import { prisma } from "@/lib/db";
import {
  resolutionTier,
  videoCodecLabel,
  WATCH_PROGRESS_MIN_SECS,
  type Format,
  type ResolutionTier,
} from "@/lib/constants";
import { audioBadge } from "@/lib/audio";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

export function formatDuration(secs: number | null | undefined): string {
  if (!secs || secs <= 0) return "—";
  const totalMins = Math.round(secs / 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export function formatRuntimeMins(mins: number | null | undefined): string {
  if (!mins || mins <= 0) return "—";
  return formatDuration(mins * 60);
}

export function resolutionLabel(width: number | null, height: number | null): string {
  if (!width || !height) return "Unknown resolution";
  return `${width}×${height}`;
}

// Best (lowest-rank) resolution tier across a film's versions — used for the
// single "best you own it in" ResolutionBadge on cards/rows where showing
// every version's tier would be clutter.
function bestResolutionTier(
  versions: { width: number | null; height: number | null }[],
): ResolutionTier {
  return versions.reduce<ResolutionTier>(
    (best, v) => {
      const t = resolutionTier(v.width, v.height);
      return t.rank < best.rank ? t : best;
    },
    { label: "?", rank: 9 },
  );
}

// ---------------------------------------------------------------------------
// Library ("/")
// ---------------------------------------------------------------------------

export interface LibraryFilm {
  id: number;
  title: string;
  sortTitle: string;
  year: number | null;
  posterPath: string | null;
  collectionId: number | null;
  collectionName: string | null;
  releaseDate: string | null;
  createdAt: string;
  owned: boolean; // digitally owned (has a ripped Version) — false for physical-only entries
  formats: Format[];
  discCount: number;
  bestTier: ResolutionTier;
  videoCodecs: string[]; // raw codec_name values ("h264", "vc1"…) — filter matches on these
  audioFormats: string[]; // friendly audioBadge labels ("DTS-HD MA", "Dolby Digital"…)
  /** Physical media you own this film on (DVD/BLURAY/UHD), independent of
   *  `owned` — non-empty with owned=false means "own the disc, not ripped
   *  yet", not a gap. Mirrors ArtistCatalogueAlbum.physicalMedia. */
  physicalMedia: Format[];
}

export interface LibraryData {
  films: LibraryFilm[];
  filmCount: number;
  discCount: number;
}

// Shared shape between the main library listing and the continue-watching
// query (below) — both end up rendering the same LibraryFilm/FilmCard, so
// they select and shape identically rather than drifting into two subtly
// different card shapes.
const FILM_CARD_SELECT = {
  id: true,
  title: true,
  sortTitle: true,
  year: true,
  posterPath: true,
  collectionId: true,
  collection: { select: { name: true } },
  releaseDate: true,
  createdAt: true,
  owned: true,
  physicalCopies: { select: { medium: true } },
  versions: {
    select: {
      format: true,
      width: true,
      height: true,
      videoCodec: true,
      audioTracks: { select: { codec: true, profile: true } },
    },
  },
};

type FilmCardSource = {
  id: number;
  title: string;
  sortTitle: string;
  year: number | null;
  posterPath: string | null;
  collectionId: number | null;
  collection: { name: string } | null;
  releaseDate: Date | null;
  createdAt: Date;
  owned: boolean;
  physicalCopies: { medium: string }[];
  versions: {
    format: string;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    audioTracks: { codec: string | null; profile: string | null }[];
  }[];
};

function shapeLibraryFilm(f: FilmCardSource): LibraryFilm {
  return {
    id: f.id,
    title: f.title,
    sortTitle: f.sortTitle,
    year: f.year,
    posterPath: f.posterPath,
    collectionId: f.collectionId,
    collectionName: f.collection?.name ?? null,
    releaseDate: f.releaseDate ? f.releaseDate.toISOString() : null,
    createdAt: f.createdAt.toISOString(),
    owned: f.owned,
    physicalMedia: f.physicalCopies.map((c) => c.medium as Format),
    formats: Array.from(new Set(f.versions.map((v) => v.format as Format))),
    discCount: f.versions.length,
    bestTier: bestResolutionTier(f.versions),
    videoCodecs: Array.from(
      new Set(f.versions.map((v) => v.videoCodec).filter((c): c is string => !!c)),
    ),
    audioFormats: Array.from(
      new Set(
        f.versions.flatMap((v) =>
          v.audioTracks.map((a) => audioBadge(a.codec, a.profile, null, null).label),
        ),
      ),
    ),
  };
}

export async function getLibraryFilms(): Promise<LibraryData> {
  const films = await prisma.film.findMany({
    // Digitally owned films, plus physical-only films (owned=false but a
    // disc is logged) — otherwise a scanned-but-unripped disc is invisible
    // everywhere in the browsing UI. See FilmCard.
    where: { OR: [{ owned: true }, { physicalCopies: { some: {} } }] },
    orderBy: { sortTitle: "asc" },
    select: FILM_CARD_SELECT,
  });

  const shaped: LibraryFilm[] = films.map(shapeLibraryFilm);

  return {
    films: shaped,
    filmCount: shaped.length,
    discCount: shaped.reduce((sum, f) => sum + f.discCount, 0),
  };
}

// ---------------------------------------------------------------------------
// Continue watching ("/" — signed-in user's in-progress films)
// ---------------------------------------------------------------------------

// The signed-in user's own in-progress films (HOUSEHOLDS_PLAN.md's "Watch
// history & stats", Phase 8): WatchProgress rows that aren't completed and
// have actually gotten somewhere (see WATCH_PROGRESS_MIN_SECS — the same
// "did they really start this" bar VideoPlayer.tsx uses for whether to seek
// on load), most-recently-updated first. TV episode progress doesn't exist
// yet (see WatchProgress.episodeFileId's doc comment in schema.prisma) —
// this only ever looks at versionId rows.
//
// Per-user, not per-household: two members of the same household watching
// the same shared-library film independently get their own row and their
// own "continue watching" entry for it.
export async function getContinueWatchingFilms(userId: string): Promise<LibraryFilm[]> {
  const rows = await prisma.watchProgress.findMany({
    where: {
      userId,
      versionId: { not: null },
      completed: false,
      positionSecs: { gte: WATCH_PROGRESS_MIN_SECS },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      version: { select: { film: { select: FILM_CARD_SELECT } } },
    },
  });

  // A film could in principle have progress on more than one Version (two
  // rips of the same title) — dedupe to one card per film, keeping the
  // most recently updated (rows already arrive in that order).
  const seenFilmIds = new Set<number>();
  const films: LibraryFilm[] = [];
  for (const row of rows) {
    const film = row.version?.film;
    if (!film || seenFilmIds.has(film.id)) continue;
    seenFilmIds.add(film.id);
    films.push(shapeLibraryFilm(film));
  }
  return films;
}

// ---------------------------------------------------------------------------
// Favourites ("/" — signed-in user's hearted films, newest first)
// ---------------------------------------------------------------------------

export async function getFavouriteFilms(userId: string): Promise<LibraryFilm[]> {
  const rows = await prisma.filmFavourite.findMany({
    where: { userId, film: { owned: true } },
    orderBy: { createdAt: "desc" },
    select: { film: { select: FILM_CARD_SELECT } },
  });
  return rows.map((r) => shapeLibraryFilm(r.film));
}

// ---------------------------------------------------------------------------
// Film detail ("/film/[id]")
// ---------------------------------------------------------------------------

export interface AudioTrackView {
  id: number;
  /** ffprobe's absolute stream index -- what Jellyfin's AudioStreamIndex
   *  and the local pipeline's -map both refer to. */
  streamIdx: number;
  codec: string | null;
  profile: string | null;
  language: string | null;
  channels: number | null;
  layout: string | null;
  title: string | null;
}

export interface VersionView {
  id: number;
  edition: string | null;
  format: Format;
  width: number | null;
  height: number | null;
  resolution: string;
  tier: ResolutionTier;
  videoCodec: string | null;
  videoRange: string | null;
  container: string | null;
  sizeLabel: string;
  durationLabel: string;
  jellyfinId: string | null;
  audioTracks: AudioTrackView[];
}

export interface CollectionMemberView {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  owned: boolean;
  releaseDate: string | null;
  bestTier: ResolutionTier;
}

export interface FilmPhysicalCopyView {
  id: number;
  medium: string;
  barcode: string | null;
  notes: string | null;
}

export interface FilmDetail {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  releaseDate: string | null;
  runtimeLabel: string;
  rating: number | null;
  genres: string[];
  matchConfidence: string;
  versions: VersionView[];
  physicalCopies: FilmPhysicalCopyView[];
  collection: { id: number; name: string; members: CollectionMemberView[] } | null;
}

export async function getFilmDetail(id: number): Promise<FilmDetail | null> {
  const film = await prisma.film.findUnique({
    where: { id },
    include: {
      versions: { include: { audioTracks: true } },
      physicalCopies: true,
      collection: {
        include: {
          films: {
            orderBy: { releaseDate: "asc" },
            include: { versions: { select: { width: true, height: true } } },
          },
        },
      },
    },
  });
  if (!film) return null;

  const versions: VersionView[] = film.versions.map((v) => ({
    id: v.id,
    edition: v.edition,
    format: v.format as Format,
    width: v.width,
    height: v.height,
    resolution: resolutionLabel(v.width, v.height),
    tier: resolutionTier(v.width, v.height),
    videoCodec: v.videoCodec,
    videoRange: v.videoRange,
    container: v.container,
    sizeLabel: formatBytes(v.sizeBytes === null ? null : Number(v.sizeBytes)),
    durationLabel: formatDuration(v.durationSecs),
    jellyfinId: v.jellyfinId,
    audioTracks: v.audioTracks.map((a) => ({
      id: a.id,
      streamIdx: a.streamIdx,
      codec: a.codec,
      profile: a.profile,
      language: a.language,
      channels: a.channels,
      layout: a.layout,
      title: a.title,
    })),
  }));

  return {
    id: film.id,
    title: film.title,
    year: film.year,
    posterPath: film.posterPath,
    backdropPath: film.backdropPath,
    overview: film.overview,
    releaseDate: film.releaseDate ? film.releaseDate.toISOString() : null,
    runtimeLabel: formatRuntimeMins(film.runtimeMins),
    rating: film.rating,
    genres: film.genres ? film.genres.split(",").map((g) => g.trim()).filter(Boolean) : [],
    matchConfidence: film.matchConfidence,
    versions,
    physicalCopies: film.physicalCopies.map((c) => ({
      id: c.id,
      medium: c.medium,
      barcode: c.barcode,
      notes: c.notes,
    })),
    collection: film.collection
      ? {
          id: film.collection.id,
          name: film.collection.name,
          members: film.collection.films.map((m) => ({
            id: m.id,
            title: m.title,
            year: m.year,
            posterPath: m.posterPath,
            owned: m.owned,
            releaseDate: m.releaseDate ? m.releaseDate.toISOString() : null,
            bestTier: bestResolutionTier(m.versions),
          })),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Collections ("/collections", "/collections/[id]")
// ---------------------------------------------------------------------------

export interface CollectionSummary {
  id: number;
  name: string;
  posterPath: string | null;
  collagePosters: (string | null)[]; // used only when posterPath is null
  ownedCount: number;
  totalCount: number;
  complete: boolean;
}

export async function getCollections(): Promise<CollectionSummary[]> {
  const collections = await prisma.collection.findMany({
    orderBy: { name: "asc" },
    include: { films: { orderBy: { releaseDate: "asc" } } },
  });

  return collections
    .filter((c) => c.films.length > 0)
    .map((c) => {
      const ownedCount = c.films.filter((f) => f.owned).length;
      return {
        id: c.id,
        name: c.name,
        posterPath: c.posterPath,
        collagePosters: c.films.slice(0, 4).map((f) => f.posterPath),
        ownedCount,
        totalCount: c.films.length,
        complete: ownedCount === c.films.length,
      };
    });
}

export interface TimelineFilm {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  owned: boolean;
  releaseDate: string | null;
  formats: Format[];
  bestTier: ResolutionTier;
  /** See LibraryFilm.physicalMedia. */
  physicalMedia: Format[];
}

export interface CollectionDetail {
  id: number;
  name: string;
  overview: string | null;
  backdropPath: string | null;
  ownedCount: number;
  totalCount: number;
  films: TimelineFilm[];
}

export async function getCollectionDetail(id: number): Promise<CollectionDetail | null> {
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      films: {
        orderBy: { releaseDate: "asc" },
        include: {
          versions: { select: { format: true, width: true, height: true } },
          physicalCopies: { select: { medium: true } },
        },
      },
    },
  });
  if (!collection) return null;

  const films: TimelineFilm[] = collection.films.map((f) => ({
    id: f.id,
    title: f.title,
    year: f.year,
    posterPath: f.posterPath,
    owned: f.owned,
    releaseDate: f.releaseDate ? f.releaseDate.toISOString() : null,
    formats: Array.from(new Set(f.versions.map((v) => v.format as Format))),
    bestTier: bestResolutionTier(f.versions),
    physicalMedia: f.physicalCopies.map((c) => c.medium as Format),
  }));

  return {
    id: collection.id,
    name: collection.name,
    overview: collection.overview,
    backdropPath: collection.backdropPath,
    ownedCount: films.filter((f) => f.owned).length,
    totalCount: films.length,
    films,
  };
}

// ---------------------------------------------------------------------------
// TV — Shows ("/shows", "/shows/[id]")
// ---------------------------------------------------------------------------

export interface ShowSummary {
  id: number;
  title: string;
  sortTitle: string;
  year: number | null;
  posterPath: string | null;
  ownedEpisodeCount: number;
  totalEpisodeCount: number;
  complete: boolean;
}

export async function getShows(): Promise<ShowSummary[]> {
  const shows = await prisma.show.findMany({
    orderBy: { sortTitle: "asc" },
    include: {
      seasons: {
        select: { episodes: { select: { owned: true } } },
      },
    },
  });

  return shows.map((s) => {
    const episodes = s.seasons.flatMap((se) => se.episodes);
    const ownedEpisodeCount = episodes.filter((e) => e.owned).length;
    const totalEpisodeCount = episodes.length;
    return {
      id: s.id,
      title: s.title,
      sortTitle: s.sortTitle,
      year: s.year,
      posterPath: s.posterPath,
      ownedEpisodeCount,
      totalEpisodeCount,
      complete: totalEpisodeCount > 0 && ownedEpisodeCount === totalEpisodeCount,
    };
  });
}

export interface EpisodeFileView {
  id: number;
  format: Format;
  width: number | null;
  height: number | null;
  resolution: string;
  tier: ResolutionTier;
  videoRange: string | null;
  audioSummary: string | null;
  sizeLabel: string;
  jellyfinId: string | null;
}

export interface EpisodeView {
  id: number;
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
  airDate: string | null;
  owned: boolean;
  files: EpisodeFileView[];
}

export interface SeasonView {
  id: number;
  seasonNumber: number;
  name: string | null;
  posterPath: string | null;
  airYear: number | null;
  ownedCount: number;
  totalCount: number;
  episodes: EpisodeView[];
}

export interface ShowDetail {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string | null;
  status: string | null;
  rating: number | null;
  genres: string[];
  matchConfidence: string;
  ownedEpisodeCount: number;
  totalEpisodeCount: number;
  seasons: SeasonView[];
}

export async function getShowDetail(id: number): Promise<ShowDetail | null> {
  const show = await prisma.show.findUnique({
    where: { id },
    include: {
      seasons: {
        orderBy: { seasonNumber: "asc" },
        include: {
          // Episodes are always ordered by episodeNumber — some shows (e.g.
          // DVD-order releases like Firefly) have air dates that don't match
          // production/disc order, so airDate must never be used here.
          episodes: {
            orderBy: { episodeNumber: "asc" },
            include: { files: true },
          },
        },
      },
    },
  });
  if (!show) return null;

  const seasons: SeasonView[] = show.seasons.map((se) => {
    const episodes: EpisodeView[] = se.episodes.map((e) => ({
      id: e.id,
      episodeNumber: e.episodeNumber,
      name: e.name,
      overview: e.overview,
      stillPath: e.stillPath,
      airDate: e.airDate ? e.airDate.toISOString() : null,
      owned: e.owned,
      files: e.files.map((f) => ({
        id: f.id,
        format: f.format as Format,
        width: f.width,
        height: f.height,
        resolution: resolutionLabel(f.width, f.height),
        tier: resolutionTier(f.width, f.height),
        videoRange: f.videoRange,
        audioSummary: f.audioSummary,
        sizeLabel: formatBytes(f.sizeBytes === null ? null : Number(f.sizeBytes)),
        jellyfinId: f.jellyfinId,
      })),
    }));
    const ownedCount = episodes.filter((e) => e.owned).length;
    return {
      id: se.id,
      seasonNumber: se.seasonNumber,
      name: se.name,
      posterPath: se.posterPath,
      airYear: se.airDate ? se.airDate.getFullYear() : null,
      ownedCount,
      totalCount: episodes.length,
      episodes,
    };
  });

  const ownedEpisodeCount = seasons.reduce((sum, s) => sum + s.ownedCount, 0);
  const totalEpisodeCount = seasons.reduce((sum, s) => sum + s.totalCount, 0);

  return {
    id: show.id,
    title: show.title,
    year: show.year,
    posterPath: show.posterPath,
    backdropPath: show.backdropPath,
    overview: show.overview,
    status: show.status,
    rating: show.rating,
    genres: show.genres ? show.genres.split(",").map((g) => g.trim()).filter(Boolean) : [],
    matchConfidence: show.matchConfidence,
    ownedEpisodeCount,
    totalEpisodeCount,
    seasons,
  };
}

// ---------------------------------------------------------------------------
// Report ("/report")
// ---------------------------------------------------------------------------

export interface MissingFilmView {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

export interface MissingGroup {
  collectionId: number;
  collectionName: string;
  films: MissingFilmView[];
}

export interface UpgradeCandidate {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  discCount: number;
  formats: Format[];
}

export interface IssueFilm {
  id: number;
  title: string;
  year: number | null;
  matchConfidence: string;
  hasUnknownFormatVersion: boolean;
  missingYear: boolean;
}

export interface FormatStat {
  key: string;
  label: string;
  count: number;
}

export interface ReportData {
  totals: {
    filmsOwned: number;
    discs: number;
    uhdFilmCount: number;
    blurayCount: number;
    dvdCount: number;
    collectionsComplete: number;
    collectionsIncomplete: number;
    missingCount: number;
  };
  missingByCollection: MissingGroup[];
  upgradeCandidates: UpgradeCandidate[];
  issues: IssueFilm[];
  formatStats: {
    video: FormatStat[];
    audio: FormatStat[];
  };
}

export async function getReportData(): Promise<ReportData> {
  const [ownedFilms, missingFilms, collections] = await Promise.all([
    prisma.film.findMany({
      where: { owned: true },
      orderBy: { sortTitle: "asc" },
      include: { versions: { include: { audioTracks: true } } },
    }),
    prisma.film.findMany({
      where: { owned: false },
      orderBy: { releaseDate: "asc" },
      include: { collection: true, physicalCopies: { select: { id: true } } },
    }),
    prisma.collection.findMany({ include: { films: true } }),
  ]);

  const discs = ownedFilms.flatMap((f) => f.versions);
  const blurayCount = discs.filter((v) => v.format === "BLURAY").length;
  const dvdCount = discs.filter((v) => v.format === "DVD").length;
  const uhdFilmCount = ownedFilms.filter((f) =>
    f.versions.some((v) => v.format === "UHD"),
  ).length;

  const collectionsComplete = collections.filter(
    (c) => c.films.length > 0 && c.films.every((f) => f.owned),
  ).length;
  const collectionsWithFilms = collections.filter((c) => c.films.length > 0);
  const collectionsIncomplete = collectionsWithFilms.length - collectionsComplete;

  const missingByCollectionMap = new Map<number, MissingGroup>();
  for (const f of missingFilms) {
    if (!f.collection) continue;
    // Owned=false but with a FilmPhysicalCopy isn't a gap — you have the
    // disc, just haven't ripped it — so it's excluded here, same as the
    // music report treats a physical-only album (queries-music.ts).
    if (f.physicalCopies.length > 0) continue;
    const key = f.collection.id;
    if (!missingByCollectionMap.has(key)) {
      missingByCollectionMap.set(key, {
        collectionId: f.collection.id,
        collectionName: f.collection.name,
        films: [],
      });
    }
    missingByCollectionMap.get(key)!.films.push({
      id: f.id,
      title: f.title,
      year: f.year,
      posterPath: f.posterPath,
    });
  }

  const upgradeCandidates: UpgradeCandidate[] = ownedFilms
    .filter(
      (f) =>
        f.versions.length > 0 &&
        f.versions.every((v) => v.format === "DVD" || v.format === "SD"),
    )
    .map((f) => ({
      id: f.id,
      title: f.title,
      year: f.year,
      posterPath: f.posterPath,
      discCount: f.versions.length,
      formats: Array.from(new Set(f.versions.map((v) => v.format as Format))),
    }));

  const issues: IssueFilm[] = ownedFilms
    .filter(
      (f) =>
        f.matchConfidence === "LOW" ||
        f.matchConfidence === "UNMATCHED" ||
        f.versions.some((v) => v.format === "UNKNOWN") ||
        f.year === null,
    )
    .map((f) => ({
      id: f.id,
      title: f.title,
      year: f.year,
      matchConfidence: f.matchConfidence,
      hasUnknownFormatVersion: f.versions.some((v) => v.format === "UNKNOWN"),
      missingYear: f.year === null,
    }));

  const videoCodecCounts = new Map<string, number>();
  for (const v of discs) {
    if (!v.videoCodec) continue;
    videoCodecCounts.set(v.videoCodec, (videoCodecCounts.get(v.videoCodec) ?? 0) + 1);
  }
  const videoStats: FormatStat[] = Array.from(videoCodecCounts.entries())
    .map(([codec, count]) => ({ key: codec, label: videoCodecLabel(codec), count }))
    .sort((a, b) => b.count - a.count);

  const audioCounts = new Map<string, number>();
  for (const v of discs) {
    for (const a of v.audioTracks) {
      const { label } = audioBadge(a.codec, a.profile, null, null);
      audioCounts.set(label, (audioCounts.get(label) ?? 0) + 1);
    }
  }
  const audioStats: FormatStat[] = Array.from(audioCounts.entries())
    .map(([label, count]) => ({ key: label, label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totals: {
      filmsOwned: ownedFilms.length,
      discs: discs.length,
      uhdFilmCount,
      blurayCount,
      dvdCount,
      collectionsComplete,
      collectionsIncomplete,
      missingCount: missingFilms.length,
    },
    missingByCollection: Array.from(missingByCollectionMap.values()),
    upgradeCandidates,
    issues,
    formatStats: { video: videoStats, audio: audioStats },
  };
}

// ---------------------------------------------------------------------------
// Watch stats ("/stats" — signed-in user's own watch history, Phase 9 of
// HOUSEHOLDS_PLAN.md's "Watch history & stats"). Deliberately kept small per
// the plan's own wording: total watch time, most-watched titles/genres, a
// recently-watched list — no charts, no household-wide aggregation (every
// query below is scoped to one userId). TV/episode progress doesn't exist
// yet (see WatchProgress.episodeFileId's doc comment in schema.prisma), so,
// same as getContinueWatchingFilms, this only ever looks at versionId rows.
// ---------------------------------------------------------------------------

export interface WatchStatsFilm {
  id: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

export interface MostWatchedFilm extends WatchStatsFilm {
  playCount: number;
  completed: boolean;
}

export interface GenreStat {
  genre: string;
  secs: number;
}

export interface RecentlyWatchedRow {
  film: WatchStatsFilm;
  positionSecs: number;
  durationSecs: number | null;
  completed: boolean;
  playCount: number;
  updatedAt: string;
}

export interface WatchStats {
  totalWatchSecs: number;
  // Distinct titles with any qualifying progress — NOT mostWatched.length,
  // since that list is capped at MOST_WATCHED_LIMIT.
  totalFilmsWatched: number;
  // Sum of playCount across every qualifying row (not deduped by film —
  // see the dedup note on the most-watched loop below), i.e. "how many
  // times has this person pressed play on something, in total".
  totalPlays: number;
  mostWatched: MostWatchedFilm[];
  topGenres: GenreStat[];
  recentlyWatched: RecentlyWatchedRow[];
}

const MOST_WATCHED_LIMIT = 10;
const TOP_GENRES_LIMIT = 8;
const RECENTLY_WATCHED_LIMIT = 30;

// What "total watch time" means here — there's no single obviously-correct
// definition, so this is the one picked and the reasoning for it:
//
// WatchProgress.positionSecs is "where the last session left off", not a
// running total — naively summing it across rows would (a) undercount a
// film watched three times (each rewatch overwrites positionSecs, so a
// completed-then-rewatched film only ever shows ONE play's worth of
// position, even though playCount says otherwise) and (b) treat a film
// abandoned at 10% the same as one that just started, forever, since an
// in-progress row's positionSecs never grows once you stop watching it.
//
// So: a COMPLETED row (reached WATCH_COMPLETED_RATIO of the runtime, per
// the progress route) is assumed to represent playCount genuine full
// watches — each viewing that ends in "completed" plausibly watched close
// to the whole thing, so runtime × playCount is a reasonable estimate of
// total time spent on it. This can overcount someone who abandoned a film
// twice and only finished it the third time (all three plays would count
// as full watches, when two weren't) — an acceptable v1 approximation
// given WatchProgress keeps no per-session history, only the latest state.
//
// An INCOMPLETE row contributes its current positionSecs exactly once,
// regardless of playCount — it's "how far into this one they've gotten
// right now", not multiplied, since there's no basis for assuming earlier
// plays of a still-in-progress film were full watches (unlike the
// completed case, we don't even have a completion signal to anchor that
// assumption on). This does undercount a film that's been restarted and
// abandoned multiple times without ever finishing, but avoids fabricating
// numbers with no signal behind them.
//
// The runtime figure itself prefers Version.durationSecs (the actual
// probed file length) over Film.runtimeMins (TMDB metadata, coarser and
// sometimes absent); when a version was never probed, positionSecs itself
// is used as the runtime stand-in for a completed row, since reaching
// WATCH_COMPLETED_RATIO means positionSecs is already close to the real
// runtime by construction.
function watchContributionSecs(row: {
  positionSecs: number;
  completed: boolean;
  playCount: number;
  durationSecs: number | null;
}): number {
  if (!row.completed) return row.positionSecs;
  const runtime = row.durationSecs ?? row.positionSecs;
  return runtime * Math.max(1, row.playCount);
}

export async function getWatchStats(userId: string): Promise<WatchStats> {
  // Same WATCH_PROGRESS_MIN_SECS floor getContinueWatchingFilms uses — a
  // few-second preview never really "started", so it shouldn't count as
  // watch time, a most-watched title, or a recently-watched entry either.
  const rows = await prisma.watchProgress.findMany({
    where: { userId, versionId: { not: null }, positionSecs: { gte: WATCH_PROGRESS_MIN_SECS } },
    orderBy: { updatedAt: "desc" },
    select: {
      positionSecs: true,
      completed: true,
      playCount: true,
      updatedAt: true,
      version: {
        select: {
          durationSecs: true,
          film: { select: { id: true, title: true, year: true, posterPath: true, genres: true } },
        },
      },
    },
  });

  type Row = (typeof rows)[number] & { version: NonNullable<(typeof rows)[number]["version"]> };
  const usable = rows.filter((r): r is Row => r.version !== null);

  // --- total watch time + genre weighting ---
  //
  // Genres are weighted by the same per-row watchContributionSecs() used
  // for the total, split evenly across a film's comma-separated genre tags
  // (Film.genres — see schema.prisma), rather than a separate playCount- or
  // completion-only count: reusing one already-justified number keeps
  // "most-watched genres" answering "where did the watch time above
  // actually go", not a second, differently-weighted metric that could
  // rank genres in a different order than the time totals would suggest.
  // Unlike the most-watched-titles list below, this is NOT deduped across
  // multiple Versions of the same film — time spent watching two different
  // rips of the same title is still time spent, so both rows' contributions
  // count.
  let totalWatchSecs = 0;
  const genreSecs = new Map<string, number>();
  for (const r of usable) {
    const contribution = watchContributionSecs({
      positionSecs: r.positionSecs,
      completed: r.completed,
      playCount: r.playCount,
      durationSecs: r.version.durationSecs,
    });
    totalWatchSecs += contribution;

    const genres = r.version.film.genres
      ? r.version.film.genres.split(",").map((g) => g.trim()).filter(Boolean)
      : [];
    if (genres.length > 0) {
      const share = contribution / genres.length;
      for (const g of genres) {
        genreSecs.set(g, (genreSecs.get(g) ?? 0) + share);
      }
    }
  }
  const topGenres = Array.from(genreSecs.entries())
    .map(([genre, secs]) => ({ genre, secs }))
    .sort((a, b) => b.secs - a.secs)
    .slice(0, TOP_GENRES_LIMIT);

  // --- most-watched titles: ranked by playCount desc, ties broken by most
  // recent updatedAt. `usable` already arrives updatedAt-desc from the
  // query above and Array.prototype.sort is stable (ES2019+), so sorting
  // only on playCount preserves that original order among ties — no
  // separate tiebreak comparator needed. A film with progress on more than
  // one Version (two rips) is deduped to its first (most-recently-updated)
  // occurrence, same posture as getContinueWatchingFilms — "most watched
  // title" should mean the title, not double-count because of how many rips
  // exist of it. */
  const seenFilmIds = new Set<number>();
  const mostWatchedCandidates: MostWatchedFilm[] = [];
  for (const r of usable) {
    const f = r.version.film;
    if (seenFilmIds.has(f.id)) continue;
    seenFilmIds.add(f.id);
    mostWatchedCandidates.push({
      id: f.id,
      title: f.title,
      year: f.year,
      posterPath: f.posterPath,
      playCount: r.playCount,
      completed: r.completed,
    });
  }
  const mostWatched = mostWatchedCandidates
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, MOST_WATCHED_LIMIT);

  const totalFilmsWatched = seenFilmIds.size;
  const totalPlays = usable.reduce((sum, r) => sum + r.playCount, 0);

  // --- recently watched: a plain "what did I watch and when" list, capped
  // so a long-time user's page doesn't grow unbounded. ---
  const recentlyWatched: RecentlyWatchedRow[] = usable.slice(0, RECENTLY_WATCHED_LIMIT).map((r) => ({
    film: {
      id: r.version.film.id,
      title: r.version.film.title,
      year: r.version.film.year,
      posterPath: r.version.film.posterPath,
    },
    positionSecs: r.positionSecs,
    durationSecs: r.version.durationSecs,
    completed: r.completed,
    playCount: r.playCount,
    updatedAt: r.updatedAt.toISOString(),
  }));

  return { totalWatchSecs, totalFilmsWatched, totalPlays, mostWatched, topGenres, recentlyWatched };
}

// ---------------------------------------------------------------------------
// TV report data ("/report" — TV section)
// ---------------------------------------------------------------------------

export interface ShowGapLine {
  key: string;
  text: string;
}

export interface ShowGapGroup {
  showId: number;
  showTitle: string;
  posterPath: string | null;
  lines: ShowGapLine[];
}

export interface TvReportData {
  showsTotal: number;
  showsComplete: number;
  episodesOwned: number;
  episodesTotal: number;
  missingByShow: ShowGapGroup[];
}

function padEpisodeNumber(n: number): string {
  return n.toString().padStart(2, "0");
}

// Collapse a set of missing episode numbers within one season into short
// range labels: [1,2,3,7] -> "E01-E03, E07".
function episodeRangeLabel(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(
      start === prev
        ? `E${padEpisodeNumber(start)}`
        : `E${padEpisodeNumber(start)}-E${padEpisodeNumber(prev)}`,
    );
    start = n;
    prev = n;
  }
  parts.push(
    start === prev
      ? `E${padEpisodeNumber(start)}`
      : `E${padEpisodeNumber(start)}-E${padEpisodeNumber(prev)}`,
  );
  return parts.join(", ");
}

export async function getTvReportData(): Promise<TvReportData> {
  const shows = await prisma.show.findMany({
    orderBy: { sortTitle: "asc" },
    include: {
      seasons: {
        orderBy: { seasonNumber: "asc" },
        include: {
          episodes: {
            orderBy: { episodeNumber: "asc" },
            select: { episodeNumber: true, owned: true },
          },
        },
      },
    },
  });

  let episodesOwned = 0;
  let episodesTotal = 0;
  let showsComplete = 0;
  const missingByShow: ShowGapGroup[] = [];

  for (const show of shows) {
    const lines: ShowGapLine[] = [];
    let ownedForShow = 0;
    let totalForShow = 0;

    for (const season of show.seasons) {
      const total = season.episodes.length;
      const owned = season.episodes.filter((e) => e.owned).length;
      ownedForShow += owned;
      totalForShow += total;

      if (total > 0 && owned === 0) {
        // Whole season missing — one summary line, not one per episode.
        lines.push({
          key: `s${season.seasonNumber}`,
          text: `Season ${season.seasonNumber} — ${total} episode${total === 1 ? "" : "s"}`,
        });
      } else if (owned < total) {
        const missingNums = season.episodes.filter((e) => !e.owned).map((e) => e.episodeNumber);
        lines.push({
          key: `s${season.seasonNumber}`,
          text: `S${padEpisodeNumber(season.seasonNumber)}: ${episodeRangeLabel(missingNums)} missing`,
        });
      }
    }

    episodesOwned += ownedForShow;
    episodesTotal += totalForShow;
    if (totalForShow > 0 && ownedForShow === totalForShow) showsComplete++;

    if (lines.length > 0) {
      missingByShow.push({
        showId: show.id,
        showTitle: show.title,
        posterPath: show.posterPath,
        lines,
      });
    }
  }

  return {
    showsTotal: shows.length,
    showsComplete,
    episodesOwned,
    episodesTotal,
    missingByShow,
  };
}
