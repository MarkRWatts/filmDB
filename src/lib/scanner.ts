// Walks MOVIES_PATH (and, optionally, TVSHOWS_PATH / MUSIC_PATH), parses
// filenames, probes files with ffprobe, and upserts Film/Version/AudioTrack,
// Show/ShowSeason/Episode/EpisodeFile, and Artist/Album/Track rows in a
// single SCAN run. See PLAN.md "Scanner" / SPEC-MUSIC.md "Scanner" and the
// identity rules in the schema doc comments.

import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe, type ProbedAudioTrack } from "@/lib/ffprobe";
import { parseFileName, filmKey, normalizeTitle, sortTitle, VIDEO_EXTENSIONS, type ParsedFile } from "@/lib/parse";
import { parseEpisodePath, type ParsedEpisodeFile } from "@/lib/parse-tv";
import { parseTrackPath, type ParsedTrack } from "@/lib/parse-music";
import { classifyFormat, isLosslessCodec, MUSIC_EXTENSIONS } from "@/lib/constants";
import { audioBadge } from "@/lib/audio";
import { guardAndCreateRun, updateProgress, finishRun, failRun, type RunKind } from "@/lib/runs";

const MAX_DEPTH = 3;
const PROBE_CONCURRENCY = 3;
const PROGRESS_UPDATE_EVERY = 3;

interface CandidateFile {
  parsed: ParsedFile;
  absPath: string;
  size: number;
  mtimeMs: number;
}

async function walk(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip rather than fail the whole scan
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(root, abs, depth + 1, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) out.push(path.relative(root, abs));
    }
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Resolve (or create) the Film identity for a group of files that share a
 * filmKey. Handles the owned=false → owned=true reconciliation for films
 * that already exist as TMDB-collection placeholders.
 */
async function resolveFilm(representative: ParsedFile, log: string[]): Promise<number> {
  let film = null;

  // Cascade through identifiers rather than picking exactly one branch: a
  // rip's imdbId tag may not match a barcode-scan stub whose imdbId wasn't
  // backfilled yet (TMDB doesn't always return imdb_id at stub-creation
  // time), so a miss on the highest-priority signal must fall through to
  // the next one instead of going straight to create() and leaving the
  // stub's physical copy permanently unlinked.
  if (representative.imdbId) {
    film = await prisma.film.findUnique({ where: { imdbId: representative.imdbId } });
  }
  if (!film && representative.tmdbId) {
    film = await prisma.film.findUnique({ where: { tmdbId: representative.tmdbId } });
  }
  if (!film) {
    // Match owned films AND physical-only ones (owned:false but a
    // FilmPhysicalCopy exists) — a rip whose filename carries no imdb/tmdb
    // tag (or whose tag doesn't match an unbackfilled stub) should still
    // merge into a disc you already logged instead of creating a
    // duplicate. Mirrors the same OR in getLibraryFilms.
    const normTitle = normalizeTitle(representative.title);
    const candidates = await prisma.film.findMany({
      where: {
        year: representative.year,
        OR: [{ owned: true }, { physicalCopies: { some: {} } }],
      },
    });
    film = candidates.find((f) => normalizeTitle(f.title) === normTitle) ?? null;
  }

  if (film) {
    const updates: Record<string, unknown> = {};
    if (!film.owned) {
      updates.owned = true;
      log.push(`Merged "${film.title}"${film.year ? ` (${film.year})` : ""} — was tracked as a missing collection film, found on disk`);
    }
    if (representative.imdbId && !film.imdbId) updates.imdbId = representative.imdbId;
    if (representative.tmdbId && !film.tmdbId) updates.tmdbId = representative.tmdbId;
    if (Object.keys(updates).length > 0) {
      film = await prisma.film.update({ where: { id: film.id }, data: updates });
    }
    return film.id;
  }

  const created = await prisma.film.create({
    data: {
      title: representative.title,
      sortTitle: sortTitle(representative.title),
      year: representative.year,
      imdbId: representative.imdbId,
      tmdbId: representative.tmdbId,
      owned: true,
    },
  });
  return created.id;
}

// Derive Version.videoRange from the probe's HDR signals. Dolby Vision side
// data wins regardless of the base layer's transfer characteristic (most DV
// encodes carry an HDR10-compatible base layer, i.e. smpte2084, alongside
// the DV enhancement layer). Only set when the probe actually succeeded —
// callers should leave videoRange untouched on probe failure.
function deriveVideoRange(colorTransfer: string | null, hasDolbyVision: boolean): string {
  if (hasDolbyVision) return "DOLBY_VISION";
  if (colorTransfer === "smpte2084") return "HDR10";
  if (colorTransfer === "arib-std-b67") return "HLG";
  return "SDR";
}

async function processVersion(
  file: CandidateFile,
  filmId: number,
  log: string[],
  force: boolean,
): Promise<void> {
  const { parsed, absPath, size, mtimeMs } = file;
  const existing = await prisma.version.findUnique({ where: { filePath: parsed.relPath } });

  const needProbe =
    force || !existing || existing.sizeBytes === null || Number(existing.sizeBytes) !== size || existing.mtimeMs !== mtimeMs;

  const baseData = {
    filmId,
    fileName: parsed.fileName,
    edition: parsed.edition,
    container: parsed.container || null,
  };

  if (!needProbe) {
    await prisma.version.update({ where: { filePath: parsed.relPath }, data: baseData });
    return;
  }

  try {
    const result = await probe(absPath);
    const format = classifyFormat(result.width);
    const videoRange = deriveVideoRange(result.colorTransfer, result.hasDolbyVision);
    const sizeBytes = BigInt(Math.round(result.sizeBytes ?? size));

    const version = await prisma.version.upsert({
      where: { filePath: parsed.relPath },
      create: {
        ...baseData,
        filePath: parsed.relPath,
        width: result.width,
        height: result.height,
        videoCodec: result.videoCodec,
        videoRange,
        durationSecs: result.durationSecs,
        sizeBytes,
        mtimeMs,
        format,
        probedAt: new Date(),
      },
      update: {
        ...baseData,
        width: result.width,
        height: result.height,
        videoCodec: result.videoCodec,
        videoRange,
        durationSecs: result.durationSecs,
        sizeBytes,
        mtimeMs,
        format,
        probedAt: new Date(),
      },
    });

    await prisma.audioTrack.deleteMany({ where: { versionId: version.id } });
    if (result.audioTracks.length > 0) {
      await prisma.audioTrack.createMany({
        data: result.audioTracks.map((t) => ({
          versionId: version.id,
          streamIdx: t.streamIdx,
          codec: t.codec,
          profile: t.profile,
          language: t.language,
          channels: t.channels,
          layout: t.layout,
          title: t.title,
          isDefault: t.isDefault,
          isDescriptive: t.isDescriptive,
        })),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Probe failed for "${parsed.relPath}": ${message}`);
    const fallbackFormat = (parsed.resolutionTag ?? 0) >= 720 ? "BLURAY" : "UNKNOWN";
    await prisma.version.upsert({
      where: { filePath: parsed.relPath },
      create: { ...baseData, filePath: parsed.relPath, format: fallbackFormat },
      update: { ...baseData, format: existing?.format && existing.format !== "UNKNOWN" ? existing.format : fallbackFormat },
    });
  }
}

// --- TV ---

interface TvCandidate {
  parsed: ParsedEpisodeFile;
  absPath: string;
  size: number;
  mtimeMs: number;
}

// Fields written to an EpisodeFile row, excluding the (filePath, episodeId)
// identity — shared shape between the cache-hit (fileName/container only)
// and freshly-probed update paths.
interface EpisodeFileData {
  fileName: string;
  container: string | null;
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  videoRange?: string;
  durationSecs?: number | null;
  sizeBytes?: bigint;
  mtimeMs?: number;
  format?: string;
  audioSummary?: string | null;
  probedAt?: Date;
}

// Build the human-readable audio track summary stored on EpisodeFile, e.g.
// "DTS-HD MA · 5.1 · ENG; Dolby Digital · Stereo · ENG" — reuses the same
// audioBadge() labelling the movie UI uses for Version audio tracks.
function buildAudioSummary(tracks: ProbedAudioTrack[]): string | null {
  if (tracks.length === 0) return null;
  return tracks
    .map((t) => {
      const { label, sublabel } = audioBadge(t.codec, t.profile, t.channels, t.layout);
      const parts = [label];
      if (sublabel) parts.push(sublabel);
      if (t.language) parts.push(t.language.toUpperCase());
      return parts.join(" · ");
    })
    .join("; ");
}

/** Resolve (or create) the Show identity for a top-level TV folder. Title,
 * sortTitle, and year come from the folder name; TMDB enrichment fills in
 * the rest later and is never touched here. */
async function resolveShow(showFolder: string, title: string, year: number | null): Promise<number> {
  const show = await prisma.show.upsert({
    where: { folder: showFolder },
    create: { folder: showFolder, title, sortTitle: sortTitle(title), year },
    update: { title, sortTitle: sortTitle(title), year },
  });
  return show.id;
}

async function resolveSeason(showId: number, seasonNumber: number): Promise<number> {
  const season = await prisma.showSeason.upsert({
    where: { showId_seasonNumber: { showId, seasonNumber } },
    create: { showId, seasonNumber },
    update: {},
  });
  return season.id;
}

/** Resolve (or create) an owned Episode. Only ever touches `owned` — name,
 * overview, stillPath, airDate, runtimeMins are TMDB manifest data. */
async function resolveEpisode(seasonId: number, episodeNumber: number): Promise<number> {
  const episode = await prisma.episode.upsert({
    where: { seasonId_episodeNumber: { seasonId, episodeNumber } },
    create: { seasonId, episodeNumber, owned: true },
    update: { owned: true },
  });
  return episode.id;
}

/**
 * Probe (or skip, per the mtime+size cache) one TV file and upsert an
 * EpisodeFile row for each episode it covers — more than one for a
 * multi-episode range file (S01E01-E02): same filePath, one row per
 * episodeId, kept in sync with identical probe data.
 */
async function processEpisodeFile(
  file: TvCandidate,
  episodeIds: number[],
  log: string[],
  force: boolean,
): Promise<void> {
  const { parsed, absPath, size, mtimeMs } = file;
  const existingRows = await prisma.episodeFile.findMany({ where: { filePath: parsed.relPath } });
  const existing = existingRows[0];

  const needProbe =
    force || !existing || existing.sizeBytes === null || Number(existing.sizeBytes) !== size || existing.mtimeMs !== mtimeMs;

  const baseData: EpisodeFileData = {
    fileName: parsed.fileName,
    container: parsed.container || null,
  };

  const upsertAll = async (data: EpisodeFileData) => {
    for (const episodeId of episodeIds) {
      await prisma.episodeFile.upsert({
        where: { filePath_episodeId: { filePath: parsed.relPath, episodeId } },
        create: { ...data, filePath: parsed.relPath, episodeId },
        update: data,
      });
    }
  };

  if (!needProbe) {
    await upsertAll(baseData);
    return;
  }

  try {
    const result = await probe(absPath);
    const format = classifyFormat(result.width);
    const videoRange = deriveVideoRange(result.colorTransfer, result.hasDolbyVision);
    const sizeBytes = BigInt(Math.round(result.sizeBytes ?? size));

    await upsertAll({
      ...baseData,
      width: result.width,
      height: result.height,
      videoCodec: result.videoCodec,
      videoRange,
      durationSecs: result.durationSecs,
      sizeBytes,
      mtimeMs,
      format,
      audioSummary: buildAudioSummary(result.audioTracks),
      probedAt: new Date(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Probe failed for "${parsed.relPath}": ${message}`);
    const fallbackFormat = existing?.format && existing.format !== "UNKNOWN" ? existing.format : "UNKNOWN";
    await upsertAll({ ...baseData, format: fallbackFormat });
  }
}

// --- Music ---

interface MusicCandidateFile {
  parsed: ParsedTrack;
  absPath: string;
  size: number;
  mtimeMs: number;
}

// Compilations is the one iTunes pseudo-artist folder that gets indexed as a
// various=true Artist (skip Discogs artist matching, see discogs.ts).
const COMPILATIONS_FOLDER = "Compilations";

function isLocalizedFolder(name: string): boolean {
  return name.endsWith(".localized");
}

/**
 * Walk MUSIC_PATH's fixed Artist/Album/file layout and return every audio
 * file's path relative to `root`. Unlike the generic movie/TV `walk()`, this
 * is a dedicated two-level walk (not a recursive MAX_DEPTH descent) because
 * the iTunes layout is exactly Artist/Album/file — deeper nesting isn't part
 * of the spec. Skips `*.localized` folders (e.g. "Automatically Add to
 * Music.localized") and dot-files (".DS_Store", "._*" AppleDouble) at every
 * level, same as the movie/TV walkers.
 */
async function walkMusic(root: string): Promise<string[]> {
  const out: string[] = [];
  let artistEntries: Dirent[];
  try {
    artistEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const artistEntry of artistEntries) {
    if (!artistEntry.isDirectory()) continue;
    if (artistEntry.name.startsWith(".")) continue;
    if (isLocalizedFolder(artistEntry.name)) continue;

    const artistAbs = path.join(root, artistEntry.name);
    let albumEntries: Dirent[];
    try {
      albumEntries = await fs.readdir(artistAbs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const albumEntry of albumEntries) {
      if (!albumEntry.isDirectory()) continue;
      if (albumEntry.name.startsWith(".")) continue;
      if (isLocalizedFolder(albumEntry.name)) continue;

      const albumAbs = path.join(artistAbs, albumEntry.name);
      let fileEntries: Dirent[];
      try {
        fileEntries = await fs.readdir(albumAbs, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile()) continue;
        if (fileEntry.name.startsWith(".")) continue; // .DS_Store, ._* AppleDouble
        const ext = path.extname(fileEntry.name).slice(1).toLowerCase();
        if (!MUSIC_EXTENSIONS.has(ext)) continue;
        out.push(path.relative(root, path.join(albumAbs, fileEntry.name)));
      }
    }
  }

  return out;
}

/** Resolve (or create) the Artist identity for a top-level music folder. */
async function resolveArtist(artistFolder: string, artistName: string, various: boolean): Promise<number> {
  const artist = await prisma.artist.upsert({
    where: { folder: artistFolder },
    create: { folder: artistFolder, name: artistName, sortName: sortTitle(artistName), various },
    update: { name: artistName, sortName: sortTitle(artistName), various },
  });
  return artist.id;
}

/**
 * Resolve (or create) an owned Album under an Artist. Only touches identity
 * fields (title/sortTitle/owned) — discogsMasterId/discogsReleaseId/year/kind/coverPath/trackTotal are
 * Discogs enrichment data (discogs.ts) and are never written here.
 */
async function resolveAlbum(artistId: number, albumFolder: string, albumTitle: string): Promise<number> {
  const album = await prisma.album.upsert({
    where: { artistId_folder: { artistId, folder: albumFolder } },
    create: { artistId, folder: albumFolder, title: albumTitle, sortTitle: sortTitle(albumTitle), owned: true },
    update: { title: albumTitle, sortTitle: sortTitle(albumTitle), owned: true },
  });
  return album.id;
}

/**
 * Probe (or skip, per the mtime+size cache) one music file and upsert its
 * Track row. `.m4p` (FairPlay DRM) files are never probed — ffprobe can't
 * read encrypted audio anyway — and are recorded with codec "drm".
 */
async function processTrack(file: MusicCandidateFile, albumId: number, log: string[], force: boolean): Promise<void> {
  const { parsed, absPath, size, mtimeMs } = file;
  const existing = await prisma.track.findUnique({ where: { filePath: parsed.relPath } });

  const baseData = {
    albumId,
    disc: parsed.disc,
    trackNumber: parsed.trackNumber,
    title: parsed.title,
    fileName: parsed.fileName,
  };

  if (parsed.codecHint === "drm") {
    const data = {
      ...baseData,
      codec: "drm",
      lossless: false,
      sizeBytes: BigInt(Math.round(size)),
      mtimeMs,
      probedAt: new Date(),
    };
    await prisma.track.upsert({
      where: { filePath: parsed.relPath },
      create: { ...data, filePath: parsed.relPath },
      update: data,
    });
    return;
  }

  const needProbe =
    force || !existing || existing.sizeBytes === null || Number(existing.sizeBytes) !== size || existing.mtimeMs !== mtimeMs;

  if (!needProbe) {
    await prisma.track.update({ where: { filePath: parsed.relPath }, data: baseData });
    return;
  }

  try {
    // First audio stream only — .m4a files also carry an mjpeg cover-art
    // stream, which ffprobe reports as a second (video-typed) stream; the
    // audioTracks filter already excludes it.
    const result = await probe(absPath);
    const audio = result.audioTracks[0];
    const codec = audio?.codec ?? "unknown";
    const sizeBytes = BigInt(Math.round(result.sizeBytes ?? size));

    const data = {
      ...baseData,
      codec,
      lossless: isLosslessCodec(codec),
      sampleRate: audio?.sampleRate ?? null,
      bitDepth: audio?.bitDepth ?? null,
      durationSecs: result.durationSecs,
      sizeBytes,
      tagYear: result.tagYear,
      mtimeMs,
      probedAt: new Date(),
    };

    await prisma.track.upsert({
      where: { filePath: parsed.relPath },
      create: { ...data, filePath: parsed.relPath },
      update: data,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Probe failed for "${parsed.relPath}": ${message}`);
    await prisma.track.upsert({
      where: { filePath: parsed.relPath },
      create: { ...baseData, filePath: parsed.relPath },
      update: baseData,
    });
  }
}

// Lazy import to avoid a module-load cycle (jellyfin.ts doesn't import
// scanner.ts, but keeping the coupling one-directional and load-time-free is
// cheap insurance). Fire-and-forget: a scan shouldn't block on Jellyfin.
async function triggerJellyfinSync(): Promise<void> {
  const { jellyfinConfigured, runJellyfinSync } = await import("@/lib/jellyfin");
  if (jellyfinConfigured()) {
    runJellyfinSync().catch((err) => console.error("[scanner] post-scan Jellyfin sync failed to start:", err));
  }
}

async function doScanFilms(runId: number, force: boolean): Promise<void> {
  const log: string[] = [];
  const moviesPath = process.env.MOVIES_PATH;
  if (!moviesPath) throw new Error("MOVIES_PATH is not set");

  const relPaths: string[] = [];
  await walk(moviesPath, moviesPath, 0, relPaths);

  const candidates: CandidateFile[] = [];
  for (const relPath of relPaths) {
    const absPath = path.join(moviesPath, relPath);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      log.push(`Could not stat "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseFileName(relPath);
    if (parsed.year == null) log.push(`No year parsed for "${relPath}"`);
    candidates.push({ parsed, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  const total = candidates.length;
  await updateProgress(runId, { total, filesSeen: 0, progress: 0, message: `Found ${total} movie file(s)` });

  let completed = 0;
  async function reportProgress(message: string): Promise<void> {
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, { progress: completed, filesSeen: completed, message });
    }
  }

  // Group by filmKey and resolve Film identity for each group up front.
  const groups = new Map<string, CandidateFile[]>();
  for (const c of candidates) {
    const key = filmKey(c.parsed);
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  const filmIdByPath = new Map<string, number>();
  for (const files of groups.values()) {
    const filmId = await resolveFilm(files[0].parsed, log);
    for (const f of files) filmIdByPath.set(f.parsed.relPath, filmId);
  }

  // Probe + upsert versions, bounded concurrency (SMB share).
  await mapPool(candidates, PROBE_CONCURRENCY, async (file) => {
    const filmId = filmIdByPath.get(file.parsed.relPath)!;
    await processVersion(file, filmId, log, force);
    await reportProgress(`Probed ${completed}/${total}: ${file.parsed.fileName}`);
  });

  // Delete Version rows for files no longer on disk.
  const seenPaths = new Set(candidates.map((c) => c.parsed.relPath));
  const allVersions = await prisma.version.findMany({ select: { id: true, filePath: true } });
  const staleVersionIds = allVersions.filter((v) => !seenPaths.has(v.filePath)).map((v) => v.id);
  if (staleVersionIds.length > 0) {
    await prisma.version.deleteMany({ where: { id: { in: staleVersionIds } } });
    log.push(`Removed ${staleVersionIds.length} version(s) for files no longer on disk`);
  }

  // Owned films left with zero versions: drop, unless they're collection
  // members (revert to a "missing" placeholder instead).
  const emptyOwnedFilms = await prisma.film.findMany({
    where: { owned: true, versions: { none: {} } },
    select: { id: true, title: true, collectionId: true },
  });
  for (const f of emptyOwnedFilms) {
    if (f.collectionId != null) {
      await prisma.film.update({ where: { id: f.id }, data: { owned: false } });
      log.push(`"${f.title}" has no versions left — reverted to missing (still a collection member)`);
    } else {
      await prisma.film.delete({ where: { id: f.id } });
      log.push(`Deleted "${f.title}" — no versions left`);
    }
  }

  await finishRun(runId, log, `Scanned ${total} movie file(s)`);
  await triggerJellyfinSync();
}

async function doScanTv(runId: number, force: boolean): Promise<void> {
  const log: string[] = [];
  const tvShowsPath = process.env.TVSHOWS_PATH;
  if (!tvShowsPath) throw new Error("TVSHOWS_PATH is not set");

  const tvRelPaths: string[] = [];
  await walk(tvShowsPath, tvShowsPath, 0, tvRelPaths);

  const tvCandidates: TvCandidate[] = [];
  let tvUnparsed = 0;
  for (const relPath of tvRelPaths) {
    const absPath = path.join(tvShowsPath, relPath);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      log.push(`Could not stat "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseEpisodePath(relPath);
    if (!parsed) {
      tvUnparsed++;
      log.push(`Could not parse episode info from "${relPath}"`);
      continue;
    }
    tvCandidates.push({ parsed, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  const total = tvCandidates.length;
  await updateProgress(runId, {
    total,
    filesSeen: 0,
    progress: 0,
    message: `Found ${total} TV episode file(s)${tvUnparsed ? ` (${tvUnparsed} unparsed)` : ""}`,
  });

  let completed = 0;
  async function reportProgress(message: string): Promise<void> {
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, { progress: completed, filesSeen: completed, message });
    }
  }

  // Resolve Show/Season/Episode identities up front, serially (like
  // resolveFilm) — cheap and keeps the concurrent probe phase free of
  // upsert races on the same Show/ShowSeason row.
  const showIdByFolder = new Map<string, number>();
  const seasonIdByKey = new Map<string, number>();
  const episodeIdsByPath = new Map<string, number[]>();

  for (const c of tvCandidates) {
    const { parsed } = c;
    let showId = showIdByFolder.get(parsed.showFolder);
    if (showId === undefined) {
      showId = await resolveShow(parsed.showFolder, parsed.showTitle, parsed.showYear);
      showIdByFolder.set(parsed.showFolder, showId);
    }
    const seasonKey = `${showId}:${parsed.season}`;
    let seasonId = seasonIdByKey.get(seasonKey);
    if (seasonId === undefined) {
      seasonId = await resolveSeason(showId, parsed.season);
      seasonIdByKey.set(seasonKey, seasonId);
    }
    const episodeIds: number[] = [];
    for (const epNum of parsed.episodes) {
      episodeIds.push(await resolveEpisode(seasonId, epNum));
    }
    episodeIdsByPath.set(parsed.relPath, episodeIds);
  }

  // Probe + upsert episode files, bounded concurrency (SMB share).
  await mapPool(tvCandidates, PROBE_CONCURRENCY, async (file) => {
    const episodeIds = episodeIdsByPath.get(file.parsed.relPath)!;
    await processEpisodeFile(file, episodeIds, log, force);
    await reportProgress(`Probed ${completed}/${total}: ${file.parsed.fileName}`);
  });

  // Delete EpisodeFile rows for TV files no longer on disk.
  const seenTvPaths = new Set(tvCandidates.map((c) => c.parsed.relPath));
  const allEpisodeFiles = await prisma.episodeFile.findMany({ select: { id: true, filePath: true } });
  const staleEpisodeFileIds = allEpisodeFiles.filter((f) => !seenTvPaths.has(f.filePath)).map((f) => f.id);
  if (staleEpisodeFileIds.length > 0) {
    await prisma.episodeFile.deleteMany({ where: { id: { in: staleEpisodeFileIds } } });
    log.push(`Removed ${staleEpisodeFileIds.length} episode file(s) for TV files no longer on disk`);
  }

  // Owned episodes left with zero files: revert to a TMDB manifest
  // placeholder (owned=false) if the show is TMDB-matched — that row is
  // what the missing-episode report is built from — otherwise drop it.
  const emptyOwnedEpisodes = await prisma.episode.findMany({
    where: { owned: true, files: { none: {} } },
    select: {
      id: true,
      episodeNumber: true,
      season: { select: { seasonNumber: true, show: { select: { title: true, tmdbId: true } } } },
    },
  });
  for (const ep of emptyOwnedEpisodes) {
    const label = `"${ep.season.show.title}" S${ep.season.seasonNumber}E${ep.episodeNumber}`;
    if (ep.season.show.tmdbId != null) {
      await prisma.episode.update({ where: { id: ep.id }, data: { owned: false } });
      log.push(`${label} has no files left — reverted to missing (show is TMDB-matched)`);
    } else {
      await prisma.episode.delete({ where: { id: ep.id } });
      log.push(`Deleted ${label} — no files left, show not TMDB-matched`);
    }
  }

  // Shows whose top-level folder vanished from disk.
  let topEntries: Dirent[] = [];
  try {
    topEntries = await fs.readdir(tvShowsPath, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  const currentFolders = new Set(
    topEntries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name),
  );
  const allShows = await prisma.show.findMany({ select: { id: true, folder: true, title: true } });
  for (const s of allShows) {
    if (currentFolders.has(s.folder)) continue;
    await prisma.show.delete({ where: { id: s.id } });
    log.push(`Deleted show "${s.title}" — folder "${s.folder}" no longer on disk`);
  }

  await finishRun(runId, log, `Scanned ${total} TV episode file(s)`);
  await triggerJellyfinSync();
}

async function doScanMusic(runId: number, force: boolean): Promise<void> {
  const log: string[] = [];
  const musicPath = process.env.MUSIC_PATH;
  if (!musicPath) throw new Error("MUSIC_PATH is not set");

  const musicRelPaths = await walkMusic(musicPath);

  const musicCandidates: MusicCandidateFile[] = [];
  let musicUnparsed = 0;
  for (const relPath of musicRelPaths) {
    const absPath = path.join(musicPath, relPath);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      log.push(`Could not stat "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseTrackPath(relPath);
    if (!parsed) {
      musicUnparsed++;
      log.push(`Could not parse track info from "${relPath}"`);
      continue;
    }
    musicCandidates.push({ parsed, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  const total = musicCandidates.length;
  await updateProgress(runId, {
    total,
    filesSeen: 0,
    progress: 0,
    message: `Found ${total} music file(s)${musicUnparsed ? ` (${musicUnparsed} unparsed)` : ""}`,
  });

  let completed = 0;
  async function reportProgress(message: string): Promise<void> {
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, { progress: completed, filesSeen: completed, message });
    }
  }

  // Resolve Artist/Album identities up front, serially (like
  // resolveShow/resolveSeason) — avoids upsert races on the same
  // Artist/Album row during the concurrent probe phase below.
  const artistIdByFolder = new Map<string, number>();
  const albumIdByKey = new Map<string, number>();

  for (const c of musicCandidates) {
    const { parsed } = c;
    let artistId = artistIdByFolder.get(parsed.artistFolder);
    if (artistId === undefined) {
      const various = parsed.artistFolder === COMPILATIONS_FOLDER;
      artistId = await resolveArtist(parsed.artistFolder, parsed.artistName, various);
      artistIdByFolder.set(parsed.artistFolder, artistId);
    }
    const albumKey = `${artistId}:${parsed.albumFolder}`;
    let albumId = albumIdByKey.get(albumKey);
    if (albumId === undefined) {
      albumId = await resolveAlbum(artistId, parsed.albumFolder, parsed.albumTitle);
      albumIdByKey.set(albumKey, albumId);
    }
  }

  // Probe + upsert tracks, bounded concurrency (SMB share).
  await mapPool(musicCandidates, PROBE_CONCURRENCY, async (file) => {
    const albumKey = `${artistIdByFolder.get(file.parsed.artistFolder)}:${file.parsed.albumFolder}`;
    const albumId = albumIdByKey.get(albumKey)!;
    await processTrack(file, albumId, log, force);
    await reportProgress(`Probed ${completed}/${total}: ${file.parsed.fileName}`);
  });

  // Delete Track rows for music files no longer on disk.
  const seenMusicPaths = new Set(musicCandidates.map((c) => c.parsed.relPath));
  const allTracks = await prisma.track.findMany({ select: { id: true, filePath: true } });
  const staleTrackIds = allTracks.filter((t) => !seenMusicPaths.has(t.filePath)).map((t) => t.id);
  if (staleTrackIds.length > 0) {
    await prisma.track.deleteMany({ where: { id: { in: staleTrackIds } } });
    log.push(`Removed ${staleTrackIds.length} track(s) for music files no longer on disk`);
  }

  // Owned albums left with zero tracks: if Discogs-matched and still a
  // studio album, revert to a "missing" back-catalogue placeholder
  // (owned=false, folder cleared — same shape as the placeholders
  // discogs.ts creates for albums we never owned); otherwise there's no
  // back-catalogue reason to keep the row, so delete it outright.
  const emptyOwnedAlbums = await prisma.album.findMany({
    where: { owned: true, tracks: { none: {} } },
    select: { id: true, title: true, discogsMasterId: true, discogsReleaseId: true, kind: true },
  });
  for (const a of emptyOwnedAlbums) {
    if ((a.discogsMasterId != null || a.discogsReleaseId != null) && a.kind === "STUDIO") {
      await prisma.album.update({ where: { id: a.id }, data: { owned: false, folder: null } });
      log.push(`"${a.title}" has no tracks left — reverted to missing (studio album, Discogs-matched)`);
    } else {
      await prisma.album.delete({ where: { id: a.id } });
      log.push(`Deleted "${a.title}" — no tracks left`);
    }
  }

  // Artists left with zero albums at all (every album either deleted above
  // or, if never owned, never existed for this artist in the first place).
  const emptyArtists = await prisma.artist.findMany({
    where: { albums: { none: {} } },
    select: { id: true, name: true },
  });
  for (const ar of emptyArtists) {
    await prisma.artist.delete({ where: { id: ar.id } });
    log.push(`Deleted artist "${ar.name}" — no albums left`);
  }

  // Fallback release year from the files' own date tags for albums
  // Discogs can't match (all of Compilations by design, plus title
  // mismatches): the modal tagYear across the album's tracks. Discogs-matched
  // albums always take Discogs' date instead (enrichment overwrites).
  const yearless = await prisma.album.findMany({
    where: {
      owned: true,
      year: null,
      discogsMasterId: null,
      discogsReleaseId: null,
      tracks: { some: { tagYear: { not: null } } },
    },
    select: { id: true, title: true, tracks: { select: { tagYear: true } } },
  });
  for (const a of yearless) {
    const counts = new Map<number, number>();
    for (const t of a.tracks) {
      if (t.tagYear != null) counts.set(t.tagYear, (counts.get(t.tagYear) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestN = 0;
    for (const [y, n] of counts) {
      if (n > bestN) {
        best = y;
        bestN = n;
      }
    }
    if (best != null) {
      await prisma.album.update({ where: { id: a.id }, data: { year: best } });
      log.push(`Set year ${best} for "${a.title}" from the files' own date tags`);
    }
  }

  await finishRun(runId, log, `Scanned ${total} music file(s)`);
}

// --- Adult ---
// One file = one Scene row, no identity/grouping step needed (unlike
// Film/Show) — the confirmed layout is a subfolder per studio, so the
// generic walk() above (already depth-bounded, already extension-filtered)
// is reused as-is; the immediate parent folder name becomes Scene.folder, a
// display/matching hint only. Title enrichment (real title, studio,
// performers) is ThePornDB's job (theporndb.ts) — this pass only derives a
// placeholder title so an unenriched Scene has something to display.

interface SceneCandidate {
  relPath: string;
  absPath: string;
  fileName: string;
  folder: string | null;
  size: number;
  mtimeMs: number;
}

/** Light cleanup for a pre-enrichment placeholder title only — strips the
 *  extension and swaps separator characters for spaces. Deliberately not
 *  the aggressive noise-stripping theporndb.ts does to build its search
 *  query (resolution tags, track-number prefixes, SITE.COM branding) —
 *  that's tailored to what ThePornDB's parser needs, this is just "better
 *  than the raw filename" for an interim display. */
function placeholderSceneTitle(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  return withoutExt.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

async function processScene(file: SceneCandidate, log: string[], force: boolean): Promise<void> {
  const { relPath, absPath, fileName, folder, size, mtimeMs } = file;
  const existing = await prisma.scene.findUnique({ where: { filePath: relPath } });

  const needProbe =
    force || !existing || existing.sizeBytes === null || Number(existing.sizeBytes) !== size || existing.mtimeMs !== mtimeMs;

  const baseData = { fileName, folder };

  if (!needProbe) {
    await prisma.scene.update({ where: { filePath: relPath }, data: baseData });
    return;
  }

  const title = existing?.title ?? placeholderSceneTitle(fileName);
  // Same derivation as Film/Version's container (parse.ts) — the file
  // extension, not ffprobe's format_name. Never set before this fix, which
  // left every Scene's container null and defeated planVideoPlayback's
  // MP4_LIKE_CONTAINERS check, forcing an unnecessary transcode (or worse)
  // for every scene regardless of it already being a direct-playable MP4.
  const dotIdx = fileName.lastIndexOf(".");
  const container = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : null;

  try {
    const result = await probe(absPath);
    const format = classifyFormat(result.width);
    const videoRange = deriveVideoRange(result.colorTransfer, result.hasDolbyVision);
    const sizeBytes = BigInt(Math.round(result.sizeBytes ?? size));

    await prisma.scene.upsert({
      where: { filePath: relPath },
      create: {
        ...baseData,
        filePath: relPath,
        title,
        sortTitle: sortTitle(title),
        width: result.width,
        height: result.height,
        videoCodec: result.videoCodec,
        videoRange,
        container,
        durationSecs: result.durationSecs,
        sizeBytes,
        mtimeMs,
        format,
        probedAt: new Date(),
      },
      update: {
        ...baseData,
        width: result.width,
        height: result.height,
        videoCodec: result.videoCodec,
        videoRange,
        container,
        durationSecs: result.durationSecs,
        sizeBytes,
        mtimeMs,
        format,
        probedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Probe failed for "${relPath}": ${message}`);
    await prisma.scene.upsert({
      where: { filePath: relPath },
      create: { ...baseData, filePath: relPath, title, sortTitle: sortTitle(title) },
      update: baseData,
    });
  }
}

async function doScanScenes(runId: number, force: boolean): Promise<void> {
  const log: string[] = [];
  const adultPath = process.env.ADULT_PATH;
  if (!adultPath) throw new Error("ADULT_PATH is not set");

  const relPaths: string[] = [];
  await walk(adultPath, adultPath, 0, relPaths);

  const candidates: SceneCandidate[] = [];
  for (const relPath of relPaths) {
    const absPath = path.join(adultPath, relPath);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      log.push(`Could not stat "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const segments = relPath.split(path.sep);
    const folder = segments.length > 1 ? segments[0] : null;
    candidates.push({
      relPath,
      absPath,
      fileName: segments[segments.length - 1],
      folder,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  const total = candidates.length;
  await updateProgress(runId, { total, filesSeen: 0, progress: 0, message: `Found ${total} file(s)` });

  let completed = 0;
  async function reportProgress(message: string): Promise<void> {
    completed++;
    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, { progress: completed, filesSeen: completed, message });
    }
  }

  await mapPool(candidates, PROBE_CONCURRENCY, async (file) => {
    await processScene(file, log, force);
    await reportProgress(`Probed ${completed}/${total}: ${file.fileName}`);
  });

  // Delete Scene rows for files no longer on disk — Scene *is* the file
  // row (unlike Film/Show), so there's no separate "empty parent identity"
  // cleanup step needed.
  const seenPaths = new Set(candidates.map((c) => c.relPath));
  const allScenes = await prisma.scene.findMany({ select: { id: true, filePath: true } });
  const staleSceneIds = allScenes.filter((s) => !seenPaths.has(s.filePath)).map((s) => s.id);
  if (staleSceneIds.length > 0) {
    await prisma.scene.deleteMany({ where: { id: { in: staleSceneIds } } });
    log.push(`Removed ${staleSceneIds.length} scene(s) for files no longer on disk`);
  }

  await finishRun(runId, log, `Scanned ${total} file(s)`);
}

export type ScanMediaType = "FILM" | "TV" | "MUSIC" | "SCENE";

const SCAN_KIND: Record<ScanMediaType, RunKind> = {
  FILM: "SCAN_FILM",
  TV: "SCAN_TV",
  MUSIC: "SCAN_MUSIC",
  SCENE: "SCAN_SCENE",
};

const SCAN_RUNNER: Record<ScanMediaType, (runId: number, force: boolean) => Promise<void>> = {
  FILM: doScanFilms,
  TV: doScanTv,
  MUSIC: doScanMusic,
  SCENE: doScanScenes,
};

const SCAN_PATH_ENV: Record<ScanMediaType, string> = {
  FILM: "MOVIES_PATH",
  TV: "TVSHOWS_PATH",
  MUSIC: "MUSIC_PATH",
  SCENE: "ADULT_PATH",
};

/**
 * Kick off a scan of one media type. Resolves quickly once the run is
 * registered (or an existing run is found, or the run is failed immediately
 * for a missing library path) — the actual walk/probe/upsert work continues
 * in the background and is not awaited here.
 *
 * `force` ignores the size+mtime probe cache and re-probes every file even
 * when nothing on disk changed — used for a one-off re-probe after adding
 * new ffprobe-derived fields (e.g. audio profile, HDR range) so existing
 * rows pick up values that would otherwise stay null forever.
 */
export async function runScan(
  mediaType: ScanMediaType,
  options: { force?: boolean } = {},
): Promise<{ runId: number; started: boolean }> {
  const force = options.force ?? false;
  const { run, started } = await guardAndCreateRun(SCAN_KIND[mediaType]);
  if (!started) return { runId: run.id, started: false };

  if (!process.env[SCAN_PATH_ENV[mediaType]]) {
    await failRun(run.id, new Error(`${SCAN_PATH_ENV[mediaType]} is not set`));
    return { runId: run.id, started: true };
  }

  SCAN_RUNNER[mediaType](run.id, force).catch(async (err) => {
    console.error(`[scanner] ${mediaType} scan failed:`, err);
    await failRun(run.id, err).catch((e) => console.error("[scanner] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}
