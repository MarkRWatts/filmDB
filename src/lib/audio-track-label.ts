// One-line label for an audio track in the player's Audio dropdown:
// "DTS-HD MA 7.1 · English · Surround 7.1". Codec/channel wording comes
// from audioBadge (the same as the film page's chips); the title is the
// container's own name for the track, which is often the only thing that
// tells a commentary or an audio-description track from the main mix.

import { audioBadge } from "@/lib/audio";

const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English",
  fra: "French",
  fre: "French",
  deu: "German",
  ger: "German",
  spa: "Spanish",
  ita: "Italian",
  jpn: "Japanese",
  por: "Portuguese",
  rus: "Russian",
  kor: "Korean",
  zho: "Chinese",
  chi: "Chinese",
  hin: "Hindi",
  nld: "Dutch",
  dut: "Dutch",
  swe: "Swedish",
  dan: "Danish",
  nor: "Norwegian",
  fin: "Finnish",
  pol: "Polish",
  ces: "Czech",
  cze: "Czech",
  hun: "Hungarian",
  tur: "Turkish",
  ara: "Arabic",
  heb: "Hebrew",
  tha: "Thai",
};

export function languageName(code: string | null): string | null {
  if (!code) return null;
  const lower = code.toLowerCase();
  if (lower === "und") return null;
  return LANGUAGE_NAMES[lower] ?? code.toUpperCase();
}

export interface AudioTrackLabelInput {
  codec: string | null;
  profile: string | null;
  channels: number | null;
  layout: string | null;
  language: string | null;
  title: string | null;
}

export function audioTrackLabel(t: AudioTrackLabelInput): string {
  const { label, sublabel } = audioBadge(t.codec, t.profile, t.channels, t.layout);
  const parts = [sublabel ? `${label} ${sublabel}` : label];
  const lang = languageName(t.language);
  if (lang) parts.push(lang);
  if (t.title && t.title.trim() && t.title.trim().toLowerCase() !== (sublabel ?? "").toLowerCase()) parts.push(t.title.trim());
  return parts.join(" · ");
}
