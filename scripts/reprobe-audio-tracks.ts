// One-off backfill for AudioTrack.isDefault / isDescriptive (the ffprobe
// stream dispositions added on 2026-09-05 so pickAudioTrack stops choosing
// an audio-description track as the main soundtrack). Re-probes every owned
// film Version that has audio tracks on record and writes just those two
// flags back, matched by streamIdx — no full rescan, nothing else touched.
// Idempotent; safe to re-run.
//
// Usage (locally, or on the VM inside the container):
//   npx tsx scripts/reprobe-audio-tracks.ts
//   docker compose exec app npx tsx scripts/reprobe-audio-tracks.ts
//
// Needs MOVIES_PATH and either ffprobe on PATH or FFPROBE_DOCKER_IMAGE, the
// same as the scanner.

import "dotenv/config";
import path from "node:path";
import { prisma } from "@/lib/db";
import { probe } from "@/lib/ffprobe";

async function main(): Promise<void> {
  const root = process.env.MOVIES_PATH;
  if (!root) throw new Error("MOVIES_PATH is not set");

  const versions = await prisma.version.findMany({
    where: { film: { owned: true }, audioTracks: { some: {} } },
    select: { id: true, filePath: true, audioTracks: { select: { id: true, streamIdx: true, isDefault: true, isDescriptive: true } } },
    orderBy: { id: "asc" },
  });
  console.log(`${versions.length} version(s) with audio tracks`);

  let probed = 0;
  let changed = 0;
  let failed = 0;
  for (const v of versions) {
    const absPath = path.resolve(root, v.filePath);
    let result;
    try {
      result = await probe(absPath);
    } catch (err) {
      failed++;
      console.log(`  ! ${v.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    probed++;
    for (const t of result.audioTracks) {
      const row = v.audioTracks.find((r) => r.streamIdx === t.streamIdx);
      if (!row || (row.isDefault === t.isDefault && row.isDescriptive === t.isDescriptive)) continue;
      await prisma.audioTrack.update({
        where: { id: row.id },
        data: { isDefault: t.isDefault, isDescriptive: t.isDescriptive },
      });
      changed++;
      console.log(`  ${v.filePath} #${t.streamIdx}: default=${t.isDefault} descriptive=${t.isDescriptive}`);
    }
  }
  console.log(`probed ${probed}, updated ${changed} track row(s), ${failed} file(s) failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
