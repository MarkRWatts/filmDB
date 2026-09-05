// Per-viewer state the film page's action row shows: whether this person
// has favourited the film, and whether they have any watch record for it
// (in progress or completed) that the "reset viewed" button could clear.

import { prisma } from "@/lib/db";

export interface FilmUserState {
  favourite: boolean;
  watched: boolean;
}

export async function getFilmUserState(userId: string, filmId: number, versionIds: number[]): Promise<FilmUserState> {
  const [favourite, progress] = await Promise.all([
    prisma.filmFavourite.findUnique({ where: { userId_filmId: { userId, filmId } }, select: { userId: true } }),
    versionIds.length > 0
      ? prisma.watchProgress.findFirst({ where: { userId, versionId: { in: versionIds } }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  return { favourite: favourite !== null, watched: progress !== null };
}
