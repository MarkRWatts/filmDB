# MediaVault — Playback Plan (HLS + remote quality)

Why this exists: the current in-browser player serves a prepared film as one
fragmented MP4, streamed as it's written. That works on the LAN and fails in
exactly the ways remote testing found (Tailscale from hotel Wi-Fi):

- **No bitrate adaptation.** "Prepare" only fixes codec/container
  compatibility; the output is the source's full bitrate. A 1080p Blu-ray
  remux is 25–40 Mbps. No hotel link carries that, and no code polish
  changes it.
- **No seeking or reconnecting while preparing.** Range requests are
  ignored until the file is complete, so a dropped connection resumes with
  a 200 from byte 0 and the browser restarts or errors. A paused player
  holds an idle connection that hotel NATs drop.
- **Apple players need ranges or HLS.** AVPlayer (the tvOS handoff) and
  Safari are least happy with a length-less chunked MP4.

HLS fixes all three with one change of container: the same ffmpeg pass
writes a playlist plus short segments, every segment is an ordinary small
HTTP GET, seeking within what's written works from the first second, a
dropped connection just re-fetches a segment, and Safari/iOS/tvOS play it
natively. A second, lower-bitrate variant then gives remote viewers
something the link can carry.

The housekeeping that makes the cache trustworthy (orphan sweep, budget
that counts in-flight files, free-disk check, SIGTERM handling, longer
cancel grace) shipped separately — see `src/lib/video-cache.ts` — and is a
prerequisite: this plan reuses that accounting for directories instead of
single files.

## Design

### Output layout

Prepared output moves from `VIDEO_CACHE_DIR/<key>.mp4` to a directory:

```
VIDEO_CACHE_DIR/<key>/            e.g. film-42/ or film-42-remote/
  index.m3u8                      event playlist, grows as ffmpeg writes
  init.mp4                        fMP4 initialisation segment
  seg_00000.m4s … seg_NNNNN.m4s   ~6s fragments, keyframe-aligned
  .complete                       written by the app after ffmpeg exits 0
```

- `-f hls -hls_segment_type fmp4 -hls_time 6 -hls_playlist_type event
  -hls_flags independent_segments` on top of the existing stream mapping.
  An *event* playlist is the streaming-while-preparing story: players
  treat it as live-with-DVR (seek anywhere already written, follow the
  edge) until ffmpeg appends `#EXT-X-ENDLIST`, at which point it becomes
  plain VOD with full seeking. The fMP4 muxer options this app already
  learned the hard way (`delay_moov` for copied AC-3, `negative_cts_offsets`
  for B-frames, `-map_chapters -1`) carry over unchanged — they're the same
  muxer.
- The `.complete` marker replaces the `.partial → .mp4` rename as the
  "done" signal. A directory without the marker and without a live job is
  an orphan, same rule as today's partials.
- The cache budget counts a directory's total size; a directory with a live
  job is pinned. `makeRoomFor` and `enforceCacheLimit` get a directory-
  aware `readCacheEntries` and nothing else changes.

### Variants

Two per source, each its own cache key and its own ffmpeg pass:

| Variant | Key | Video | Audio | When |
|---|---|---|---|---|
| **Original** | `<kind>-<id>` | copy (or x264 for MPEG-2/VC-1, as today) | copy AAC/AC-3/E-AC-3, else AAC | Default; LAN, tvOS |
| **Remote** | `<kind>-<id>-remote` | x264 `scale=-2:720`, `-preset veryfast -crf 23 -maxrate 3M -bufsize 6M`, 2 threads | AAC stereo 128k | Chosen by the viewer |

Remote always transcodes, so it's CPU-bound on the VM: expect roughly
realtime-to-2× for a 1080p source on that box, which is fine for one
viewer streaming live and produces a cached copy for everyone after. It is
never chosen automatically — over Tailscale the server can't tell a hotel
from the sofa — but the player nudges toward it after repeated stalls (see
Player).

Direct-play files (already MP4/H.264/compatible audio) are unchanged: still
served straight from the share with byte ranges. HLS only replaces the
*prepared* tier.

### Routes

Films (`/api/video/[versionId]/…`) and scenes (`/api/adult-video/[sceneId]/…`)
get the same three additions, scenes behind `requireAdultAccessOrResponse`
as today:

- `GET hls/[variant]/index.m3u8` — self-starting like `/stream` today: kicks
  off the prepare if nothing's cached or running, waits for the playlist to
  hold at least one segment (bounded, ~10s), then serves it with
  `Cache-Control: no-store` (it changes as segments land) and
  `Content-Type: application/vnd.apple.mpegurl`.
- `GET hls/[variant]/[file]` — `init.mp4` and `seg_NNNNN.m4s`, validated
  against a strict filename pattern (no path components), served as
  `video/mp4` / `video/iso.segment` with byte-range support and a long
  `Cache-Control` (segments are immutable once written).
- `GET status` gains `variant` in its query and reports per variant.

`/stream` keeps serving direct-play files. Its "tailing" branch is removed
once HLS lands — the tailing reader and its tests stay for `/api/audio`,
which doesn't need any of this.

### Player

`VideoPlayer.tsx` picks a source by tier:

- **direct** → `<video src="/…/stream">` exactly as now.
- **prepared** → `/…/hls/<variant>/index.m3u8`. Safari, iOS and the tvOS
  WKWebView bridge play HLS natively (`canPlayType("application/
  vnd.apple.mpegurl")`); everything else loads `hls.js` (npm dependency,
  dynamically imported so it never ships to Safari) and attaches to the
  same `<video>`.
- **Quality control**: Original / Remote, in the player chrome, remembered
  per device in `localStorage`. Switching mid-play keeps the current time.
  After three `waiting` events within a minute on Original, a one-line hint
  offers Remote. Nothing switches on its own.
- **Native handoff** (`mediaVaultPlayer`) is handed the playlist URL instead
  of the stream URL — AVPlayer's preferred input, and the tvOS path finally
  works over the internet.
- Progress reporting and resume are time-based and unchanged.

### Migration

Existing `<key>.mp4` cache files are simply not recognised by the new
layout and get swept as unknown on first start (they're derivatives; the
next play re-prepares). Document a one-line cache clear in `DEPLOYMENT.md`
alongside the existing one, and expect the first play of each film after
deploy to prepare again.

### Explicitly not in this plan

- Multiple remote rungs / true adaptive bitrate (one 720p rung covers the
  realistic case: one viewer, one bad link).
- Subtitles (no subtitle tracks are mapped today either).
- Hardware encoding (the VM has no GPU).
- TV episodes — they reuse this module unchanged once episode playback
  lands (roadmap item 1); nothing here is film-specific except the keys.

## As implemented (deviations from the design above)

- **Viewer presence is request activity, not an open connection.** With
  HLS there's no long-lived response to watch for a disconnect, so every
  playlist/segment request for a key is "activity" and a running job with
  none for **10 minutes** is stopped (`IDLE_CANCEL_MS`). A paused player
  or a locked phone within that window costs nothing; a viewer who really
  left still stops a two-hour encode well before it finishes.
- **Resume during preparation waits for the encoder.** A saved position
  beyond what's been written is kept as a pending seek and applied as soon
  as the duration grows past it — instant for a remux, but for a transcode
  it means waiting for ffmpeg to reach that point. Starting the encode at
  the resume point (`-ss`) is the obvious follow-up and deliberately not
  in this pass.
- **`/stream` answers 409 for a file that needs preparing**, pointing at
  the HLS route; the player never sends that request (status tells it
  which to use), but an old cached client would get a clear error rather
  than a hang.
- **Quality control applies to direct-play files too**: "Remote" on an
  MP4/H.264 source simply prepares a 720p rendition of it. Only the
  Original of a direct-play file bypasses ffmpeg.
- **Keyframes are forced on segment boundaries** for every encode
  (`-force_key_frames expr:gte(t,n_forced*6)`); copied video keeps the
  source's keyframe cadence, as the design said.
- **The tailing reader is gone.** Nothing serves a file while it is being
  written any more — segments are complete files from the moment they
  appear in the playlist.
- **Native HLS is used only on Apple WebKit.** Chrome 152 answers "maybe"
  to `canPlayType("application/vnd.apple.mpegurl")` on the desktop, but
  its built-in support is partial; the player therefore takes hls.js on
  every non-Apple browser regardless of what `canPlayType` says, and the
  native `<video src>` path on Safari, iOS and the tvOS bridge.

## Known limitations

- **AC-3 audio in Chromium.** The Original variant copies AC-3/E-AC-3
  audio, which Safari, iOS and tvOS decode but Chrome and Firefox on
  macOS/Linux cannot (MediaSource reports `ac-3` unsupported). This is the
  same limit the old MP4 path had — the app is built around Apple players —
  and the Remote variant (AAC stereo) plays everywhere. If Chrome on the
  Mac turns out to matter, the follow-up is an AAC alternate audio
  rendition in the same playlist rather than a third variant.
- **Resume beyond the written edge waits for the encoder** (see above);
  `-ss` at the resume point is the follow-up.
- **VC-1 sources always pay the full video-transcode cost, even on
  Original.** Confirmed against a real title (Bourne Identity, VC-1
  1080p): since VC-1 isn't browser-playable, the "copy where possible"
  planning in `video-playback.ts` falls to `-c:v libx264 -preset veryfast
  -crf 18` the same way an MPEG-2 DVD source does — there's no faster
  "Original" tier for VC-1, only Original (transcoded) vs Remote
  (transcoded, smaller/720p). Same CPU-bound, watchable-but-slow-to-seek-
  ahead profile as the DVD MPEG-2 case above.

## Rollout phases

| Phase | Work | Est. |
|---|---|---|
| A ✅ | **Server: HLS output.** `buildFfmpegArgs` grows a target (`{ kind: "hls", dir }`) and a variant; `video-cache.ts` moves to directory entries with the `.complete` marker, orphan rule, and budget accounting; playlist + segment routes for films and scenes, self-starting playlist; `/stream` reduced to direct-play. Unit tests for args and filename validation; the real-ffmpeg integration test asserts a playlist, an init segment, ≥1 media segment, `ENDLIST` on completion, and the orphan/make-room behaviour on directories. | 1 day |
| B ✅ | **Player: native HLS or hls.js**, tier-based source selection, handoff URL change, quality control with per-device memory and the stall hint. Playwright e2e (Chromium → hls.js path) against a synthetic film: plays, seeks while preparing, switches quality preserving time. | 1 day |
| C ✅ | **Remote variant** args and key; status per variant; README/DEPLOYMENT notes (CPU expectation, cache-clear on deploy). | 0.5 day |
| D ⏳ | **Verification on real hardware**: Safari on the Mac and the iPhone over Tailscale from outside the LAN (the case that motivated this), tvOS handoff, a DVD-era MPEG-2 source (video transcode path), a Blu-ray remux with TrueHD (audio transcode path). | 0.5 day |

**Total ≈ 3 days.** A–C are done on this branch: 221 vitest tests
including the real-ffmpeg HLS integration test, plus
`scripts/e2e-playback.ts` (real Chrome, hls.js path: plays while
preparing, seeks backwards mid-encode, switches to Remote keeping the
position, direct play by byte range). D is the manual pass in
`docs/TEST_PLAN_2026-09.md`.

## What to watch for

- **Event playlists in hls.js** need `lowLatencyMode: false` and a sane
  `liveSyncDuration`; the default live-edge chasing is for real live
  streams and will make it stall waiting for the edge. Test seeking
  backwards during preparation specifically.
- **Event playlists in Apple's native player** (Safari, iOS, the tvOS
  WKWebView) are the harder case, and the one every play in an all-MKV
  library takes. Until ENDLIST lands the player treats the playlist as a
  live broadcast: duration is Infinity, playback starts near the newest
  segment, a seek past what it has fetched is clamped silently, and the
  controls show "Live Broadcast" with no timeline. Seen in production on
  5 Sep 2026 as a fresh play that froze on catching ffmpeg, a resume that
  landed ~20 minutes late, and a quality switch that fell back to 0:00.
  VideoPlayer.tsx now pins every native load to a pending seek (0 for a
  fresh play) and applies it only once the element's `seekable` range
  covers it, holding paused with a "preparing up to" note until then
  (src/lib/pending-seek.ts). The native controls still say "Live
  Broadcast" without a scrubber while a prepare is in flight — that label
  is the browser's, and only a finished playlist (or a switch to hls.js
  over MSE on Safari desktop, not done) changes it.
- **Stopping work nobody wants.** Every playlist/segment request re-arms a
  ten-minute idle timer on the job (a paused player or a VPN blip must not
  restart a two-hour transcode from byte 0). A deliberate close is a
  stronger signal: VideoPlayer sends `POST /leave?variant=` (keepalive) on
  unmount and for the outgoing variant on a quality switch, and the server
  drops that job's window to 30s (`noteViewerLeft`). Anyone else watching
  re-arms the full window with their next segment request. Seen before
  this existed: two abandoned prepares running for ten minutes each on
  5 Sep 2026.
- **Progress needs a real duration.** Native HLS reports duration =
  Infinity while a playlist is in flight, and reports were skipped
  without a finite duration -- so no film played on Safari/iOS during
  its prepare ever got a WatchProgress row (production had exactly one,
  for a title played after its cache completed). `/status` now returns
  the probed `durationSecs` and the player falls back to it.
- **`-hls_time` and keyframes**: for stream-copied video, segment
  boundaries land on source keyframes, so segments can be longer than 6s
  on sources with sparse keyframes (some Blu-ray encodes use 2–5s GOPs,
  fine; a few use much longer). `independent_segments` keeps them
  playable; the only cost is coarser seek granularity while preparing.
- **Two ffmpeg passes per film** if a viewer tries both variants — the
  budget accounting handles space; CPU is serialised by the existing
  one-job-per-key rule but two different keys *can* run concurrently.
  Acceptable for a household; a global concurrency cap of 2 is a one-line
  addition if it ever matters.
