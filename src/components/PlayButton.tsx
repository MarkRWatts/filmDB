"use client";

// Small client island so a server component (VersionCard, the film page's
// action row) can open the in-app player without becoming "use client".

import { useState } from "react";
import { Play } from "lucide-react";
import VideoPlayer, { type PlaybackSource } from "@/components/VideoPlayer";

export default function PlayButton({
  versionId,
  title,
  source = "local",
  audioTracks,
  size = "sm",
}: {
  versionId: number;
  title: string;
  source?: PlaybackSource;
  audioTracks?: { streamIdx: number; label: string }[];
  /** "sm" is the per-version chip; "lg" is the film page's main button. */
  size?: "sm" | "lg";
}) {
  const [open, setOpen] = useState(false);

  const className =
    size === "lg"
      ? "inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-bright/15 px-5 py-2.5 text-sm font-semibold tracking-wide text-accent-bright transition-colors hover:bg-accent-bright/25"
      : "inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-bright/10 px-2.5 py-1 text-[11px] font-medium tracking-wide text-accent-bright transition-colors hover:bg-accent-bright/20";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={`Play ${title}`} className={className}>
        <Play aria-hidden className={size === "lg" ? "h-4 w-4 fill-current" : "h-2.5 w-2.5 fill-current"} />
        Play
      </button>
      {open && (
        <VideoPlayer versionId={versionId} title={title} source={source} audioTracks={audioTracks} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
