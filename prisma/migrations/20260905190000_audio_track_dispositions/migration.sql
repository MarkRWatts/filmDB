-- AlterTable: ffprobe stream dispositions for audio-track selection
-- (see ProbedAudioTrack in src/lib/ffprobe.ts). Existing rows read as
-- false/false until the next forced scan re-probes them.
ALTER TABLE "AudioTrack" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AudioTrack" ADD COLUMN "isDescriptive" BOOLEAN NOT NULL DEFAULT false;
