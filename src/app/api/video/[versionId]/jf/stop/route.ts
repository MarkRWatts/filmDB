// POST /api/video/:versionId/jf/stop?playSessionId=… — the viewer closed the
// player (or switched quality); ask Jellyfin to stop that transcode now.

import { NextResponse } from "next/server";
import { jellyfinConfigured } from "@/lib/jellyfin";
import { stopJellyfinPlayback } from "@/lib/jellyfin-playback";
import { currentViewer } from "../_shared";

export async function POST(req: Request) {
  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const playSessionId = new URL(req.url).searchParams.get("playSessionId") ?? "";
  if (!/^[0-9a-f]{32}$/i.test(playSessionId)) return NextResponse.json({ error: "invalid playSessionId" }, { status: 400 });
  await stopJellyfinPlayback(viewer.deviceId, playSessionId);
  return new NextResponse(null, { status: 204 });
}
