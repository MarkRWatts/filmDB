// POST /api/adult-video/:sceneId/leave — the scene twin of
// /api/video/:versionId/leave, gated by requireAdultAccessOrResponse like the
// rest of the adult-video routes.

import { NextResponse } from "next/server";
import { noteViewerLeft, parseVariant } from "@/lib/video-cache";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

export async function POST(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { sceneId: sceneIdParam } = await ctx.params;
  const sceneId = Number(sceneIdParam);
  if (!Number.isInteger(sceneId)) {
    return NextResponse.json({ error: "invalid scene id" }, { status: 400 });
  }
  const variant = parseVariant(new URL(req.url).searchParams.get("variant") ?? "original");
  if (!variant) return NextResponse.json({ error: "invalid variant" }, { status: 400 });

  return NextResponse.json({ shortened: noteViewerLeft("scene", sceneId, variant) });
}
