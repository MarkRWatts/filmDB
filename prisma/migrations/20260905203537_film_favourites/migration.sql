-- CreateTable
CREATE TABLE "FilmFavourite" (
    "userId" TEXT NOT NULL,
    "filmId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "filmId"),
    CONSTRAINT "FilmFavourite_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FilmFavourite_userId_idx" ON "FilmFavourite"("userId");
