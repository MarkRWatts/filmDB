// Pure playback-decision logic for in-app video playback (Safari/iPadOS/iOS
// first — see the research doc for the full device/codec survey). Mirrors
// audio-stream.ts's resolvePlaybackFormat in spirit: no I/O, no ffmpeg, no
// Prisma — just codec/container in, a plan out, so it's cheap to test
// exhaustively.
//
// Three tiers collapse to two operationally:
//   - "direct": the file is already a browser-playable MP4 — serve the
//     original bytes untouched (see video-stream.ts).
//   - "prepare": something needs fixing (container, audio codec, or video
//     codec) — run ffmpeg once into a cached MP4, then serve *that* the same
//     way. Remux-only and full-transcode are both this tier; they only differ
//     in which ffmpeg args get used (see buildFfmpegArgs).
//
// A Blu-ray remux's video (H.264/HEVC) almost always survives as a copy; only
// DVD-era MPEG-2/VC-1 needs a real re-encode. Audio prefers an existing
// AAC/AC-3/E-AC-3 track (copy, free) and only transcodes when the only tracks
// present are lossless-but-unsupported (TrueHD/DTS/DTS-HD MA/PCM) — in which
// case it transcodes the *best* of those (highest channel count, preferring a
// lossless source) rather than whichever track happens to be first.

export type VideoPlaybackTier = "direct" | "prepare";
export type StreamAction = "copy" | "transcode";

export interface AudioTrackInput {
  streamIdx: number;
  codec: string | null;
  profile: string | null;
  channels: number | null;
  /** From ffprobe's stream disposition (AudioTrack.isDefault /
   *  isDescriptive) and the track title. Optional: rows probed before these
   *  were captured, and older tests, simply don't have them. */
  isDefault?: boolean;
  isDescriptive?: boolean;
  title?: string | null;
}

export interface VideoPlaybackInput {
  videoCodec: string | null;
  container: string | null;
  audioTracks: AudioTrackInput[];
}

export interface VideoPlaybackPlan {
  tier: VideoPlaybackTier;
  videoAction: StreamAction;
  /** ffprobe's absolute stream index (Version/AudioTrack.streamIdx) for the
   *  chosen audio track — used as `-map 0:<n>`. null when the file has no
   *  audio streams at all (still plays fine, just silent). */
  audioStreamIndex: number | null;
  audioAction: StreamAction | "none";
  /** Apply `-tag:v hvc1` when muxing HEVC into MP4 — the default `hev1` tag
   *  is unreliable for Apple's own players/Safari. */
  hevcTag: boolean;
  /** What the Original variant's streams will be after the actions above:
   *  the source codec when copied, h264 / aac when transcoded. Feeds
   *  mseMimeForVariant so the player can ask MediaSource.isTypeSupported
   *  before choosing hls.js over a native player. */
  outputVideoCodec: string;
  outputAudioCodec: string | null;
  reason: string;
}

const SUPPORTED_VIDEO_CODECS = new Set(["h264", "hevc", "h265"]);
const HEVC_CODECS = new Set(["hevc", "h265"]);
const MP4_LIKE_CONTAINERS = new Set(["mp4", "m4v", "mov"]);
const COMPATIBLE_AUDIO_CODECS = new Set(["aac", "ac3", "eac3"]);

// Sources worth transcoding *from* preferentially when no compatible track
// exists — a lossless origin gives the best possible AAC result. Plain
// DTS/AC-3 cores are already lossy, so there's no quality reason to prefer
// them over, say, a higher-channel-count PCM track.
function isLosslessSource(codec: string | null, profile: string | null): boolean {
  const c = (codec ?? "").toLowerCase();
  if (c === "truehd") return true;
  if (c.startsWith("pcm")) return true;
  if (c === "dts" && (profile ?? "").toUpperCase().includes("MA")) return true;
  return false;
}

// Titles that mark an audio-description or commentary track when the
// container didn't flag it (some rips carry the flag, many only the name).
const DESCRIPTIVE_TITLE_RE = /audio\s*desc|descri(?:bed|ptive)|commentary|narrat|\bAD\b/i;

function isDescriptiveTrack(t: AudioTrackInput): boolean {
  return Boolean(t.isDescriptive) || DESCRIPTIVE_TITLE_RE.test(t.title ?? "");
}

function isCompatibleAudio(t: AudioTrackInput): boolean {
  return COMPATIBLE_AUDIO_CODECS.has((t.codec ?? "").toLowerCase());
}

/**
 * Which audio stream to serve, and whether it can be copied. Descriptive
 * tracks (audio description, commentary) are never the main soundtrack,
 * whatever their codec — a Blu-ray remux commonly carries its lossless main
 * track first and a stereo AC-3 audio-description track after it, and
 * "first copyable codec" used to land on the description (Captain Marvel,
 * 5 Sep 2026). Among the rest, the container's default-flagged track is
 * the source's own answer: copy it if compatible; otherwise copy a
 * compatible track that keeps at least as many channels (free and no
 * worse), else transcode the default. With no flags at all, fall back to
 * the first compatible track, then to transcoding the best candidate.
 */
function pickAudioTrack(tracks: AudioTrackInput[]): { index: number; action: StreamAction } | null {
  if (tracks.length === 0) return null;

  const byIdx = [...tracks].sort((a, b) => a.streamIdx - b.streamIdx);
  const main = byIdx.filter((t) => !isDescriptiveTrack(t));
  // Everything looks descriptive (mislabelled rip): better any sound than none.
  const pool = main.length > 0 ? main : byIdx;

  const preferred = pool.find((t) => t.isDefault) ?? null;
  const compatible = pool.find(isCompatibleAudio) ?? null;

  if (preferred && isCompatibleAudio(preferred)) return { index: preferred.streamIdx, action: "copy" };
  if (preferred && compatible && (compatible.channels ?? 0) >= (preferred.channels ?? 0)) {
    return { index: compatible.streamIdx, action: "copy" };
  }
  if (preferred) return { index: preferred.streamIdx, action: "transcode" };
  if (compatible) return { index: compatible.streamIdx, action: "copy" };

  // Nothing directly playable — transcode the best candidate: most channels,
  // tie-broken toward a lossless source.
  const scored = pool.map((t) => ({
    track: t,
    score: (t.channels ?? 0) * 10 + (isLosslessSource(t.codec, t.profile) ? 5 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return { index: scored[0].track.streamIdx, action: "transcode" };
}

/**
 * Decide how to serve one Version. Returns null when the file hasn't been
 * probed yet (no videoCodec on record) — callers should treat that as "not
 * ready" rather than guessing.
 */
export function planVideoPlayback(input: VideoPlaybackInput): VideoPlaybackPlan | null {
  if (!input.videoCodec) return null;

  const videoCodec = input.videoCodec.toLowerCase();
  const container = (input.container ?? "").toLowerCase();
  const videoOk = SUPPORTED_VIDEO_CODECS.has(videoCodec);
  const videoAction: StreamAction = videoOk ? "copy" : "transcode";

  const audioChoice = pickAudioTrack(input.audioTracks);
  const audioStreamIndex = audioChoice ? audioChoice.index : null;
  const audioAction: StreamAction | "none" = audioChoice ? audioChoice.action : "none";

  const chosenTrack = audioChoice ? input.audioTracks.find((t) => t.streamIdx === audioChoice.index) : undefined;
  const outputVideoCodec = videoAction === "copy" ? videoCodec : "h264";
  const outputAudioCodec =
    audioAction === "none" ? null : audioAction === "transcode" ? "aac" : (chosenTrack?.codec ?? "").toLowerCase() || null;

  const canDirectPlay =
    videoAction === "copy" && audioAction !== "transcode" && MP4_LIKE_CONTAINERS.has(container);

  const hevcTag = videoAction === "copy" && HEVC_CODECS.has(videoCodec);

  if (canDirectPlay) {
    return {
      tier: "direct",
      videoAction,
      audioStreamIndex,
      audioAction,
      hevcTag,
      outputVideoCodec,
      outputAudioCodec,
      reason: `${videoCodec} in .${container || "?"} with ${audioAction === "none" ? "no audio" : "a compatible audio track"} — already playable`,
    };
  }

  const reasons: string[] = [];
  if (!MP4_LIKE_CONTAINERS.has(container)) reasons.push(`container .${container || "?"} needs remuxing`);
  if (!videoOk) reasons.push(`video codec ${videoCodec} needs transcoding`);
  if (audioAction === "transcode") reasons.push("audio: no directly-playable main track (transcoding the source's default)");

  return {
    tier: "prepare",
    videoAction,
    audioStreamIndex,
    audioAction,
    hevcTag,
    outputVideoCodec,
    outputAudioCodec,
    reason: reasons.join("; ") || "needs preparation",
  };
}

// RFC 6381 codec strings for a MediaSource.isTypeSupported probe. The exact
// profile/level doesn't matter for the question being asked ("can this
// browser's MSE decode this codec family at all"); these are the safe,
// universally recognised forms.
const MSE_VIDEO_CODEC: Record<string, string> = { h264: "avc1.640028", hevc: "hvc1.1.6.L120.B0", h265: "hvc1.1.6.L120.B0" };
const MSE_AUDIO_CODEC: Record<string, string> = { aac: "mp4a.40.2", ac3: "ac-3", eac3: "ec-3" };

/**
 * The fMP4 MIME type a variant's segments will carry, for the player to
 * check against MediaSource.isTypeSupported before choosing hls.js over
 * the browser's native HLS. Null when a codec isn't one we have a string
 * for -- the player then keeps the native path, which decodes anything
 * the platform can.
 */
export function mseMimeForVariant(plan: VideoPlaybackPlan, variant: Variant): string | null {
  const video = variant === "remote" ? "h264" : plan.outputVideoCodec;
  const audio = variant === "remote" ? (plan.outputAudioCodec === null ? null : "aac") : plan.outputAudioCodec;
  const v = MSE_VIDEO_CODEC[video];
  if (!v) return null;
  if (audio === null) return `video/mp4; codecs="${v}"`;
  const a = MSE_AUDIO_CODEC[audio];
  if (!a) return null;
  return `video/mp4; codecs="${v},${a}"`;
}

// Simple per-channel-count AAC bitrate — generous enough that the transcode
// isn't the bottleneck on quality, capped at 6 channels (5.1) since
// multichannel AAC beyond that is a much shakier bet on Apple's own decoders.
export function audioTranscodeChannels(sourceChannels: number | null): number {
  if (!sourceChannels || sourceChannels <= 2) return sourceChannels ?? 2;
  return Math.min(sourceChannels, 6);
}

export function audioTranscodeBitrate(outputChannels: number): string {
  if (outputChannels <= 2) return "192k";
  if (outputChannels <= 6) return "384k";
  return "512k";
}

/** Which rendition of a prepared file to produce/serve (PLAYBACK_PLAN.md):
 *  "original" keeps the source's video (copied where possible) and its best
 *  compatible audio; "remote" is a 720p ~3 Mbps H.264 + stereo AAC encode for
 *  links that can't carry a Blu-ray bitrate. Always the viewer's choice —
 *  over a VPN the server can't tell a hotel from the sofa. */
export type Variant = "original" | "remote";
export const VARIANTS: readonly Variant[] = ["original", "remote"];

export function parseVariant(raw: string | null | undefined): Variant | null {
  return raw === "original" || raw === "remote" ? raw : null;
}

/** Segment length. Six seconds is the conventional compromise: short enough
 *  that seeking during preparation lands within seconds of the target and a
 *  reconnect re-fetches little, long enough that a copied stream's keyframe
 *  cadence (2–5s on most Blu-ray encodes) rarely forces a longer segment. */
export const HLS_SEGMENT_SECS = 6;

/** Remote-variant encode ceiling. ~3 Mbps video + 128k audio streams over
 *  most hotel/mobile links with room to spare, and 720p keeps the encode
 *  near realtime on a small VM at two threads. */
export const REMOTE_VIDEO_MAXRATE = "3M";
export const REMOTE_AUDIO_BITRATE = "128k";

/**
 * Build the ffmpeg argument list for a "prepare" job writing HLS into
 * `outDir` (already resolved for local-vs-docker by the caller). The output
 * is an *event* playlist of fMP4 segments: players can seek anywhere
 * already written while ffmpeg is still running, and it becomes plain VOD
 * once `#EXT-X-ENDLIST` lands. Verified against a real AC-3 source: the hls
 * muxer's own fMP4 defaults cover the delay_moov/negative-CTS lessons the
 * single-file path had to learn explicitly, so no `-movflags` here.
 */
export function buildHlsFfmpegArgs(
  input: string,
  outDir: string,
  plan: VideoPlaybackPlan,
  sourceAudioChannels: number | null | undefined,
  variant: Variant,
): string[] {
  const args = ["-y", "-nostats", "-loglevel", "error", "-i", input, "-map", "0:v:0"];
  if (plan.audioStreamIndex !== null) args.push("-map", `0:${plan.audioStreamIndex}`);
  args.push("-map_chapters", "-1");

  if (variant === "remote") {
    // Never upscale: a DVD source stays at its own height.
    args.push("-vf", "scale=-2:min(720\\,ih)");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
    args.push("-maxrate", REMOTE_VIDEO_MAXRATE, "-bufsize", "6M", "-pix_fmt", "yuv420p", "-threads", "2");
    // Keyframe every segment boundary so every segment is independently
    // decodable and seeks land exactly on segment starts.
    args.push("-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_SECS})`);
    if (plan.audioStreamIndex !== null) args.push("-c:a", "aac", "-ac", "2", "-b:a", REMOTE_AUDIO_BITRATE);
  } else {
    if (plan.videoAction === "copy") {
      args.push("-c:v", "copy");
      if (plan.hevcTag) args.push("-tag:v", "hvc1");
    } else {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "2");
      args.push("-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_SECS})`);
    }
    if (plan.audioStreamIndex !== null) {
      if (plan.audioAction === "copy") {
        args.push("-c:a", "copy");
      } else {
        const outputChannels = audioTranscodeChannels(sourceAudioChannels ?? null);
        args.push("-c:a", "aac", "-ac", String(outputChannels), "-b:a", audioTranscodeBitrate(outputChannels));
      }
    }
  }

  args.push(
    "-f", "hls",
    "-hls_time", String(HLS_SEGMENT_SECS),
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", `${outDir}/seg_%05d.m4s`,
    `${outDir}/index.m3u8`,
  );
  return args;
}

/**
 * Build the ffmpeg argument list for a single-file fragmented-MP4 "prepare"
 * job — the pre-HLS output format, kept for the tests that pin the muxer
 * flags the fragmented path needed. `output` is an absolute path ffmpeg
 * should write to directly. `sourceAudioChannels` is only needed when
 * `plan.audioAction === "transcode"`, to size the AAC output.
 */
export function buildFfmpegArgs(
  input: string,
  output: string,
  plan: VideoPlaybackPlan,
  sourceAudioChannels?: number | null,
): string[] {
  // -nostats / -loglevel error: the child's stderr is buffered in memory by
  // execFile for the whole run, and the default per-frame progress line
  // adds up over a two-hour transcode. With only real errors printed, what
  // remains is exactly the text worth showing a viewer when a prepare
  // fails (see runTrackedProcess in video-cache.ts).
  const args = ["-y", "-nostats", "-loglevel", "error", "-i", input, "-map", "0:v:0"];

  if (plan.audioStreamIndex !== null) {
    args.push("-map", `0:${plan.audioStreamIndex}`);
  }

  // Drop chapters explicitly. Without this, the mov/mp4 muxer auto-converts
  // any source chapter markers into an extra QuickTime chapter text track --
  // harmless in a normal MP4, but in this fragmented output (required for the
  // tailing reader, see below) the stray trak breaks playback outright:
  // confirmed against a real file (chapters present, no subtitle stream) that
  // Safari reports a duration but never renders a single video or audio frame
  // once this extra track is present.
  args.push("-map_chapters", "-1");

  if (plan.videoAction === "copy") {
    args.push("-c:v", "copy");
    if (plan.hevcTag) args.push("-tag:v", "hvc1");
  } else {
    // Cap encoder threads rather than letting libx264 claim every core: this
    // runs as a background job on a small always-on box that also has to
    // keep serving the app and any other concurrent stream, so a full-width
    // encode starving everything else is worse than a slightly slower one.
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "2");
  }

  if (plan.audioStreamIndex !== null) {
    if (plan.audioAction === "copy") {
      args.push("-c:a", "copy");
    } else {
      const outputChannels = audioTranscodeChannels(sourceAudioChannels ?? null);
      args.push("-c:a", "aac", "-ac", String(outputChannels), "-b:a", audioTranscodeBitrate(outputChannels));
    }
  }

  // Fragmented MP4, not +faststart: faststart writes the moov (index) only
  // after the whole mdat exists, then seeks back to prepend it -- a partial
  // file isn't valid to play until that second pass, right near the end.
  // Fragmented output writes a minimal moov immediately, then a sequence of
  // self-contained moof+mdat fragments, so a reader can start decoding from
  // whatever's been written so far -- what makes streaming while the file is
  // still being generated possible at all (see video-cache.ts's tailing
  // reader).
  //
  // delay_moov is required, not optional, whenever an audio track is
  // stream-copied: the mp4 muxer needs to know each stream's frame size to
  // write even an empty moov, and a copied (not re-encoded) AC-3 track
  // doesn't expose that until its first packet arrives -- without this flag,
  // copying AC-3 audio fails outright ("Cannot write moov atom before AC3
  // packets"), confirmed against a real file. Harmless to always include.
  //
  // negative_cts_offsets matters whenever the video has B-frames (true for
  // essentially every copied H.264/HEVC source): without it the muxer falls
  // back to edit-list-based composition timing, which doesn't survive the
  // empty_moov/delay_moov fragmented path. Diagnosed against a real file
  // (copied H.264 with B-frames) that reproduced exactly this way: Safari
  // read a valid duration but never rendered a single video frame, audio
  // played fine.
  args.push(
    "-movflags",
    "frag_keyframe+empty_moov+delay_moov+default_base_moof+negative_cts_offsets",
    "-f",
    "mp4",
    output,
  );
  return args;
}
