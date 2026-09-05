// Shared lookups for the /jf/* routes: the signed-in viewer (with their
// Jellyfin user id, if the SSO plugin has created their account yet) and
// the owned Version's Jellyfin item id.

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { jellyfinDeviceId } from "@/lib/jellyfin-playback";

export async function currentViewer(): Promise<{ userId: string; jellyfinUserId: string | null; deviceId: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { jellyfinUserId: true } });
  return { userId, jellyfinUserId: user?.jellyfinUserId ?? null, deviceId: jellyfinDeviceId(userId) };
}

export async function jellyfinItemForVersion(versionId: number): Promise<string | null> {
  if (!Number.isInteger(versionId)) return null;
  const version = await prisma.version.findUnique({
    where: { id: versionId },
    select: { jellyfinId: true, film: { select: { owned: true } } },
  });
  if (!version?.jellyfinId || !version.film?.owned) return null;
  return version.jellyfinId;
}
