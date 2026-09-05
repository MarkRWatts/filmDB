"use client";

// Small client island so VersionCard (an async server component's child) can
// open the in-app player without converting the whole card to "use client".

import { useState } from "react";
import VideoPlayer, { type PlaybackSource } from "@/components/VideoPlayer";

export default function PlayButton({
  versionId,
  title,
  source = "local",
}: {
  versionId: number;
  title: string;
  source?: PlaybackSource;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-bright/10 px-2.5 py-1 text-[11px] font-medium tracking-wide text-accent-bright transition-colors hover:bg-accent-bright/20"
      >
        <svg aria-hidden viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current">
          <path d="M2.5 1.2c0-.55.6-.9 1.08-.62l6.2 3.8c.46.28.46.94 0 1.22l-6.2 3.8c-.48.28-1.08-.07-1.08-.62V1.2z" />
        </svg>
        Play
      </button>
      {open && <VideoPlayer versionId={versionId} title={title} source={source} onClose={() => setOpen(false)} />}
    </>
  );
}
