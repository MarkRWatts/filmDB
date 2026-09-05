import { describe, expect, it } from "vitest";
import { audioTrackLabel, languageName } from "./audio-track-label";

describe("audioTrackLabel", () => {
  it("joins codec, language and the container's title", () => {
    const label = audioTrackLabel({ codec: "dts", profile: "DTS-HD MA", channels: 8, layout: "7.1", language: "eng", title: "Surround 7.1" });
    expect(label).toContain("English");
    expect(label).toContain("Surround 7.1");
    expect(label.startsWith("DTS")).toBe(true);
  });

  it("keeps a distinguishing title such as a commentary or description", () => {
    const label = audioTrackLabel({ codec: "ac3", profile: null, channels: 2, layout: "stereo", language: "eng", title: "Audio Description" });
    expect(label).toContain("Audio Description");
  });

  it("copes with nothing but a codec", () => {
    expect(audioTrackLabel({ codec: "aac", profile: null, channels: null, layout: null, language: null, title: null })).toBeTruthy();
  });
});

describe("languageName", () => {
  it("names common codes, upper-cases unknown ones, drops und", () => {
    expect(languageName("eng")).toBe("English");
    expect(languageName("xyz")).toBe("XYZ");
    expect(languageName("und")).toBeNull();
    expect(languageName(null)).toBeNull();
  });
});
