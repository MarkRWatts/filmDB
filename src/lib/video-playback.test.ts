import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, buildHlsFfmpegArgs, mseMimeForVariant, parseVariant, planVideoPlayback } from "./video-playback";

describe("buildHlsFfmpegArgs", () => {
  const remuxPlan = planVideoPlayback({
    videoCodec: "h264",
    container: "mkv",
    audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
  })!;

  it("writes an fMP4 event playlist with the init segment and a zero-padded segment pattern", () => {
    const args = buildHlsFfmpegArgs("/in.mkv", "/cache/film-1", remuxPlan, null, "original");
    expect(args.slice(0, 5)).toEqual(["-y", "-nostats", "-loglevel", "error", "-i"]);
    expect(args).toEqual(expect.arrayContaining(["-f", "hls", "-hls_segment_type", "fmp4", "-hls_playlist_type", "event"]));
    expect(args[args.indexOf("-hls_fmp4_init_filename") + 1]).toBe("init.mp4");
    expect(args[args.indexOf("-hls_segment_filename") + 1]).toBe("/cache/film-1/seg_%05d.m4s");
    expect(args[args.length - 1]).toBe("/cache/film-1/index.m3u8");
    expect(args[args.indexOf("-hls_time") + 1]).toBe("6");
  });

  it("copies both streams for an original-variant remux and still drops chapters", () => {
    const args = buildHlsFfmpegArgs("/in.mkv", "/out", remuxPlan, null, "original");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-c:a", "copy"]));
    expect(args[args.indexOf("-map_chapters") + 1]).toBe("-1");
    expect(args).not.toContain("-vf");
  });

  it("encodes the remote variant at 720p under a bitrate ceiling with stereo AAC, keyframes on segment boundaries", () => {
    const args = buildHlsFfmpegArgs("/in.mkv", "/out", remuxPlan, 6, "remote");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=-2:min(720\\,ih)");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-maxrate", "3M", "-c:a", "aac", "-ac", "2", "-b:a", "128k"]));
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe("expr:gte(t,n_forced*6)");
    expect(args).not.toContain("copy");
  });

  it("transcodes video for an original-variant MPEG-2 source with segment-aligned keyframes", () => {
    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "vob",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    })!;
    const args = buildHlsFfmpegArgs("/in.vob", "/out", plan, null, "original");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-crf", "18", "-threads", "2", "-c:a", "copy"]));
    expect(args).toContain("-force_key_frames");
  });

  it("keeps the hvc1 tag for copied HEVC", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "eac3", profile: null, channels: 6 }],
    })!;
    const args = buildHlsFfmpegArgs("/in.mkv", "/out", plan, null, "original");
    expect(args[args.indexOf("-tag:v") + 1]).toBe("hvc1");
  });
});

describe("parseVariant", () => {
  it("accepts exactly the two variants", () => {
    expect(parseVariant("original")).toBe("original");
    expect(parseVariant("remote")).toBe("remote");
    expect(parseVariant("REMOTE")).toBeNull();
    expect(parseVariant("")).toBeNull();
    expect(parseVariant(null)).toBeNull();
    expect(parseVariant(undefined)).toBeNull();
  });
});

describe("planVideoPlayback", () => {
  it("returns null when the file hasn't been probed yet", () => {
    expect(planVideoPlayback({ videoCodec: null, container: "mkv", audioTracks: [] })).toBeNull();
  });

  it("direct-plays h264/aac already in an mp4", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mp4",
      audioTracks: [{ streamIdx: 1, codec: "aac", profile: null, channels: 2 }],
    });
    expect(plan).toMatchObject({
      tier: "direct",
      videoAction: "copy",
      audioAction: "copy",
      audioStreamIndex: 1,
      hevcTag: false,
    });
  });

  it("direct-plays a video-only mp4 with no audio tracks", () => {
    const plan = planVideoPlayback({ videoCodec: "h264", container: "mp4", audioTracks: [] });
    expect(plan).toMatchObject({ tier: "direct", audioAction: "none", audioStreamIndex: null });
  });

  it("remuxes h264+ac3 out of an mkv without touching either stream", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    });
    expect(plan).toMatchObject({ tier: "prepare", videoAction: "copy", audioAction: "copy", audioStreamIndex: 1 });
  });

  it("picks a compatible track over an incompatible one regardless of stream order", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "truehd", profile: null, channels: 8 },
        { streamIdx: 2, codec: "ac3", profile: null, channels: 6 },
      ],
    });
    expect(plan).toMatchObject({ tier: "prepare", audioAction: "copy", audioStreamIndex: 2, hevcTag: true });
  });

  it("tags hevc copies with hvc1 for Apple compatibility", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "aac", profile: null, channels: 2 }],
    });
    expect(plan).toMatchObject({ tier: "prepare", videoAction: "copy", hevcTag: true });
  });

  it("transcodes audio when nothing compatible exists, preferring the lossless/highest-channel source", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 8 },
        { streamIdx: 2, codec: "dts", profile: null, channels: 6 }, // plain DTS core, fewer channels
      ],
    });
    expect(plan).toMatchObject({ tier: "prepare", audioAction: "transcode", audioStreamIndex: 1 });
  });

  it("prefers higher channel count over lossless-ness when they conflict", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 2 }, // lossless but stereo
        { streamIdx: 2, codec: "truehd", profile: null, channels: 8 }, // also lossless, more channels
      ],
    });
    expect(plan).toMatchObject({ audioAction: "transcode", audioStreamIndex: 2 });
  });

  it("transcodes mpeg-2 (DVD) video even when audio is already compatible", () => {
    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    });
    expect(plan).toMatchObject({ tier: "prepare", videoAction: "transcode", audioAction: "copy", hevcTag: false });
  });

  it("is case-insensitive on codec and container", () => {
    const plan = planVideoPlayback({
      videoCodec: "H264",
      container: "MP4",
      audioTracks: [{ streamIdx: 1, codec: "AAC", profile: null, channels: 2 }],
    });
    expect(plan?.tier).toBe("direct");
  });
});

describe("buildFfmpegArgs", () => {
  it("copies both streams for a plain remux", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    expect(args).toEqual([
      "-y",
      "-nostats",
      "-loglevel",
      "error",
      "-i",
      "/in.mkv",
      "-map",
      "0:v:0",
      "-map",
      "0:1",
      "-map_chapters",
      "-1",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+delay_moov+default_base_moof+negative_cts_offsets",
      "-f",
      "mp4",
      "/out.mp4",
    ]);
  });

  it("caps transcoded audio at 6 channels and picks a bitrate off the output channel count", () => {
    const plan = planVideoPlayback({
      videoCodec: "hevc",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "truehd", profile: null, channels: 8 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan, 8);
    expect(args).toContain("-tag:v");
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-ac", "6", "-b:a", "384k"]));
  });

  it("adds a video encode when the source codec is unsupported", () => {
    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "vob",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    })!;
    const args = buildFfmpegArgs("/in.vob", "/out.mp4", plan);
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]));
  });

  // Regression: copying an AC-3 track (the common case -- AC-3 is already
  // "compatible", so it's copied rather than transcoded) into an empty_moov
  // fragmented MP4 fails outright without delay_moov -- ffmpeg can't write
  // even an empty moov before it's seen an AC-3 packet to learn the frame
  // size from. Confirmed against a real file: "Cannot write moov atom before
  // AC3 packets" without this flag, clean output with it.
  it("always includes delay_moov, required for a copied AC-3 track to mux at all", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    const movflags = args[args.indexOf("-movflags") + 1];
    expect(movflags.split("+")).toContain("delay_moov");
  });

  // Regression: a source chapter track (very common on DVD/Blu-ray rips) gets
  // auto-converted into an extra QuickTime chapter text track by the mov
  // muxer unless chapters are explicitly dropped. That stray track broke
  // playback outright in a fragmented MP4 -- confirmed against a real file
  // where Safari reported a duration but rendered no video or audio at all
  // until this flag was added.
  it("always drops chapters, to avoid an auto-inserted chapter track breaking fragmented playback", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    expect(args[args.indexOf("-map_chapters") + 1]).toBe("-1");
  });

  // Regression: a copied H.264 stream with B-frames (the common case) played
  // audio but rendered no video at all in Safari, because the fragmented
  // empty_moov/delay_moov path doesn't survive edit-list-based composition
  // timing -- confirmed against a real file.
  it("always includes negative_cts_offsets, required for B-frame video to render in the fragmented path", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    const movflags = args[args.indexOf("-movflags") + 1];
    expect(movflags.split("+")).toContain("negative_cts_offsets");
  });

  // A real transcode is CPU-bound and this runs as a background job on a
  // small box that also has to keep serving the app -- letting libx264 claim
  // every core starves everything else.
  it("caps libx264 to 2 threads so a transcode doesn't monopolize the host", () => {
    const plan = planVideoPlayback({
      videoCodec: "mpeg2video",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2 }],
    })!;
    const args = buildFfmpegArgs("/in.mkv", "/out.mp4", plan);
    expect(args[args.indexOf("-threads") + 1]).toBe("2");
  });
});

describe("pickAudioTrack (via planVideoPlayback)", () => {
  // Captain Marvel's real layout: lossless 7.1 flagged default, a plain DTS
  // 5.1, and two AC-3 "Stereo" tracks of which the first is the audio
  // description. "First copyable codec" used to pick the description.
  const captainMarvel = [
    { streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 8, title: "Surround 7.1", isDefault: true },
    { streamIdx: 2, codec: "dts", profile: "DTS", channels: 6, title: "Surround 5.1" },
    { streamIdx: 3, codec: "ac3", profile: null, channels: 2, title: "Stereo", isDescriptive: true },
    { streamIdx: 4, codec: "ac3", profile: null, channels: 2, title: "Stereo" },
  ];

  it("never picks a descriptive track, and transcodes the default when the only copyable track loses channels", () => {
    const plan = planVideoPlayback({ videoCodec: "h264", container: "mkv", audioTracks: captainMarvel })!;
    expect(plan).toMatchObject({ tier: "prepare", audioStreamIndex: 1, audioAction: "transcode" });
    expect(plan.reason).toContain("transcoding the source's default");
  });

  it("copies the default track when it is itself compatible", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 8 },
        { streamIdx: 2, codec: "eac3", profile: null, channels: 6, isDefault: true },
      ],
    })!;
    expect(plan).toMatchObject({ audioStreamIndex: 2, audioAction: "copy" });
  });

  it("copies a compatible non-default track that keeps the default's channel count (free, no worse)", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "dts", profile: "DTS", channels: 6, isDefault: true },
        { streamIdx: 2, codec: "ac3", profile: null, channels: 6 },
      ],
    })!;
    expect(plan).toMatchObject({ audioStreamIndex: 2, audioAction: "copy" });
  });

  it("recognises a description track by its title when the container didn't flag it", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "ac3", profile: null, channels: 2, title: "English - Audio Description" },
        { streamIdx: 2, codec: "ac3", profile: null, channels: 2, title: "Director's Commentary" },
        { streamIdx: 3, codec: "ac3", profile: null, channels: 6, title: "Surround 5.1" },
      ],
    })!;
    expect(plan).toMatchObject({ audioStreamIndex: 3, audioAction: "copy" });
  });

  it("falls back to any track when every track looks descriptive", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 2, title: "AD", isDescriptive: true }],
    })!;
    expect(plan).toMatchObject({ audioStreamIndex: 1, audioAction: "copy" });
  });

  it("keeps the old behaviour for rows without any flags: first compatible track by index", () => {
    const plan = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [
        { streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 8 },
        { streamIdx: 2, codec: "ac3", profile: null, channels: 6 },
      ],
    })!;
    expect(plan).toMatchObject({ audioStreamIndex: 2, audioAction: "copy" });
  });
});

describe("output codecs and mseMimeForVariant", () => {
  it("reports copied codecs for a remux and h264/aac for transcodes", () => {
    const remux = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "ac3", profile: null, channels: 6 }],
    })!;
    expect(remux).toMatchObject({ outputVideoCodec: "h264", outputAudioCodec: "ac3" });
    expect(mseMimeForVariant(remux, "original")).toBe('video/mp4; codecs="avc1.640028,ac-3"');
    expect(mseMimeForVariant(remux, "remote")).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');

    const transcode = planVideoPlayback({
      videoCodec: "vc1",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "dts", profile: "DTS-HD MA", channels: 8, isDefault: true }],
    })!;
    expect(transcode).toMatchObject({ outputVideoCodec: "h264", outputAudioCodec: "aac" });
    expect(mseMimeForVariant(transcode, "original")).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
  });

  it("handles HEVC, no audio, and codecs it has no string for", () => {
    const hevc = planVideoPlayback({ videoCodec: "hevc", container: "mkv", audioTracks: [] })!;
    expect(mseMimeForVariant(hevc, "original")).toBe('video/mp4; codecs="hvc1.1.6.L120.B0"');
    expect(mseMimeForVariant(hevc, "remote")).toBe('video/mp4; codecs="avc1.640028"');

    const odd = planVideoPlayback({
      videoCodec: "h264",
      container: "mkv",
      audioTracks: [{ streamIdx: 1, codec: "opus", profile: null, channels: 2, isDefault: true }],
    })!;
    // opus isn't in COMPATIBLE_AUDIO_CODECS, so it's transcoded to aac and the string is known
    expect(mseMimeForVariant(odd, "original")).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
    expect(mseMimeForVariant({ ...odd, outputVideoCodec: "av1" }, "original")).toBeNull();
  });
});
