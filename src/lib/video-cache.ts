// On-demand video preparation: resolves a Version (or Scene) to playable
// output, running an ffmpeg pass (remux and/or audio/video transcode, per
// video-playback.ts) exactly once per (file, variant) and caching the result
// under VIDEO_CACHE_DIR. A file that never needed preparing ("direct" tier)
// is served as a plain byte-range read of the original by the stream route.
//
// Prepared output is HLS (PLAYBACK_PLAN.md): one directory per cache key
// holding an *event* playlist, an fMP4 init segment, and ~6s media segments.
// A viewer's player fetches the playlist and segments as ordinary small HTTP
// GETs, so it can start within seconds of the first segment landing, seek
// anywhere already written while ffmpeg is still running, and survive a
// dropped connection by simply re-fetching a segment — none of which the
// previous single-file-streamed-while-written design could do. Once ffmpeg
// exits cleanly the app writes a `.complete` marker and the directory is
// the cache for every later play.
//
// Two variants per source: "original" (video copied where possible, best
// compatible audio) and "remote" (720p ~3 Mbps H.264 + stereo AAC, for links
// that can't carry a Blu-ray bitrate). Each is its own key and its own job.
//
// Same local-ffmpeg-vs-docker fallback as ffprobe.ts/audio-stream.ts.
//
// Scope: Film Versions and Adult Scenes — TV episodes (EpisodeFile) aren't
// wired up yet. Every process-local cache key below is namespaced by kind
// (`${kind}-${id}`), not a bare numeric id — Scene.id and Version.id are
// independent autoincrement sequences and *will* collide on the same number
// eventually; this was caught before it became a real bug, not after.

import { execFile, type ChildProcess } from "node:child_process";
import { promises as fs, rmSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe } from "@/lib/ffprobe";
import {
  planVideoPlayback,
  buildHlsFfmpegArgs,
  REMOTE_AUDIO_BITRATE,
  REMOTE_VIDEO_MAXRATE,
  type Variant,
  type VideoPlaybackPlan,
} from "@/lib/video-playback";

export type MediaKind = "film" | "scene";
export type { Variant } from "@/lib/video-playback";
export { parseVariant, VARIANTS } from "@/lib/video-playback";

// Playable states carry the probed duration: while a playlist is still
// being written Apple's native player reports duration = Infinity, and the
// player needs the real length to save progress and judge "completed".
export type VideoStatus =
  | { state: "not-found" }
  | { state: "direct"; durationSecs: number | null }
  | { state: "ready"; durationSecs: number | null }
  | { state: "preparing"; durationSecs: number | null }
  | { state: "idle"; durationSecs: number | null }
  | { state: "error"; message: string };

interface ResolvedMedia {
  id: number;
  filePath: string;
  videoCodec: string | null;
  container: string | null;
  durationSecs: number | null;
  audioTracks: {
    streamIdx: number;
    codec: string | null;
    profile: string | null;
    channels: number | null;
    title: string | null;
    isDefault: boolean;
    isDescriptive: boolean;
  }[];
}

export const PLAYLIST_NAME = "index.m3u8";
const COMPLETE_MARKER = ".complete";
/** The only files a segment request may name: the init segment and
 *  zero-padded media segments. No path separators, no dots beyond the
 *  extension — the route validates against this before touching disk. */
export const HLS_FILE_RE = /^(init\.mp4|seg_\d{5}\.m4s)$/;
/** Shape of a cache-directory name, so unrelated files in the cache dir are
 *  never mistaken for entries (and legacy single-file `*.mp4` output from
 *  the pre-HLS layout is swept as unknown). */
const CACHE_KEY_RE = /^(film|scene)-\d+(-remote)?$/;

function cacheKey(kind: MediaKind, id: number, variant: Variant): string {
  return variant === "original" ? `${kind}-${id}` : `${kind}-${id}-${variant}`;
}

function cacheDir(): string {
  return path.resolve(process.env.VIDEO_CACHE_DIR || "./data/video-cache");
}

function entryDir(key: string): string {
  return path.join(cacheDir(), key);
}

const DEFAULT_MAX_CACHE_BYTES = 10 * 1024 ** 3; // 10 GiB -- this runs on a small, shared VM.

export function maxCacheBytes(): number {
  const raw = Number(process.env.VIDEO_CACHE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CACHE_BYTES;
}

// Headroom the disk must keep AFTER a prepare would finish. A prepare that
// would leave less than this is refused with a clear error rather than
// filling the volume that also holds the SQLite database.
const MIN_FREE_DISK_BYTES = 1 * 1024 ** 3;

export interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  /** A live write (or the incoming entry being budgeted for): counts toward
   *  the total, is never a candidate for eviction. */
  pinned?: boolean;
}

/** Pure decision: given the cache's current contents and a byte budget, which
 * entries to delete (oldest-last-played first) to get back under budget. No
 * I/O here so this is cheap to test exhaustively -- see enforceCacheLimit /
 * makeRoomFor for the readdir/stat/rm side. Pinned entries (in-progress
 * writes, the entry that was just produced, the one about to be) count
 * toward the total but are never evicted, so the result can fall short of
 * the budget when a single pinned entry is bigger than it -- that's allowed
 * (see prepare): the cap bounds what's *retained*, not what can be
 * produced. */
export function selectEntriesToEvict(entries: CacheEntry[], limitBytes: number): string[] {
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= limitBytes) return [];

  const candidates = entries.filter((e) => !e.pinned).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toEvict: string[] = [];
  let remaining = total;
  for (const entry of candidates) {
    if (remaining <= limitBytes) break;
    toEvict.push(entry.path);
    remaining -= entry.size;
  }
  return toEvict;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const s = await fs.stat(path.join(dir, name)).catch(() => null);
    if (s?.isFile()) total += s.size;
  }
  return total;
}

async function isComplete(dir: string): Promise<boolean> {
  return fileExists(path.join(dir, COMPLETE_MARKER));
}

/** Cache directory listing: one entry per key directory, sized as the sum
 * of its files. An in-progress directory (no `.complete` yet) is pinned --
 * an in-flight remux of a Blu-ray can be tens of GB, and an earlier version
 * of this accounting ignored in-flight output entirely, which is exactly
 * how the disk filled. Orphans (in-progress but no live job) are swept
 * before any budgeting, so a pinned entry here is always a real write. */
async function readCacheEntries(): Promise<CacheEntry[]> {
  const root = cacheDir();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const entries: CacheEntry[] = [];
  for (const name of names) {
    if (!CACHE_KEY_RE.test(name)) continue;
    const dir = path.join(root, name);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    entries.push({
      path: dir,
      size: await dirSize(dir),
      mtimeMs: stat.mtimeMs,
      pinned: !(await isComplete(dir)),
    });
  }
  return entries;
}

/** mtime of the entry directory is the LRU clock (atime isn't reliable on
 * noatime/relatime mounts) -- touchEntry keeps it current on every play.
 * `protect` is the directory that was just produced: never evicted by the
 * pass that follows its own creation, even if it alone exceeds the cap
 * (otherwise a big remux would be deleted the moment it finished and
 * re-prepared on every play). It becomes an ordinary LRU candidate the next
 * time something else needs the room. */
async function enforceCacheLimit(protect?: string): Promise<void> {
  const entries = (await readCacheEntries()).map((e) => (e.path === protect ? { ...e, pinned: true } : e));
  for (const p of selectEntriesToEvict(entries, maxCacheBytes())) {
    await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  }
}

/** Before a prepare starts: evict least-recently-played entries until the
 * incoming output (estimated at `bytes`) fits the cap, then refuse outright
 * if the *disk* still can't hold it with headroom to spare. The cap is a
 * retention policy; the free-space check is the actual safety net. */
async function makeRoomFor(bytes: number): Promise<void> {
  const entries = await readCacheEntries();
  const incoming: CacheEntry = { path: "<incoming>", size: bytes, mtimeMs: Number.POSITIVE_INFINITY, pinned: true };
  for (const p of selectEntriesToEvict([...entries, incoming], maxCacheBytes())) {
    await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  }

  const free = await freeDiskBytes(cacheDir());
  if (free !== null && free - bytes < MIN_FREE_DISK_BYTES) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new Error(
      `Not enough disk space to prepare this file: it needs about ${gb(bytes)} GB and the cache volume has ${gb(free)} GB free.`,
    );
  }
}

async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Output-size bound used for budgeting. Original: every plan this app
 * produces is at most the source (stream copies are byte-for-byte; the only
 * encodes are DVD-era video to x264 and lossless audio to AAC, both
 * smaller). Remote: a fixed-ceiling encode, so duration × ceiling when the
 * duration is known, else a conservative fraction of the source. */
export function estimateOutputBytes(sourceBytes: number, durationSecs: number | null, variant: Variant): number {
  if (variant === "original") return sourceBytes;
  const videoBps = Number.parseFloat(REMOTE_VIDEO_MAXRATE) * 1_000_000;
  const audioBps = Number.parseFloat(REMOTE_AUDIO_BITRATE) * 1_000;
  if (durationSecs && durationSecs > 0) {
    return Math.min(sourceBytes, Math.ceil((durationSecs * (videoBps + audioBps) * 1.2) / 8));
  }
  return Math.ceil(sourceBytes / 4);
}

/** Delete cache entries nobody in this process is writing. Every writer is
 * an in-process ffmpeg job, so on a fresh process *every* incomplete entry
 * is an orphan -- left behind by a deploy or crash that killed ffmpeg
 * mid-write. Anything that isn't a key directory at all (the pre-HLS
 * layout's `<key>.mp4` / `.partial` files, or stray files) is unknown to
 * this layout and removed too: the cache is a derivative, never data.
 * Exported with the directory and liveness check injected so it can be
 * tested against a temp dir. */
export async function sweepOrphanedEntriesIn(root: string, isLive: (key: string) => boolean): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const p = path.join(root, name);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory() && CACHE_KEY_RE.test(name)) {
      if (await isComplete(p)) continue;
      if (isLive(name)) continue;
    }
    await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    removed.push(p);
  }
  return removed;
}

let startupSweep: Promise<void> | null = null;
/** Runs once per process, lazily on the first playback-related call (there
 * is no server-start hook this module can rely on in both dev and prod).
 * Idempotent and cheap after the first call. */
function ensureStartupSweep(): Promise<void> {
  if (!startupSweep) {
    startupSweep = sweepOrphanedEntriesIn(cacheDir(), (key) => jobs.has(key))
      .then(() => undefined)
      .catch(() => undefined);
  }
  return startupSweep;
}

/** Marks an entry as just-played, so it looks recently-used to the LRU
 * eviction above even on a filesystem that doesn't track real atime.
 * Best-effort -- a failure here should never break playback. */
function touchEntry(dir: string): void {
  const now = new Date();
  fs.utimes(dir, now, now).catch(() => {});
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-flight prepare jobs (keyed by cacheKey) and the last error for one that
// failed, so status polling can see it. Both are process-local — fine for a
// single-instance deployment. Because every writer is in-process, "an
// incomplete entry exists but `jobs` has no entry for it" is a reliable
// orphan signal: the process that was writing it is gone. That's swept on
// the first playback call after startup (ensureStartupSweep) and again
// per-key whenever status/playlist sees it, and the shutdown hook below
// tries not to leave any behind in the first place.
const jobs = new Map<string, Promise<void>>();
const jobErrors = new Map<string, string>();
// The directory each live job is writing, so a shutdown can remove them
// synchronously without re-deriving paths.
const activeDirs = new Map<string, string>();

// Viewer-presence signal for a running job: every playlist or segment
// request for a key counts as activity, and a job with no activity for
// IDLE_CANCEL_MS is stopped rather than left encoding for no one. Ten
// minutes rather than the old 8s: a paused player, a Wi-Fi blip over a VPN,
// or a phone locked for a minute must not throw the work away (a restart
// means the whole file again from byte 0), while a viewer who genuinely
// left still stops a two-hour transcode long before it finishes.
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const IDLE_CANCEL_MS = 10 * 60_000;
// When a viewer says they've left (VideoPlayer's leave beacon on close,
// navigation or a quality switch), the wait shrinks to this: long enough
// for anyone else watching the same title to make a segment request and
// re-arm the full window, short enough that a deliberate close doesn't
// leave a transcode running for ten minutes for nobody.
const LEAVE_CANCEL_MS = 30_000;

function armIdleTimer(key: string, ms: number): void {
  const pending = idleTimers.get(key);
  if (pending) clearTimeout(pending);
  idleTimers.set(
    key,
    setTimeout(() => {
      idleTimers.delete(key);
      const proc = activeProcesses.get(key);
      if (!proc) return;
      cancelledJobs.add(key);
      proc.kill("SIGTERM");
    }, ms),
  );
}

function noteActivity(key: string): void {
  if (!jobs.has(key)) return;
  armIdleTimer(key, IDLE_CANCEL_MS);
}

/** POST /leave hits this: a viewer closed the player for this key. If a
 * job is running, its idle window drops to LEAVE_CANCEL_MS; any later
 * activity (someone else's segment request) restores the full window.
 * Returns whether there was a job to shorten. */
export function noteViewerLeft(kind: MediaKind, id: number, variant: Variant): boolean {
  const key = cacheKey(kind, id, variant);
  if (!jobs.has(key)) return false;
  armIdleTimer(key, LEAVE_CANCEL_MS);
  return true;
}

function clearIdleTimer(key: string): void {
  const pending = idleTimers.get(key);
  if (pending) clearTimeout(pending);
  idleTimers.delete(key);
}

async function loadVersion(versionId: number): Promise<ResolvedMedia | null> {
  const version = await prisma.version.findUnique({
    where: { id: versionId },
    include: { audioTracks: true, film: { select: { owned: true } } },
  });
  if (!version || !version.film?.owned) return null;
  return {
    id: version.id,
    filePath: version.filePath,
    videoCodec: version.videoCodec,
    container: version.container,
    durationSecs: version.durationSecs,
    audioTracks: version.audioTracks,
  };
}

/** Scene has no per-track table the way Version/AudioTrack does (out of
 * scope — see ADULT_PLAN.md) — probe the file fresh instead of reading
 * stored rows. Fine: this runs once per play (prepare/status check), not
 * per segment, and ffprobe against a local/SMB file is fast. */
async function loadScene(sceneId: number): Promise<ResolvedMedia | null> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) return null;

  const adultPath = process.env.ADULT_PATH;
  if (!adultPath) return null;
  const absPath = resolveSourcePath("scene", scene.filePath);
  if (!absPath) return null;

  try {
    const result = await probe(absPath);
    return {
      id: scene.id,
      filePath: scene.filePath,
      videoCodec: result.videoCodec,
      container: scene.container,
      durationSecs: scene.durationSecs,
      audioTracks: result.audioTracks,
    };
  } catch {
    return null;
  }
}

async function loadMedia(kind: MediaKind, id: number): Promise<ResolvedMedia | null> {
  return kind === "film" ? loadVersion(id) : loadScene(id);
}

function mediaRootEnv(kind: MediaKind): string {
  return kind === "film" ? "MOVIES_PATH" : "ADULT_PATH";
}

function resolveSourcePath(kind: MediaKind, filePath: string): string | null {
  const mediaRoot = process.env[mediaRootEnv(kind)];
  if (!mediaRoot) return null;
  const root = path.resolve(mediaRoot);
  const absPath = path.resolve(root, filePath);
  // Path-traversal guard, same shape as /api/audio and /api/cover.
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;
  return absPath;
}

let hasLocalFfmpegPromise: Promise<boolean> | null = null;
function detectLocalFfmpeg(): Promise<boolean> {
  if (!hasLocalFfmpegPromise) {
    hasLocalFfmpegPromise = new Promise<boolean>((resolve) => {
      execFile("ffmpeg", ["-version"], (err) => resolve(!err));
    });
  }
  return hasLocalFfmpegPromise;
}

// The running ffmpeg (or docker-run wrapping it) child process per key, so an
// abandoned play (see noteActivity) has something to kill.
const activeProcesses = new Map<string, ChildProcess>();
// Set just before killing a process for cancellation, so its exit looks like
// a deliberate stop rather than a real failure -- see runTrackedProcess.
const cancelledJobs = new Set<string>();

class PrepareCancelledError extends Error {}

// On SIGTERM/SIGINT (a `docker stop`, a deploy, Ctrl-C in dev): stop every
// running ffmpeg and remove the directory it was writing, synchronously --
// there is no time for the async cleanup in prepare() to run before the
// process exits. Prepended so it runs before Next's own handler, which may
// call process.exit in the same tick. The startup sweep is the backstop for
// a SIGKILL, which no handler can catch.
let shutdownHookInstalled = false;
function installShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  const stopAll = () => {
    for (const [key, proc] of activeProcesses) {
      cancelledJobs.add(key);
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
    for (const dir of activeDirs.values()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort; the startup sweep catches anything left.
      }
    }
  };
  process.prependListener("SIGTERM", stopAll);
  process.prependListener("SIGINT", stopAll);
}

function runTrackedProcess(key: string, cmd: string, args: string[]): Promise<void> {
  installShutdownHook();
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 16 }, (err, _stdout, stderr) => {
      activeProcesses.delete(key);
      if (err) {
        if (cancelledJobs.delete(key)) {
          reject(new PrepareCancelledError("stopped -- no active viewers"));
        } else {
          // execFile's own message is "Command failed: <entire argv>" plus
          // everything ffmpeg printed. With -loglevel error (see
          // buildHlsFfmpegArgs) stderr is just the actual problem, so
          // surface that -- it's what ends up in the player's error message.
          const detail = String(stderr ?? "").trim().split("\n").filter(Boolean).slice(-3).join(" ");
          reject(new Error(detail ? `ffmpeg failed: ${detail}` : err.message));
        }
        return;
      }
      resolve();
    });
    activeProcesses.set(key, child);
  });
}

async function runFfmpeg(
  kind: MediaKind,
  sourceAbsPath: string,
  outDir: string,
  plan: VideoPlaybackPlan,
  sourceChannels: number | null,
  variant: Variant,
  key: string,
): Promise<void> {
  const hasLocal = await detectLocalFfmpeg();

  if (hasLocal) {
    await runTrackedProcess(key, "ffmpeg", buildHlsFfmpegArgs(sourceAbsPath, outDir, plan, sourceChannels, variant));
    return;
  }

  const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
  if (!dockerImage) throw new Error("ffmpeg not found on PATH and FFPROBE_DOCKER_IMAGE is not set");

  const mediaRoot = process.env[mediaRootEnv(kind)];
  if (!mediaRoot) throw new Error(`${mediaRootEnv(kind)} not set`);
  const root = path.resolve(mediaRoot);
  const rel = path.relative(root, sourceAbsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`source path outside ${mediaRootEnv(kind)}`);
  const containerIn = `/media-root/${rel.split(path.sep).join("/")}`;

  const args = buildHlsFfmpegArgs(containerIn, "/out", plan, sourceChannels, variant);
  await runTrackedProcess(key, "docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/ffmpeg",
    "-v",
    `${root}:/media-root:ro`,
    "-v",
    `${outDir}:/out`,
    dockerImage,
    ...args,
  ]);
}

async function prepare(
  kind: MediaKind,
  id: number,
  variant: Variant,
  media: ResolvedMedia,
  plan: VideoPlaybackPlan,
): Promise<void> {
  const key = cacheKey(kind, id, variant);
  const sourceAbsPath = resolveSourcePath(kind, media.filePath);
  if (!sourceAbsPath) throw new Error(`${mediaRootEnv(kind)} not set or file path outside its root`);
  const sourceStat = await fs.stat(sourceAbsPath); // throws if the file's missing on disk

  const dir = entryDir(key);
  // A leftover from a killed/interrupted previous run could still be here —
  // start clean rather than have a player see a mix of old and new segments.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true });

  await makeRoomFor(estimateOutputBytes(sourceStat.size, media.durationSecs, variant));

  const sourceChannels =
    plan.audioStreamIndex !== null
      ? (media.audioTracks.find((t) => t.streamIdx === plan.audioStreamIndex)?.channels ?? null)
      : null;

  activeDirs.set(key, dir);
  noteActivity(key);
  try {
    await runFfmpeg(kind, sourceAbsPath, dir, plan, sourceChannels, variant, key);
    await fs.writeFile(path.join(dir, COMPLETE_MARKER), "");
    await enforceCacheLimit(dir);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    // A deliberate stop (no one was still watching) isn't a failure -- don't
    // record it as a jobError, just leave things clean for the next play to
    // start fresh. See noteActivity.
    if (err instanceof PrepareCancelledError) return;
    throw err;
  } finally {
    activeDirs.delete(key);
    clearIdleTimer(key);
  }
}

/** Kick off preparation if it isn't already cached or in flight. Fire-and-
 * forget — callers poll getVideoStatus or resolve the playlist. */
function requestVideoPrepare(
  kind: MediaKind,
  id: number,
  variant: Variant,
  media: ResolvedMedia,
  plan: VideoPlaybackPlan,
): void {
  const key = cacheKey(kind, id, variant);
  if (jobs.has(key)) return;
  jobErrors.delete(key);
  const job = prepare(kind, id, variant, media, plan)
    .catch((err) => {
      jobErrors.set(key, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      jobs.delete(key);
    });
  jobs.set(key, job);
}

async function loadAndPlan(kind: MediaKind, id: number): Promise<{ media: ResolvedMedia; plan: VideoPlaybackPlan } | null> {
  const media = await loadMedia(kind, id);
  if (!media) return null;
  const plan = planVideoPlayback(media); // null if not probed yet
  if (!plan) return null;
  return { media, plan };
}

/** An incomplete entry with no job writing it is an orphan (see the `jobs`
 * comment). Removing it here -- rather than reporting "preparing" for
 * output nobody is producing -- is what used to leave a film stuck on
 * "Buffering…" forever after any restart mid-prepare. */
async function discardOrphanedEntry(key: string): Promise<void> {
  if (jobs.has(key)) return;
  const dir = entryDir(key);
  if (await isComplete(dir)) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function getVideoStatus(kind: MediaKind, id: number, variant: Variant): Promise<VideoStatus> {
  await ensureStartupSweep();
  const loaded = await loadAndPlan(kind, id);
  if (!loaded) return { state: "not-found" };
  const { media, plan } = loaded;
  const key = cacheKey(kind, id, variant);

  // "direct" is a property of the source, not a variant: a remote rendition
  // of a direct-playable file is still a prepare.
  const durationSecs = media.durationSecs;
  if (plan.tier === "direct" && variant === "original") {
    const sourceAbsPath = resolveSourcePath(kind, media.filePath);
    if (!sourceAbsPath || !(await fileExists(sourceAbsPath))) return { state: "not-found" };
    return { state: "direct", durationSecs };
  }

  if (await isComplete(entryDir(key))) return { state: "ready", durationSecs };
  if (jobs.has(key)) return { state: "preparing", durationSecs };
  await discardOrphanedEntry(key);
  const error = jobErrors.get(key);
  if (error) return { state: "error", message: error };
  return { state: "idle", durationSecs };
}

/** POST /prepare hits this: starts the job (if needed) and returns the
 * status the client should now poll on. Optional pre-warming — the playlist
 * route is self-starting, so nothing *needs* this called first. */
export async function triggerVideoPrepare(kind: MediaKind, id: number, variant: Variant): Promise<VideoStatus> {
  await ensureStartupSweep();
  const loaded = await loadAndPlan(kind, id);
  if (!loaded) return { state: "not-found" };
  const { media, plan } = loaded;
  const key = cacheKey(kind, id, variant);

  if (plan.tier === "direct" && variant === "original") return getVideoStatus(kind, id, variant);
  if (await isComplete(entryDir(key))) return { state: "ready", durationSecs: media.durationSecs };

  await discardOrphanedEntry(key);
  requestVideoPrepare(kind, id, variant, media, plan);
  return { state: "preparing", durationSecs: media.durationSecs };
}

export type VideoStreamResolution =
  | { kind: "not-found" }
  | { kind: "needs-prepare" }
  | { kind: "complete"; absPath: string; contentType: string };

/** What GET /stream should serve: the original file for a direct-playable
 * source, or a pointer at the HLS playlist for anything else. */
export async function resolveVideoStream(kind: MediaKind, id: number): Promise<VideoStreamResolution> {
  await ensureStartupSweep();
  const loaded = await loadAndPlan(kind, id);
  if (!loaded) return { kind: "not-found" };
  const { media, plan } = loaded;
  if (plan.tier !== "direct") return { kind: "needs-prepare" };
  const sourceAbsPath = resolveSourcePath(kind, media.filePath);
  if (!sourceAbsPath || !(await fileExists(sourceAbsPath))) return { kind: "not-found" };
  return { kind: "complete", absPath: sourceAbsPath, contentType: "video/mp4" };
}

export type PlaylistResolution =
  | { kind: "not-found" }
  | { kind: "direct" }
  | { kind: "error"; message: string }
  | { kind: "not-started" }
  | { kind: "ready"; absPath: string; complete: boolean };

const START_POLL_INTERVAL_MS = 250;
// How long the playlist request will wait for the first segment to land.
// A remux writes its first 6s segment almost instantly; a 720p transcode of
// a 1080p source on the VM takes a few seconds of wall time per segment.
const START_POLL_MAX_MS = 30_000;

async function playlistHasSegment(playlistPath: string): Promise<boolean> {
  try {
    const text = await fs.readFile(playlistPath, "utf8");
    return text.includes("#EXTINF");
  } catch {
    return false;
  }
}

/**
 * What GET hls/<variant>/index.m3u8 should serve. Self-starting: if nothing
 * has been prepared or requested yet, this kicks off the job itself and
 * waits (bounded) for the first segment to land, so a player gets a
 * playable playlist on its first request rather than an empty one.
 */
export async function resolveHlsPlaylist(kind: MediaKind, id: number, variant: Variant): Promise<PlaylistResolution> {
  await ensureStartupSweep();
  const loaded = await loadAndPlan(kind, id);
  if (!loaded) return { kind: "not-found" };
  const { media, plan } = loaded;
  const key = cacheKey(kind, id, variant);
  const dir = entryDir(key);
  const playlistPath = path.join(dir, PLAYLIST_NAME);

  if (plan.tier === "direct" && variant === "original") return { kind: "direct" };

  if (await isComplete(dir)) {
    touchEntry(dir);
    return { kind: "ready", absPath: playlistPath, complete: true };
  }

  if (!jobs.has(key)) {
    await discardOrphanedEntry(key);
    requestVideoPrepare(kind, id, variant, media, plan);
  }
  noteActivity(key);

  const deadline = Date.now() + START_POLL_MAX_MS;
  while (Date.now() < deadline) {
    if (await isComplete(dir)) return { kind: "ready", absPath: playlistPath, complete: true };
    if (await playlistHasSegment(playlistPath)) return { kind: "ready", absPath: playlistPath, complete: false };
    const error = jobErrors.get(key);
    if (error) return { kind: "error", message: error };
    if (!jobs.has(key)) return { kind: "error", message: "preparation stopped before the first segment was written" };
    await sleep(START_POLL_INTERVAL_MS);
  }
  return { kind: "not-started" };
}

/** What GET hls/<variant>/<file> should serve: the init segment or one
 * media segment, or null if the name isn't a segment name or it doesn't
 * exist (yet). Cheap by design — no DB, no plan: the key is built from
 * validated integers and the variant enum, and the name is whitelisted, so
 * nothing here can reach outside the entry directory. Authorization is the
 * route's (proxy session + the adult gate for scenes). */
export async function resolveHlsFile(
  kind: MediaKind,
  id: number,
  variant: Variant,
  name: string,
): Promise<{ absPath: string; contentType: string } | null> {
  if (!HLS_FILE_RE.test(name)) return null;
  const key = cacheKey(kind, id, variant);
  const absPath = path.join(entryDir(key), name);
  if (!(await fileExists(absPath))) return null;
  noteActivity(key);
  return { absPath, contentType: name.endsWith(".mp4") ? "video/mp4" : "video/iso.segment" };
}
