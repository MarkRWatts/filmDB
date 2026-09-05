// Waiting for an HLS playlist to become playable before a player is pointed
// at it. GET hls/<variant>/index.m3u8 self-starts the ffmpeg job and waits
// a bounded time for the first segment, then answers 503 + Retry-After if
// it hasn't landed -- under load (two prepares sharing one CIFS mount, or a
// transcode) the first segment has taken 40s+. hls.js retries a failed
// manifest; Apple's native player does not, it just raises a media error.
// So the player asks here first, and only hands the URL to <video> once a
// real playlist came back. Pure classification so it can be unit-tested;
// the fetch loop lives in VideoPlayer.tsx.

export type PlaylistPoll =
  | { kind: "ready" }
  | { kind: "retry"; afterMs: number }
  | { kind: "error"; message: string };

const DEFAULT_RETRY_MS = 2000;
const MAX_RETRY_MS = 15_000;

export function classifyPlaylistResponse(status: number, retryAfter: string | null, bodyError: string | null): PlaylistPoll {
  if (status === 200) return { kind: "ready" };
  if (status === 503) {
    const secs = retryAfter === null ? NaN : Number(retryAfter);
    const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : DEFAULT_RETRY_MS;
    return { kind: "retry", afterMs: Math.min(ms, MAX_RETRY_MS) };
  }
  if (status === 404) return { kind: "error", message: "This version isn't playable." };
  if (status === 500) return { kind: "error", message: bodyError ?? "Preparation failed." };
  return { kind: "error", message: bodyError ?? `Could not load the stream (HTTP ${status}).` };
}

/** A fetch that threw (network) is worth a retry, not an error. */
export function classifyPlaylistFailure(): PlaylistPoll {
  return { kind: "retry", afterMs: DEFAULT_RETRY_MS };
}

/** Give up on a playlist that still isn't ready after this long. Generous:
 *  each poll can itself sit on the server for 30s, and a first segment has
 *  taken 40s+ under load. */
export const PLAYLIST_WAIT_MAX_MS = 3 * 60_000;
