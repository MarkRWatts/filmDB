import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import PosterImage from "@/components/PosterImage";
import VersionCard from "@/components/VersionCard";
import CollectionStrip from "@/components/CollectionStrip";
import FilmPhysicalCopyForm from "@/components/FilmPhysicalCopyForm";
import { getFilmDetail } from "@/lib/queries";
import { getJellyfinServerInfo, jellyfinPlayUrl } from "@/lib/jellyfin";

export default async function FilmPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const filmId = Number(id);
  if (!Number.isInteger(filmId)) notFound();

  const film = await getFilmDetail(filmId);
  if (!film) notFound();

  // Only build deep links when the server is actually reachable — no error
  // state in the UI, versions without a match simply get no button.
  const jellyfinServer = await getJellyfinServerInfo();
  // The in-app player is parked while playback moves to Jellyfin (see
  // PLAYBACK_PLAN.md, "Status"): shown only when IN_APP_PLAYBACK=1, which
  // scripts/e2e-playback.ts sets for its own server so the pipeline stays
  // tested.
  const showInAppPlay = process.env.IN_APP_PLAYBACK === "1";

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative">
        {film.backdropPath && (
          <div className="absolute inset-0 h-72 overflow-hidden sm:h-96">
            <Image
              src={`/api/poster/w780${film.backdropPath}`}
              alt=""
              fill
              priority
              className="scale-105 object-cover opacity-30 blur-sm"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-bg/40 via-bg/70 to-bg" />
          </div>
        )}

        <div className="relative mx-auto flex max-w-5xl flex-col gap-4 px-4 pt-6 sm:px-6">
          <Link
            href="/"
            className="w-fit text-xs font-medium text-text-muted hover:text-text"
          >
            ← Movies
          </Link>

          <div className="flex flex-col gap-6 pb-2 pt-4 sm:flex-row sm:pt-10">
            <PosterImage
              posterPath={film.posterPath}
              title={film.title}
              year={film.year}
              size="w780"
              priority
              sizes="(min-width: 640px) 224px, 55vw"
              className="aspect-2/3 w-40 shrink-0 rounded-lg border border-border-strong shadow-lg shadow-black/40 sm:w-56"
            />

            <div className="flex flex-1 flex-col gap-3 pt-1">
              <div>
                <h1 className="font-display text-4xl leading-none tracking-wide text-balance sm:text-5xl">
                  {film.title}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-text-muted">
                  <span>{film.year ?? "Year unknown"}</span>
                  {film.runtimeLabel !== "—" && (
                    <>
                      <span className="text-text-faint">·</span>
                      <span>{film.runtimeLabel}</span>
                    </>
                  )}
                  {film.rating !== null && (
                    <>
                      <span className="text-text-faint">·</span>
                      <span className="flex items-center gap-1 text-accent">
                        <svg
                          aria-hidden
                          viewBox="0 0 20 20"
                          className="h-3.5 w-3.5 fill-current"
                        >
                          <path d="M10 1.5l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z" />
                        </svg>
                        {film.rating.toFixed(1)}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {film.genres.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {film.genres.map((g) => (
                    <span
                      key={g}
                      className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-muted"
                    >
                      {g}
                    </span>
                  ))}
                </div>
              )}

              {film.overview && (
                <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
                  {film.overview}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 pb-16 pt-8 sm:px-6">
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-xl tracking-wide">
            Versions
            <span className="ml-2 font-mono text-xs font-normal text-text-faint">
              {film.versions.length}
            </span>
          </h2>
          {film.versions.length === 0 ? (
            <p className="text-sm text-text-faint">No files on disk for this film.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {film.versions.map((v) => (
                <VersionCard
                  key={v.id}
                  version={v}
                  filmTitle={film.title}
                  showPlay={showInAppPlay}
                  jellyfinHref={
                    v.jellyfinId && jellyfinServer ? jellyfinPlayUrl(v.jellyfinId, jellyfinServer.serverId) : null
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-display text-xl tracking-wide">Physical copies</h2>
          <div className="flex flex-wrap items-center gap-3">
            {(["DVD", "BLURAY", "UHD"] as const).map((medium) => (
              <FilmPhysicalCopyForm
                key={medium}
                filmId={film.id}
                medium={medium}
                initial={film.physicalCopies.find((c) => c.medium === medium) ?? null}
              />
            ))}
          </div>
        </section>

        {film.collection && (
          <CollectionStrip
            collectionId={film.collection.id}
            name={film.collection.name}
            members={film.collection.members}
            currentFilmId={film.id}
          />
        )}
      </div>
    </div>
  );
}
