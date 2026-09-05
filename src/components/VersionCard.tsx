import FormatBadge from "@/components/FormatBadge";
import ResolutionBadge from "@/components/ResolutionBadge";
import HdrBadge from "@/components/HdrBadge";
import PlayButton from "@/components/PlayButton";
import type { PlaybackSource } from "@/components/VideoPlayer";
import { audioBadge, audioFamily } from "@/lib/audio";
import type { VersionView } from "@/lib/queries";

// Quiet family tints for the audio codec chip — same visual register as
// FormatBadge/ResolutionBadge (small, uppercase, mono, 1px translucent
// border) but its own two hues so Dolby vs DTS is legible at a glance
// without shouting. Everything else (AAC, FLAC, PCM…) stays neutral.
const AUDIO_FAMILY_STYLES: Record<"dolby" | "dts" | "neutral", string> = {
  dolby: "border-audio-dolby-border bg-audio-dolby-bg text-audio-dolby",
  dts: "border-audio-dts-border bg-audio-dts-bg text-audio-dts",
  neutral: "border-border bg-bg-hover text-text-muted",
};

export default function VersionCard({
  version,
  filmTitle,
  playSource = null,
  audioTracks,
}: {
  version: VersionView;
  filmTitle: string;
  /** Which pipeline the in-app Play button uses, or null for no button.
   *  The film page's main Play button covers the usual single-version
   *  case; this per-version one is for films with several files. */
  playSource?: PlaybackSource | null;
  audioTracks?: { streamIdx: number; label: string }[];
}) {
  const specs: { label: string; value: string }[] = [
    { label: "Resolution", value: version.resolution },
    { label: "Codec", value: version.videoCodec ?? "—" },
    { label: "Container", value: version.container?.toUpperCase() ?? "—" },
    { label: "Size", value: version.sizeLabel },
    { label: "Duration", value: version.durationLabel },
  ];

  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <FormatBadge kind={version.format} className="px-2 py-1 text-[11px]" />
        <ResolutionBadge tier={version.tier} className="px-2 py-1 text-[11px]" />
        <HdrBadge videoRange={version.videoRange} className="px-2 py-1 text-[11px]" />
        {version.edition && (
          <span className="text-sm italic text-text-muted">{version.edition}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {playSource && (
            <PlayButton versionId={version.id} title={filmTitle} source={playSource} audioTracks={audioTracks} />
          )}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
        {specs.map((s) => (
          <div key={s.label}>
            <dt className="text-[10px] uppercase tracking-widest text-text-faint">{s.label}</dt>
            <dd className="mt-0.5 font-mono text-sm text-text">{s.value}</dd>
          </div>
        ))}
      </dl>

      {version.audioTracks.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 text-[10px] uppercase tracking-widest text-text-faint">
            Audio
          </p>
          <ul className="flex flex-col gap-1.5">
            {version.audioTracks.map((a) => {
              const { label, sublabel } = audioBadge(a.codec, a.profile, a.channels, a.layout);
              const family = audioFamily(label);
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest leading-none ${AUDIO_FAMILY_STYLES[family]}`}
                  >
                    {label}
                  </span>
                  {sublabel && (
                    <span className="font-mono text-[11px] text-text-muted">{sublabel}</span>
                  )}
                  <span className="font-mono text-[11px] text-text-faint">
                    {(a.language ?? "und").toUpperCase()}
                  </span>
                  {a.title && (
                    <span className="font-mono text-[11px] italic text-text-faint">{a.title}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
