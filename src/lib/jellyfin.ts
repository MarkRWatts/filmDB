// Jellyfin integration: match the same movie share indexed by MediaVault
// against the Jellyfin server's library items so film detail pages can link
// straight into playback. Degrades gracefully with no
// JELLYFIN_URL/JELLYFIN_API_KEY.
//
// Path matching gotcha: Jellyfin (running on Linux) reports NFC-normalized
// Unicode paths; some of MediaVault's Version.filePath values came from a macOS
// scan and are NFD-normalized (e.g. "Léon" as "e" + combining acute accent).
// Both sides MUST be run through String.prototype.normalize("NFC") before
// comparison, or accented filenames silently fail to match.

import { prisma } from "@/lib/db";
import { guardAndCreateRun, updateProgress, finishRun, failRun } from "@/lib/runs";

const DEFAULT_MOVIES_PREFIX = "/media/Movies/";
const DEFAULT_TV_PREFIX = "/media/TV Shows/";
const DEFAULT_ADULT_PREFIX = "/media/Adult/";
const PROGRESS_UPDATE_EVERY = 25;

interface MediaFolder {
  Id: string;
  Name: string;
  CollectionType?: string;
}

interface JellyfinItem {
  Id: string;
  Name: string;
  Path?: string;
}

export function jellyfinConfigured(): boolean {
  return Boolean(process.env.JELLYFIN_URL && process.env.JELLYFIN_API_KEY);
}

function baseUrl(): string {
  const url = process.env.JELLYFIN_URL;
  if (!url) throw new Error("JELLYFIN_URL not set");
  return url.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const key = process.env.JELLYFIN_API_KEY;
  if (!key) throw new Error("JELLYFIN_API_KEY not set");
  return { Authorization: `MediaBrowser Token="${key}"` };
}

/** For src/lib/jellyfin-playback.ts, which talks to the same server. */
export function jellyfinBaseUrl(): string {
  return baseUrl();
}
export function jellyfinApiKey(): string {
  const key = process.env.JELLYFIN_API_KEY;
  if (!key) throw new Error("JELLYFIN_API_KEY not set");
  return key;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jellyfinFetch(pathname: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${baseUrl()}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Jellyfin ${pathname} -> HTTP ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

// Generic authenticated request, method/body-flexible unlike jellyfinFetch
// above (GET-only, query-params-only — sufficient for the library-sync job
// it was written for). Added for syncJellyfinAdultAccess's User/Policy
// read-modify-write below, which needs POST-with-JSON-body.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jellyfinRequest(method: string, pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(`${baseUrl()}${pathname}`, {
    method,
    headers: { ...authHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Jellyfin ${method} ${pathname} -> HTTP ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

async function getMoviesLibraryId(): Promise<string> {
  const data = await jellyfinFetch("/Library/MediaFolders");
  const folders: MediaFolder[] = data.Items ?? [];
  const movies = folders.find((f) => f.CollectionType === "movies");
  if (!movies) throw new Error('No Jellyfin library with CollectionType "movies" found');
  return movies.Id;
}

async function getAllMovieItems(parentId: string): Promise<JellyfinItem[]> {
  const data = await jellyfinFetch("/Items", {
    ParentId: parentId,
    IncludeItemTypes: "Movie",
    Recursive: "true",
    Fields: "Path,ProviderIds",
  });
  return data.Items ?? [];
}

/** Returns null (rather than throwing) when no "tvshows" library exists —
 * TV matching is best-effort and shouldn't fail the whole sync when a
 * server has no TV library configured. */
async function getTvLibraryId(): Promise<string | null> {
  const data = await jellyfinFetch("/Library/MediaFolders");
  const folders: MediaFolder[] = data.Items ?? [];
  const tv = folders.find((f) => f.CollectionType === "tvshows");
  return tv ? tv.Id : null;
}

async function getAllEpisodeItems(parentId: string): Promise<JellyfinItem[]> {
  const data = await jellyfinFetch("/Items", {
    ParentId: parentId,
    IncludeItemTypes: "Episode",
    Recursive: "true",
    Fields: "Path",
  });
  return data.Items ?? [];
}

/** The Adult library is a plain "homevideos" collection (no CollectionType
 * to discover it by, hence ADULT_JELLYFIN_FOLDER_ID being a manual paste —
 * see syncJellyfinAdultAccess's comment) whose items come back as type
 * "Video", not "Movie"/"Episode" — confirmed against the real library. */
async function getAllSceneItems(parentId: string): Promise<JellyfinItem[]> {
  const data = await jellyfinFetch("/Items", {
    ParentId: parentId,
    IncludeItemTypes: "Video",
    Recursive: "true",
    Fields: "Path",
  });
  return data.Items ?? [];
}

/** Fire the library refresh and return immediately — we don't wait for the
 * (potentially slow) scan to finish; the item list fetched right after may
 * be very slightly stale, which is an acceptable tradeoff here. */
async function triggerLibraryRefresh(log: string[]): Promise<void> {
  try {
    await fetch(`${baseUrl()}/Library/Refresh`, { method: "POST", headers: authHeaders() });
    log.push("Triggered Jellyfin library refresh (not waiting for completion — item list may be slightly stale)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Failed to trigger Jellyfin library refresh: ${message}`);
  }
}

/** Strip everything through the configured movies prefix, leaving the path
 * relative to MOVIES_PATH the same way Version.filePath is stored. */
function relativizePath(jellyfinPath: string): string | null {
  const prefix = process.env.JELLYFIN_MOVIES_PREFIX || DEFAULT_MOVIES_PREFIX;
  const idx = jellyfinPath.indexOf(prefix);
  if (idx === -1) return null;
  return jellyfinPath.slice(idx + prefix.length);
}

/** Same idea as relativizePath, for the TV share (JELLYFIN_TV_PREFIX, falling
 * back to DEFAULT_TV_PREFIX — an empty-string env var also falls back, via
 * `||`, same as the movies prefix). */
function relativizeTvPath(jellyfinPath: string): string | null {
  const prefix = process.env.JELLYFIN_TV_PREFIX || DEFAULT_TV_PREFIX;
  const idx = jellyfinPath.indexOf(prefix);
  if (idx === -1) return null;
  return jellyfinPath.slice(idx + prefix.length);
}

/** Same idea, for the Adult share (JELLYFIN_ADULT_PREFIX, falling back to
 * DEFAULT_ADULT_PREFIX). */
function relativizeAdultPath(jellyfinPath: string): string | null {
  const prefix = process.env.JELLYFIN_ADULT_PREFIX || DEFAULT_ADULT_PREFIX;
  const idx = jellyfinPath.indexOf(prefix);
  if (idx === -1) return null;
  return jellyfinPath.slice(idx + prefix.length);
}

async function doJellyfinSync(runId: number): Promise<void> {
  const log: string[] = [];

  await triggerLibraryRefresh(log);

  const parentId = await getMoviesLibraryId();
  const items = await getAllMovieItems(parentId);

  // TV matching is best-effort — a server with no "tvshows" library (or one
  // that errors) shouldn't fail the whole sync; movies still get matched.
  let tvItems: JellyfinItem[] = [];
  try {
    const tvParentId = await getTvLibraryId();
    if (tvParentId) {
      tvItems = await getAllEpisodeItems(tvParentId);
    } else {
      log.push('No Jellyfin library with CollectionType "tvshows" found — skipping TV match');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`Failed to fetch Jellyfin TV items: ${message}`);
  }

  const total = items.length + tvItems.length;
  await updateProgress(runId, {
    total,
    filesSeen: 0,
    progress: 0,
    message: `Matching ${items.length} movie item(s), ${tvItems.length} TV item(s)`,
  });

  const versions = await prisma.version.findMany({ select: { id: true, filePath: true, jellyfinId: true } });
  const versionByNormPath = new Map(versions.map((v) => [v.filePath.normalize("NFC"), v]));
  const matchedVersionIds = new Set<number>();

  let matched = 0;
  const unmatchedInJellyfin: string[] = [];
  let completed = 0;

  for (const item of items) {
    completed++;
    if (item.Path) {
      const relPath = relativizePath(item.Path);
      const normPath = relPath?.normalize("NFC");
      const version = normPath ? versionByNormPath.get(normPath) : undefined;
      if (version) {
        if (version.jellyfinId !== item.Id) {
          await prisma.version.update({ where: { id: version.id }, data: { jellyfinId: item.Id } });
        }
        matchedVersionIds.add(version.id);
        matched++;
      } else {
        unmatchedInJellyfin.push(item.Name ?? item.Path);
      }
    } else {
      unmatchedInJellyfin.push(item.Name ?? `(item ${item.Id})`);
    }

    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, { progress: completed, filesSeen: completed, message: `Matched ${matched}/${completed}` });
    }
  }

  // Any version we didn't match this run: unmatched-in-MediaVault, and clear a
  // stale jellyfinId if it had one from a previous sync.
  const unmatchedInMediaVault: string[] = [];
  for (const v of versions) {
    if (matchedVersionIds.has(v.id)) continue;
    unmatchedInMediaVault.push(v.filePath);
    if (v.jellyfinId !== null) {
      await prisma.version.update({ where: { id: v.id }, data: { jellyfinId: null } });
    }
  }

  log.push(`Matched ${matched} of ${versions.length} MediaVault versions to Jellyfin items`);
  if (unmatchedInMediaVault.length > 0) {
    log.push(`Unmatched in MediaVault (${unmatchedInMediaVault.length}): ${unmatchedInMediaVault.join(", ")}`);
  }
  if (unmatchedInJellyfin.length > 0) {
    log.push(`Unmatched in Jellyfin (${unmatchedInJellyfin.length}): ${unmatchedInJellyfin.join(", ")}`);
  }

  // ---- TV ----
  // EpisodeFile.filePath is NOT unique (a multi-episode range file shares
  // one filePath across several rows) — group by normalized path and keep
  // every row sharing a filePath in sync with the same jellyfinId.
  const episodeFiles = await prisma.episodeFile.findMany({ select: { id: true, filePath: true, jellyfinId: true } });
  const episodeFilesByNormPath = new Map<string, typeof episodeFiles>();
  for (const ef of episodeFiles) {
    const norm = ef.filePath.normalize("NFC");
    const arr = episodeFilesByNormPath.get(norm);
    if (arr) arr.push(ef);
    else episodeFilesByNormPath.set(norm, [ef]);
  }

  let tvMatched = 0;
  const matchedTvNormPaths = new Set<string>();
  const unmatchedInJellyfinTv: string[] = [];

  for (const item of tvItems) {
    completed++;
    if (item.Path) {
      const relPath = relativizeTvPath(item.Path);
      const normPath = relPath?.normalize("NFC");
      const rows = normPath ? episodeFilesByNormPath.get(normPath) : undefined;
      if (rows && rows.length > 0) {
        for (const row of rows) {
          if (row.jellyfinId !== item.Id) {
            await prisma.episodeFile.update({ where: { id: row.id }, data: { jellyfinId: item.Id } });
          }
        }
        matchedTvNormPaths.add(normPath!);
        tvMatched++;
      } else {
        unmatchedInJellyfinTv.push(item.Name ?? item.Path);
      }
    } else {
      unmatchedInJellyfinTv.push(item.Name ?? `(item ${item.Id})`);
    }

    if (completed % PROGRESS_UPDATE_EVERY === 0 || completed === total) {
      await updateProgress(runId, {
        progress: completed,
        filesSeen: completed,
        message: `Matched ${matched + tvMatched}/${completed}`,
      });
    }
  }

  // Any filePath we didn't match this run: unmatched-in-MediaVault, and clear a
  // stale jellyfinId on every row sharing it.
  const unmatchedInMediaVaultTv: string[] = [];
  for (const [normPath, rows] of episodeFilesByNormPath) {
    if (matchedTvNormPaths.has(normPath)) continue;
    unmatchedInMediaVaultTv.push(rows[0].filePath);
    for (const row of rows) {
      if (row.jellyfinId !== null) {
        await prisma.episodeFile.update({ where: { id: row.id }, data: { jellyfinId: null } });
      }
    }
  }

  log.push(`Matched ${tvMatched} of ${episodeFilesByNormPath.size} MediaVault TV file(s) to Jellyfin items`);
  if (unmatchedInMediaVaultTv.length > 0) {
    log.push(`Unmatched TV in MediaVault (${unmatchedInMediaVaultTv.length}): ${unmatchedInMediaVaultTv.join(", ")}`);
  }
  if (unmatchedInJellyfinTv.length > 0) {
    log.push(`Unmatched TV in Jellyfin (${unmatchedInJellyfinTv.length}): ${unmatchedInJellyfinTv.join(", ")}`);
  }

  // ---- Adult ----
  // Best-effort, same posture as TV: no ADULT_JELLYFIN_FOLDER_ID (Adult
  // feature not configured) shouldn't fail the rest of the sync. Unlike
  // movies/TV there's no CollectionType to discover the library by, so this
  // reuses the same folder id syncJellyfinAdultAccess already needs.
  let sceneItems: JellyfinItem[] = [];
  const adultFolderId = process.env.ADULT_JELLYFIN_FOLDER_ID;
  if (adultFolderId) {
    try {
      sceneItems = await getAllSceneItems(adultFolderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`Failed to fetch Jellyfin Adult items: ${message}`);
    }
  }

  const scenes = await prisma.scene.findMany({ select: { id: true, filePath: true, jellyfinId: true } });
  const sceneByNormPath = new Map(scenes.map((s) => [s.filePath.normalize("NFC"), s]));
  const matchedSceneIds = new Set<number>();

  let sceneMatched = 0;
  const unmatchedInJellyfinAdult: string[] = [];

  for (const item of sceneItems) {
    if (item.Path) {
      const relPath = relativizeAdultPath(item.Path);
      const normPath = relPath?.normalize("NFC");
      const scene = normPath ? sceneByNormPath.get(normPath) : undefined;
      if (scene) {
        if (scene.jellyfinId !== item.Id) {
          await prisma.scene.update({ where: { id: scene.id }, data: { jellyfinId: item.Id } });
        }
        matchedSceneIds.add(scene.id);
        sceneMatched++;
      } else {
        unmatchedInJellyfinAdult.push(item.Name ?? item.Path);
      }
    } else {
      unmatchedInJellyfinAdult.push(item.Name ?? `(item ${item.Id})`);
    }
  }

  const unmatchedInMediaVaultAdult: string[] = [];
  for (const s of scenes) {
    if (matchedSceneIds.has(s.id)) continue;
    unmatchedInMediaVaultAdult.push(s.filePath);
    if (s.jellyfinId !== null) {
      await prisma.scene.update({ where: { id: s.id }, data: { jellyfinId: null } });
    }
  }

  if (adultFolderId) {
    log.push(`Matched ${sceneMatched} of ${scenes.length} MediaVault scene(s) to Jellyfin items`);
    if (unmatchedInMediaVaultAdult.length > 0) {
      log.push(`Unmatched Adult in MediaVault (${unmatchedInMediaVaultAdult.length}): ${unmatchedInMediaVaultAdult.join(", ")}`);
    }
    if (unmatchedInJellyfinAdult.length > 0) {
      log.push(`Unmatched Adult in Jellyfin (${unmatchedInJellyfinAdult.length}): ${unmatchedInJellyfinAdult.join(", ")}`);
    }
  }

  await finishRun(
    runId,
    log,
    `Matched ${matched}/${versions.length} movie version(s), ${tvMatched}/${episodeFilesByNormPath.size} TV file(s), ${sceneMatched}/${scenes.length} Adult scene(s)`,
  );
}

/**
 * Kick off a Jellyfin sync. Resolves quickly once the run is registered (or
 * an existing run is found, or the run is failed immediately for missing
 * config) — the actual Jellyfin/DB work continues in the background and is
 * not awaited here.
 */
export async function runJellyfinSync(): Promise<{ runId: number; started: boolean }> {
  const { run, started } = await guardAndCreateRun("JELLYFIN");
  if (!started) return { runId: run.id, started: false };

  if (!jellyfinConfigured()) {
    await failRun(run.id, new Error("JELLYFIN_URL/JELLYFIN_API_KEY not set"));
    return { runId: run.id, started: true };
  }

  doJellyfinSync(run.id).catch(async (err) => {
    console.error("[jellyfin] sync failed:", err);
    await failRun(run.id, err).catch((e) => console.error("[jellyfin] failed to record failure:", e));
  });

  return { runId: run.id, started: true };
}

// ---------------------------------------------------------------------------
// Server info / deep links
// ---------------------------------------------------------------------------

export interface JellyfinServerInfo {
  serverId: string;
}

let cachedServerInfo: JellyfinServerInfo | null = null;

/** Cached fetch of the Jellyfin server's public id, used to build deep links.
 * Returns null (and logs) if unconfigured or unreachable — callers should
 * simply omit the link rather than surface an error. */
export async function getJellyfinServerInfo(): Promise<JellyfinServerInfo | null> {
  if (!jellyfinConfigured()) return null;
  if (cachedServerInfo) return cachedServerInfo;

  try {
    const res = await fetch(`${baseUrl()}/System/Info/Public`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.Id) return null;
    cachedServerInfo = { serverId: data.Id as string };
    return cachedServerInfo;
  } catch (err) {
    console.error("[jellyfin] failed to fetch server info:", err);
    return null;
  }
}

/** Deep link into the Jellyfin web client for a given item. */
export function jellyfinPlayUrl(itemId: string, serverId: string): string {
  return `${baseUrl()}/web/#/details?id=${itemId}&serverId=${serverId}`;
}

// ---------------------------------------------------------------------------
// Adult-library access sync — see /account's opt-in checkbox
// (src/app/actions/adult.ts). Jellyfin has no user-facing library-visibility
// toggle; this is the admin-delegate half of that opt-in, driving one
// person's Policy.EnabledFolders on their behalf via ADULT_JELLYFIN_FOLDER_ID
// (the folder's raw GUID — there's no CollectionType for adult content to
// match on the way getMoviesLibraryId() matches "movies", so unlike that
// function this can't discover the id programmatically; it's a one-time
// paste from Jellyfin's dashboard, same posture as the SSO client's redirect
// URI). jellyfin-plugin-sso's EnableAuthorization is deliberately off (see
// HOUSEHOLDS_PLAN.md "Jellyfin SSO") — this sync path is the *only* thing
// that should ever touch EnabledFolders for an existing account, which is
// why every write here is read-full-policy / splice-one-field /
// write-the-whole-thing-back, never a partial update.

export type AdultSyncResult =
  | { status: "synced" }
  | { status: "not-linked" } // no Jellyfin account yet — their first SSO login hasn't happened
  | { status: "error"; message: string };

interface JellyfinUserSummary {
  Id: string;
  Name: string;
}

interface JellyfinPolicy {
  EnabledFolders?: string[];
  [key: string]: unknown;
}

interface JellyfinUser {
  Id: string;
  Policy: JellyfinPolicy;
}

// jellyfin-plugin-sso's own identity map (see HOUSEHOLDS_PLAN.md "Jellyfin
// SSO") — keyed by provider name, each provider's CanonicalLinks maps a
// MediaVault email straight to the Jellyfin user id it was linked to. This
// is the authoritative source: an account linked to a pre-existing Jellyfin
// user (e.g. via a manual CanonicalLinks fix, same as this app's own SSO
// setup) will have a Jellyfin username that has nothing to do with their
// email, so matching by username (below) would never find it.
interface SsoProviderConfig {
  CanonicalLinks?: Record<string, string>;
}

async function resolveViaCanonicalLinks(email: string): Promise<string | null> {
  try {
    const providers: Record<string, SsoProviderConfig> = await jellyfinRequest("GET", "/SSO/OID/Get");
    const wanted = email.toLowerCase();
    for (const config of Object.values(providers)) {
      for (const [linkedEmail, userId] of Object.entries(config.CanonicalLinks ?? {})) {
        if (linkedEmail.toLowerCase() === wanted) return userId;
      }
    }
  } catch {
    // jellyfin-plugin-sso not installed, or no provider configured yet —
    // fall through to the username heuristic below.
  }
  return null;
}

async function resolveJellyfinUserId(email: string): Promise<string | null> {
  const viaCanonicalLink = await resolveViaCanonicalLinks(email);
  if (viaCanonicalLink) return viaCanonicalLink;

  // Fallback for an account that hasn't done its first SSO sign-in yet (no
  // CanonicalLinks entry) but was auto-provisioned with DefaultUsernameClaim
  // "email" — its Jellyfin username genuinely is the email in that case.
  const users: JellyfinUserSummary[] = await jellyfinRequest("GET", "/Users");
  const match = users.find((u) => u.Name?.toLowerCase() === email.toLowerCase());
  return match?.Id ?? null;
}

export async function syncJellyfinAdultAccess(
  user: { id: string; email: string; jellyfinUserId: string | null },
  enabled: boolean,
): Promise<AdultSyncResult> {
  if (!jellyfinConfigured()) return { status: "not-linked" };

  const folderId = process.env.ADULT_JELLYFIN_FOLDER_ID;
  if (!folderId) return { status: "error", message: "ADULT_JELLYFIN_FOLDER_ID is not set" };

  try {
    let jellyfinUserId = user.jellyfinUserId;
    if (!jellyfinUserId) {
      jellyfinUserId = await resolveJellyfinUserId(user.email);
      if (!jellyfinUserId) return { status: "not-linked" };
      await prisma.user.update({ where: { id: user.id }, data: { jellyfinUserId } });
    }

    const jfUser: JellyfinUser = await jellyfinRequest("GET", `/Users/${jellyfinUserId}`);
    const policy = jfUser.Policy;
    const current = new Set(policy.EnabledFolders ?? []);
    if (enabled) current.add(folderId);
    else current.delete(folderId);

    await jellyfinRequest("POST", `/Users/${jellyfinUserId}/Policy`, {
      ...policy,
      EnabledFolders: [...current],
    });
    return { status: "synced" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[jellyfin] adult-access sync failed:", message);
    return { status: "error", message };
  }
}
