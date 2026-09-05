import { describe, expect, it } from "vitest";
import { parseFfprobeJson } from "./ffprobe";

describe("parseFfprobeJson", () => {
  it("reads the default and descriptive dispositions off each audio stream", () => {
    const json = JSON.stringify({
      format: { duration: "7422.29", size: "30000000000" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        {
          index: 1,
          codec_type: "audio",
          codec_name: "dts",
          profile: "DTS-HD MA",
          channels: 8,
          channel_layout: "7.1",
          tags: { language: "eng", title: "Surround 7.1" },
          disposition: { default: 1, comment: 0, visual_impaired: 0 },
        },
        {
          index: 3,
          codec_type: "audio",
          codec_name: "ac3",
          channels: 2,
          channel_layout: "stereo",
          tags: { language: "eng", title: "Stereo" },
          disposition: { default: 0, visual_impaired: 1 },
        },
        { index: 4, codec_type: "audio", codec_name: "ac3", channels: 2, tags: { title: "Stereo" } },
      ],
    });
    const result = parseFfprobeJson(json);
    expect(result.audioTracks.map((t) => [t.streamIdx, t.isDefault, t.isDescriptive])).toEqual([
      [1, true, false],
      [3, false, true],
      [4, false, false],
    ]);
    expect(result.audioTracks[0]).toMatchObject({ codec: "dts", profile: "DTS-HD MA", channels: 8, title: "Surround 7.1" });
  });

  it("treats a commentary disposition as descriptive too", () => {
    const json = JSON.stringify({
      streams: [{ index: 2, codec_type: "audio", codec_name: "ac3", disposition: { comment: 1 } }],
    });
    expect(parseFfprobeJson(json).audioTracks[0].isDescriptive).toBe(true);
  });
});
