// Ground-truth media probe: width/height, audio streams, duration, size.
// Prefers a local `ffprobe` on PATH; falls back to running the static-ffmpeg
// Docker image against whichever media share (MOVIES_PATH/TVSHOWS_PATH/
// MUSIC_PATH) contains the file (verified command shape in PLAN.md). Uses
// execFile everywhere to avoid shell quoting bugs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface ProbedAudioTrack {
  streamIdx: number;
  codec: string | null;
  profile: string | null;
  language: string | null;
  channels: number | null;
  layout: string | null;
  title: string | null;
  /** ffprobe stream dispositions. `isDefault` is the container's own
   *  "play this one" flag (MakeMKV/HandBrake set it on the main track);
   *  `isDescriptive` covers visual_impaired / descriptions / comment — audio
   *  description and commentary tracks, which must never be picked as the
   *  main soundtrack (video-playback.ts). Older rows predate these columns
   *  and read as false/false until re-probed. */
  isDefault: boolean;
  isDescriptive: boolean;
  /** Music-scanner fields — unused by the movie/TV probe callers. */
  sampleRate: number | null;
  bitDepth: number | null;
}

export interface ProbeResult {
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  colorTransfer: string | null;
  hasDolbyVision: boolean;
  durationSecs: number | null;
  sizeBytes: number | null;
  /** Year from the container's date/year tag (iTunes rips carry one) — the
   *  music scanner's fallback for Album.year when MusicBrainz has no match. */
  tagYear: number | null;
  audioTracks: ProbedAudioTrack[];
}

// `profile` (both video and audio — this is how ffprobe surfaces "DTS-HD MA"
// vs plain "DTS", "DD+" vs "AC-3", etc.), `color_transfer` (video HDR
// transfer function: smpte2084 = PQ/HDR10, arib-std-b67 = HLG), and
// `side_data_list` (video only — Dolby Vision shows up as a "DOVI
// configuration record" entry, not as a codec/profile field at all) must be
// requested by name or ffprobe omits them; verified against a real file on
// the share (Die Hard (1988), which has one DTS-HD MA and one plain DTS
// track — see src/lib/ffprobe.ts history / PLAN.md).
// sample_rate/bits_per_raw_sample are needed for the music scanner (audio
// stream quality: 44100/16 vs 96000/24 etc). Requested for every stream, but
// only the first audio stream's values are used — album art (mjpeg) streams
// on .m4a files can carry their own bits_per_raw_sample (e.g. "8" for the
// cover image), which is ignored by only reading audioTracks[0].
const SHOW_ENTRIES =
  "format=duration,size:format_tags=date,year:stream=index,codec_type,codec_name,profile,width,height,channels,channel_layout,color_transfer,side_data_list,sample_rate,bits_per_raw_sample:stream_tags=language,title:stream_disposition=default,comment,visual_impaired,hearing_impaired,descriptions";

const FFPROBE_ARGS = ["-hide_banner", "-loglevel", "error", "-show_entries", SHOW_ENTRIES, "-of", "json"];

// Cache the "do we have a local ffprobe" decision — only detect once per process.
let hasLocalFfprobePromise: Promise<boolean> | null = null;

function detectLocalFfprobe(): Promise<boolean> {
  if (!hasLocalFfprobePromise) {
    hasLocalFfprobePromise = execFileAsync("ffprobe", ["-version"])
      .then(() => true)
      .catch(() => false);
  }
  return hasLocalFfprobePromise;
}

interface FfprobeSideData {
  side_data_type?: string;
}

interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  channels?: number;
  channel_layout?: string;
  color_transfer?: string;
  side_data_list?: FfprobeSideData[];
  sample_rate?: string;
  bits_per_raw_sample?: string;
  tags?: { language?: string; title?: string };
  disposition?: {
    default?: number;
    comment?: number;
    visual_impaired?: number;
    hearing_impaired?: number;
    descriptions?: number;
  };
}

interface FfprobeJson {
  format?: { duration?: string; size?: string; tags?: { date?: string; year?: string } };
  streams?: FfprobeStream[];
}

// Dolby Vision has no codec_name/profile of its own — it rides alongside the
// base HEVC/H.264 stream as side data. ffprobe (built with libdovi, as the
// mwader/static-ffmpeg image is) surfaces it as a side_data_list entry named
// "DOVI configuration record".
function hasDoviSideData(stream: FfprobeStream | undefined): boolean {
  return (stream?.side_data_list ?? []).some((sd) => sd.side_data_type === "DOVI configuration record");
}

export function parseFfprobeJson(stdout: string): ProbeResult {
  const data: FfprobeJson = JSON.parse(stdout);
  const streams = data.streams ?? [];

  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStreams = streams.filter((s) => s.codec_type === "audio");

  const audioTracks: ProbedAudioTrack[] = audioStreams.map((s) => ({
    streamIdx: s.index,
    codec: s.codec_name ?? null,
    profile: s.profile ?? null,
    language: s.tags?.language ?? null,
    channels: s.channels ?? null,
    layout: s.channel_layout ?? null,
    title: s.tags?.title ?? null,
    isDefault: s.disposition?.default === 1,
    isDescriptive:
      s.disposition?.visual_impaired === 1 || s.disposition?.descriptions === 1 || s.disposition?.comment === 1,
    sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
    bitDepth: s.bits_per_raw_sample ? Number(s.bits_per_raw_sample) : null,
  }));

  const durationSecs = data.format?.duration ? Number(data.format.duration) : null;
  const sizeBytes = data.format?.size ? Number(data.format.size) : null;
  // "2016", "2016-05-30", occasionally junk — keep just a plausible year.
  const tagDate = data.format?.tags?.date ?? data.format?.tags?.year ?? "";
  const tagYearMatch = /^(\d{4})/.exec(tagDate);
  const tagYear = tagYearMatch ? Number(tagYearMatch[1]) : null;

  return {
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    colorTransfer: videoStream?.color_transfer ?? null,
    hasDolbyVision: hasDoviSideData(videoStream),
    durationSecs: Number.isFinite(durationSecs) ? durationSecs : null,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    tagYear: tagYear && tagYear >= 1900 && tagYear <= 2100 ? tagYear : null,
    audioTracks,
  };
}

/**
 * Probe a file given its absolute path on the local filesystem (or, when
 * falling back to Docker, a path under one of the media roots — MOVIES_PATH,
 * TVSHOWS_PATH, MUSIC_PATH, or ADULT_PATH — so it can be translated to a
 * container mount).
 */
export async function probe(absPath: string): Promise<ProbeResult> {
  const hasLocal = await detectLocalFfprobe();

  if (hasLocal) {
    const { stdout } = await execFileAsync("ffprobe", [...FFPROBE_ARGS, absPath], {
      maxBuffer: 1024 * 1024 * 32,
    });
    return parseFfprobeJson(stdout);
  }

  const dockerImage = process.env.FFPROBE_DOCKER_IMAGE;
  if (!dockerImage) {
    throw new Error("ffprobe not found on PATH and FFPROBE_DOCKER_IMAGE is not set");
  }

  // Translate the path against whichever media root contains it.
  const roots = [
    process.env.MOVIES_PATH,
    process.env.TVSHOWS_PATH,
    process.env.MUSIC_PATH,
    process.env.ADULT_PATH,
  ].filter((r): r is string => !!r);
  if (roots.length === 0) {
    throw new Error(
      "No media root (MOVIES_PATH/TVSHOWS_PATH/MUSIC_PATH/ADULT_PATH) set; cannot translate path for dockerized ffprobe",
    );
  }
  let mountRoot: string | null = null;
  let relPath = "";
  for (const root of roots) {
    const rel = path.relative(root, absPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      mountRoot = root;
      relPath = rel;
      break;
    }
  }
  if (!mountRoot) {
    throw new Error(`Path ${absPath} is not under any media root (${roots.join(", ")})`);
  }
  const containerPath = `/probe-root/${relPath.split(path.sep).join("/")}`;

  const dockerArgs = [
    "run",
    "--rm",
    "--entrypoint",
    "/ffprobe",
    "-v",
    `${mountRoot}:/probe-root:ro`,
    dockerImage,
    ...FFPROBE_ARGS,
    containerPath,
  ];

  const { stdout } = await execFileAsync("docker", dockerArgs, { maxBuffer: 1024 * 1024 * 32 });
  return parseFfprobeJson(stdout);
}
