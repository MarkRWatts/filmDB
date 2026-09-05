// In-app playback through Jellyfin (PLAYBACK_PLAN.md, "Status"): Jellyfin
// owns the transcoding pipeline -- a full VOD HLS playlist for the whole
// runtime, segments produced on demand so a seek anywhere just starts
// ffmpeg at that offset -- and MediaVault stays the catalogue.
//
// MediaVault holds only an admin API key for Jellyfin (the SSO plugin
// creates each person's Jellyfin account lazily and never hands us a user
// token), and that key must never reach a browser. So every request is
// brokered here: PlaybackInfo is asked server-side, and the playlist and
// segments are proxied under /api/video/<versionId>/jf/... with the key
// stripped from the URLs Jellyfin writes into its playlists. All video
// bytes flow Jellyfin -> this app -> Caddy -> viewer, which is fine on one
// LAN (and is exactly what happened with the local ffmpeg pipeline).

import { jellyfinApiKey, jellyfinBaseUrl } from "@/lib/jellyfin";
import type { Variant } from "@/lib/video-playback";

/** Bitrate ceilings per quality: Original is high enough that Jellyfin
 *  copies the video stream (a remux plus, where needed, an audio
 *  transcode); Remote makes it re-encode to fit a hotel/mobile link, with
 *  the width condition below bringing it down to 720p. */
export const VARIANT_MAX_BITRATE: Record<Variant, number> = {
  original: 120_000_000,
  remote: 4_000_000,
};

export function jellyfinDeviceId(userId: string): string {
  return `mediavault-${userId}`;
}

/** What this app's players can take: fMP4 HLS with H.264/HEVC video and
 *  AAC/AC-3/E-AC-3 audio (native Safari and hls.js both), up to 5.1. No
 *  subtitle profiles on purpose -- see startJellyfinPlayback. */
export function deviceProfile(variant: Variant): Record<string, unknown> {
  const maxBitrate = VARIANT_MAX_BITRATE[variant];
  return {
    Name: "MediaVault",
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    DirectPlayProfiles: [{ Container: "mp4,m4v", Type: "Video", VideoCodec: "h264,hevc", AudioCodec: "aac,ac3,eac3" }],
    TranscodingProfiles: [
      {
        Container: "mp4",
        Type: "Video",
        VideoCodec: "h264,hevc",
        AudioCodec: "aac,ac3,eac3",
        Protocol: "hls",
        Context: "Streaming",
        MaxAudioChannels: "6",
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    CodecProfiles:
      variant === "remote"
        ? [{ Type: "Video", Conditions: [{ Condition: "LessThanEqual", Property: "Width", Value: "1280", IsRequired: false }] }]
        : [],
    SubtitleProfiles: [],
  };
}

export interface JellyfinPlayback {
  playSessionId: string;
  mediaSourceId: string;
  /** "master.m3u8?<Jellyfin's query, minus the API key>" -- relative to the
   *  item's /videos/<id>/ root, which the proxy route mirrors. */
  playlistPath: string;
  runtimeSecs: number | null;
  transcodeReasons: string[];
}

interface PlaybackInfoResponse {
  PlaySessionId?: string;
  ErrorCode?: string;
  MediaSources?: {
    Id: string;
    TranscodingUrl?: string;
    RunTimeTicks?: number;
    TranscodeReasons?: string[] | string;
  }[];
}

/** Remove Jellyfin's `ApiKey=`/`api_key=` query parameter wherever it
 *  appears in a playlist (or a single URL), keeping the rest of the query
 *  intact. The proxy authenticates with a header instead. */
export function stripApiKey(text: string): string {
  return text.replace(/([?&])(?:ApiKey|api_key)=[^&"\s]*(&)?/g, (_m, sep: string, amp: string | undefined) => (amp ? sep : ""));
}

/** Pure part of startJellyfinPlayback, for tests. */
export function playbackFromInfo(info: PlaybackInfoResponse): JellyfinPlayback {
  if (info.ErrorCode) throw new Error(`Jellyfin refused playback: ${info.ErrorCode}`);
  const source = (info.MediaSources ?? []).find((m) => m.TranscodingUrl) ?? null;
  if (!source || !source.TranscodingUrl || !info.PlaySessionId) {
    throw new Error("Jellyfin offered no HLS stream for this item");
  }
  const marker = "/master.m3u8";
  const at = source.TranscodingUrl.indexOf(marker);
  // The URL carries the API key; never let it into an error message.
  if (at < 0) throw new Error(`unexpected Jellyfin transcoding URL: ${stripApiKey(source.TranscodingUrl)}`);
  const playlistPath = stripApiKey(source.TranscodingUrl.slice(at + 1)).replace("master.m3u8?&", "master.m3u8?");
  const reasons = source.TranscodeReasons;
  return {
    playSessionId: info.PlaySessionId,
    mediaSourceId: source.Id,
    playlistPath,
    runtimeSecs: source.RunTimeTicks ? source.RunTimeTicks / 10_000_000 : null,
    transcodeReasons: Array.isArray(reasons) ? reasons : reasons ? reasons.split(",") : [],
  };
}

function authHeaders(deviceId: string): Record<string, string> {
  return {
    Authorization: `MediaBrowser Token="${jellyfinApiKey()}", Client="MediaVault", Device="MediaVault web", DeviceId="${deviceId}", Version="1"`,
  };
}

/**
 * Ask Jellyfin how to play an item for this viewer and quality. Subtitles
 * are switched off (SubtitleStreamIndex -1): with none of our players able
 * to take a sidecar track yet, Jellyfin would otherwise burn a PGS track
 * into the picture, which forces a full video re-encode (seen on Captain
 * Marvel: "SubtitleMethod=Encode"). Audio is Jellyfin's choice -- it
 * honours the source's default track. Direct play/stream are off so the
 * answer is always an HLS playlist the proxy can serve.
 */
export async function startJellyfinPlayback(opts: {
  itemId: string;
  jellyfinUserId: string | null;
  deviceId: string;
  variant: Variant;
}): Promise<JellyfinPlayback> {
  const url = new URL(`${jellyfinBaseUrl()}/Items/${opts.itemId}/PlaybackInfo`);
  if (opts.jellyfinUserId) url.searchParams.set("UserId", opts.jellyfinUserId);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { ...authHeaders(opts.deviceId), "Content-Type": "application/json" },
    body: JSON.stringify({
      DeviceProfile: deviceProfile(opts.variant),
      MaxStreamingBitrate: VARIANT_MAX_BITRATE[opts.variant],
      EnableDirectPlay: false,
      EnableDirectStream: false,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      AutoOpenLiveStream: true,
      SubtitleStreamIndex: -1,
    }),
  });
  if (!res.ok) throw new Error(`Jellyfin PlaybackInfo -> HTTP ${res.status}`);
  return playbackFromInfo((await res.json()) as PlaybackInfoResponse);
}

/** Tell Jellyfin the viewer has gone so it stops the transcoder now rather
 *  than at its own idle timeout. Best effort. */
export async function stopJellyfinPlayback(deviceId: string, playSessionId: string): Promise<void> {
  const url = new URL(`${jellyfinBaseUrl()}/Videos/ActiveEncodings`);
  url.searchParams.set("deviceId", deviceId);
  url.searchParams.set("playSessionId", playSessionId);
  await fetch(url.toString(), { method: "DELETE", headers: authHeaders(deviceId) }).catch(() => {});
}

/** The only paths the proxy will forward: Jellyfin's master and media
 *  playlists and its numbered fMP4 segments (-1 is the init segment). */
export const JF_PATH_RE = /^(?:master\.m3u8|main\.m3u8|hls1\/main\/-?\d{1,6}\.(?:mp4|ts))$/;

/**
 * Fetch one playlist or segment from Jellyfin for the item and hand it back
 * as a Response the route can return. Playlists come back rewritten with
 * the API key removed; segments stream through untouched.
 */
export async function proxyJellyfinHls(itemId: string, subpath: string, query: URLSearchParams, deviceId: string): Promise<Response> {
  if (!JF_PATH_RE.test(subpath)) return new Response("not found", { status: 404 });
  query.delete("ApiKey");
  query.delete("api_key");
  const upstream = `${jellyfinBaseUrl()}/videos/${itemId}/${subpath}?${query.toString()}`;
  const res = await fetch(upstream, { headers: authHeaders(deviceId) });
  if (!res.ok) return new Response(`Jellyfin ${res.status}`, { status: res.status === 404 ? 404 : 502 });

  if (subpath.endsWith(".m3u8")) {
    const body = stripApiKey(await res.text());
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
    });
  }
  const headers = new Headers({
    "Content-Type": res.headers.get("Content-Type") ?? (subpath.endsWith(".ts") ? "video/mp2t" : "video/mp4"),
    "Cache-Control": "private, max-age=3600",
  });
  const length = res.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(res.body, { status: 200, headers });
}
