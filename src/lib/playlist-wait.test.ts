import { describe, expect, it } from "vitest";
import { PLAYLIST_WAIT_MAX_MS, classifyPlaylistFailure, classifyPlaylistResponse } from "./playlist-wait";

describe("classifyPlaylistResponse", () => {
  it("is ready on 200", () => {
    expect(classifyPlaylistResponse(200, null, null)).toEqual({ kind: "ready" });
  });

  it("retries a 503 after Retry-After, defaulting and capping sensibly", () => {
    expect(classifyPlaylistResponse(503, "2", null)).toEqual({ kind: "retry", afterMs: 2000 });
    expect(classifyPlaylistResponse(503, null, null)).toEqual({ kind: "retry", afterMs: 2000 });
    expect(classifyPlaylistResponse(503, "garbage", null)).toEqual({ kind: "retry", afterMs: 2000 });
    expect(classifyPlaylistResponse(503, "600", null)).toEqual({ kind: "retry", afterMs: 15_000 });
  });

  it("surfaces the server's reason on 500", () => {
    expect(classifyPlaylistResponse(500, null, "ffmpeg failed: no space")).toEqual({
      kind: "error",
      message: "ffmpeg failed: no space",
    });
    expect(classifyPlaylistResponse(500, null, null)).toEqual({ kind: "error", message: "Preparation failed." });
  });

  it("treats 404 as not playable and anything else as a load failure", () => {
    expect(classifyPlaylistResponse(404, null, null).kind).toBe("error");
    expect(classifyPlaylistResponse(409, null, null)).toEqual({ kind: "error", message: "Could not load the stream (HTTP 409)." });
  });

  it("retries a thrown fetch and waits minutes, not seconds, overall", () => {
    expect(classifyPlaylistFailure()).toEqual({ kind: "retry", afterMs: 2000 });
    expect(PLAYLIST_WAIT_MAX_MS).toBeGreaterThanOrEqual(120_000);
  });
});
