// GET /api/video/:versionId/jf/<master.m3u8 | main.m3u8 | hls1/main/N.mp4>?…
// — proxy one Jellyfin playlist or segment for the viewer, authenticating
// upstream with the server's API key and never exposing it (see
// proxyJellyfinHls). Session enforced by src/proxy.ts like every /api route;
// the item must belong to an owned film.

import { NextResponse } from "next/server";
import { jellyfinConfigured } from "@/lib/jellyfin";
import { proxyJellyfinHls } from "@/lib/jellyfin-playback";
import { currentViewer, jellyfinItemForVersion } from "../_shared";

export async function GET(req: Request, ctx: { params: Promise<{ versionId: string; path: string[] }> }) {
  if (!jellyfinConfigured()) return NextResponse.json({ error: "Jellyfin is not configured" }, { status: 503 });
  const viewer = await currentViewer();
  if (!viewer) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { versionId: versionIdParam, path } = await ctx.params;
  const itemId = await jellyfinItemForVersion(Number(versionIdParam));
  if (!itemId) return NextResponse.json({ error: "not found" }, { status: 404 });

  return proxyJellyfinHls(itemId, path.join("/"), new URL(req.url).searchParams, viewer.deviceId);
}
