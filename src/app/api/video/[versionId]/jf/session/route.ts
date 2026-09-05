// POST /api/video/:versionId/jf/session?variant=original|remote[&audio=<streamIdx>] — start a
// Jellyfin playback session for this viewer and hand back the proxied
// playlist URL (see src/lib/jellyfin-playback.ts). The player calls this
// instead of /status when a Version has a Jellyfin item.

import { NextResponse } from "next/server";
import { jellyfinConfigured } from "@/lib/jellyfin";
import { startJellyfinPlayback } from "@/lib/jellyfin-playback";
import { parseVariant } from "@/lib/video-playback";
import { currentViewer, jellyfinItemForVersion } from "../_shared";

export async function POST(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  const itemId = await jellyfinItemForVersion(versionId);
  if (!itemId) return NextResponse.json({ error: "not found" }, { status: 404 });
  const params = new URL(req.url).searchParams;
  const variant = parseVariant(params.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });
  const audioParam = params.get("audio");
  const audioStreamIndex = audioParam === null || audioParam === "" ? null : Number(audioParam);
  if (audioStreamIndex !== null && (!Number.isInteger(audioStreamIndex) || audioStreamIndex < 0 || audioStreamIndex > 999)) {
    return NextResponse.json({ error: "invalid audio stream index" }, { status: 400 });
  }

  try {
    const playback = await startJellyfinPlayback({
      itemId,
      jellyfinUserId: viewer.jellyfinUserId,
      deviceId: viewer.deviceId,
      variant,
      audioStreamIndex,
    });
    return NextResponse.json({
      playlistUrl: `/api/video/${versionId}/jf/${playback.playlistPath}`,
      playSessionId: playback.playSessionId,
      durationSecs: playback.runtimeSecs,
      transcodeReasons: playback.transcodeReasons,
    });
  } catch (err) {
    // Detail stays in the server log: upstream messages can quote URLs and
    // responses that must not reach a browser.
    console.error(`[jellyfin-playback] session for version ${versionId} failed:`, err);
    return NextResponse.json({ error: "Jellyfin could not start playback for this file." }, { status: 502 });
  }
}
