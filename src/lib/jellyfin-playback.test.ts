import { describe, expect, it } from "vitest";
import { JF_PATH_RE, VARIANT_MAX_BITRATE, deviceProfile, playbackFromInfo, stripApiKey } from "./jellyfin-playback";

describe("stripApiKey", () => {
  it("removes the key wherever Jellyfin puts it, keeping the rest of the query", () => {
    expect(stripApiKey("main.m3u8?DeviceId=d&ApiKey=SECRET&PlaySessionId=p")).toBe("main.m3u8?DeviceId=d&PlaySessionId=p");
    expect(stripApiKey("hls1/main/0.mp4?ApiKey=SECRET&runtimeTicks=0")).toBe("hls1/main/0.mp4?runtimeTicks=0");
    expect(stripApiKey("x.mp4?a=1&api_key=SECRET")).toBe("x.mp4?a=1");
    expect(stripApiKey("x.mp4?ApiKey=SECRET")).toBe("x.mp4");
  });

  it("rewrites every line of a playlist, including the EXT-X-MAP URI", () => {
    const playlist = ['#EXT-X-MAP:URI="hls1/main/-1.mp4?DeviceId=d&ApiKey=SECRET&runtimeTicks=0"', "#EXTINF:3.0,", "hls1/main/0.mp4?DeviceId=d&ApiKey=SECRET"].join("\n");
    const out = stripApiKey(playlist);
    expect(out).not.toContain("SECRET");
    expect(out).toContain('URI="hls1/main/-1.mp4?DeviceId=d&runtimeTicks=0"');
    expect(out).toContain("hls1/main/0.mp4?DeviceId=d");
  });
});

describe("playbackFromInfo", () => {
  const info = {
    PlaySessionId: "ps1",
    MediaSources: [
      {
        Id: "ms1",
        RunTimeTicks: 74_222_930_000,
        TranscodeReasons: "ContainerNotSupported,AudioCodecNotSupported",
        TranscodingUrl: "/videos/9b93-abcd/master.m3u8?&DeviceId=mediavault-u&MediaSourceId=ms1&ApiKey=SECRET&PlaySessionId=ps1",
      },
    ],
  };

  it("keeps Jellyfin's query minus the key, relative to the item root", () => {
    const pb = playbackFromInfo(info);
    expect(pb).toMatchObject({ playSessionId: "ps1", mediaSourceId: "ms1", runtimeSecs: 7422.293 });
    expect(pb.playlistPath).toBe("master.m3u8?DeviceId=mediavault-u&MediaSourceId=ms1&PlaySessionId=ps1");
    expect(pb.transcodeReasons).toEqual(["ContainerNotSupported", "AudioCodecNotSupported"]);
  });

  it("refuses an item with no HLS offer or an error code", () => {
    expect(() => playbackFromInfo({ PlaySessionId: "x", MediaSources: [{ Id: "m" }] })).toThrow(/no HLS stream/);
    expect(() => playbackFromInfo({ ErrorCode: "NotAllowed" })).toThrow(/NotAllowed/);
  });
});

describe("deviceProfile and proxy path allow-list", () => {
  it("caps Remote at a mobile-friendly bitrate and 720p width; Original copies", () => {
    expect(VARIANT_MAX_BITRATE.remote).toBeLessThan(VARIANT_MAX_BITRATE.original);
    const remote = deviceProfile("remote") as { CodecProfiles: unknown[]; MaxStreamingBitrate: number };
    expect(remote.MaxStreamingBitrate).toBe(4_000_000);
    expect(remote.CodecProfiles).toHaveLength(1);
    expect((deviceProfile("original") as { CodecProfiles: unknown[] }).CodecProfiles).toHaveLength(0);
  });

  it("only forwards Jellyfin's playlist and segment names", () => {
    for (const ok of ["master.m3u8", "main.m3u8", "hls1/main/0.mp4", "hls1/main/-1.mp4", "hls1/main/2471.mp4", "hls1/main/12.ts"]) {
      expect(JF_PATH_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["../etc/passwd", "hls1/main/0.mp4/..", "stream.mp4", "hls1/other/0.mp4", "main.m3u8?x=1", "hls1/main/a.mp4"]) {
      expect(JF_PATH_RE.test(bad), bad).toBe(false);
    }
  });
});
