// POST /api/video/:versionId/leave?variant=original|remote — VideoPlayer.tsx
// sends this (keepalive) when the viewer closes the player, navigates away
// or switches quality: the prepare job for that variant, if running, gets a
// short idle window instead of the full ten minutes (see noteViewerLeft in
// src/lib/video-cache.ts). Anyone else still watching re-arms it with their
// next segment request, so this only ever hurries along work nobody wants.
// Signed-in session enforced by src/proxy.ts like every /api route.

import { NextResponse } from "next/server";
import { noteViewerLeft, parseVariant } from "@/lib/video-cache";

export async function POST(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }
  const variant = parseVariant(new URL(req.url).searchParams.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  return NextResponse.json({ shortened: noteViewerLeft("film", versionId, variant) });
}
