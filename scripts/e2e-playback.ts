// End-to-end check of in-app video playback (PLAYBACK_PLAN.md) against a
// real browser: a throwaway SQLite database, two synthetic films under a
// scratch MOVIES_PATH, a `next dev` it starts and stops itself, and a
// Chromium-family browser driven by Playwright.
//
// Usage (from the repo root):
//
//   npx tsx scripts/e2e-playback.ts
//
// Env: E2E_PORT (default 3008); E2E_CHROMIUM to point at a browser binary.
// The browser MUST be able to decode H.264/AAC: Playwright's own Chromium
// build can't (no proprietary codecs), so on a Mac point E2E_CHROMIUM at
// Google Chrome, e.g.
//   E2E_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
// Sign-in is seeded straight into the database, same as e2e-passkey.ts.
//
// What it proves: a file that needs preparing plays as HLS via hls.js
// (this browser has no native HLS) starting within seconds; switching to
// Remote quality mid-play loads the remote playlist while ffmpeg is still
// encoding it and carries the position across; a direct-playable file
// plays from /stream with byte ranges and never touches HLS.

import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, closeSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

const PORT = Number(process.env.E2E_PORT ?? "3008");
const BASE = `http://localhost:${PORT}`;
const SECRET = randomBytes(32).toString("hex");
const USER_ID = "e2e-user";
const EMAIL = "e2e@example.com";

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
}

function sessionCookie(token: string): string {
  const sig = createHmac("sha256", SECRET).update(token).digest("base64");
  return encodeURIComponent(`${token}.${sig}`);
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "pipe" });
}

function startNextDev(dir: string, dbUrl: string): { child: ChildProcess; logPath: string } {
  const logPath = path.join(dir, "next-dev.log");
  const log = openSync(logPath, "a");
  const child = spawn("npx", ["next", "dev", "-p", String(PORT), "-H", "localhost"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: BASE,
      ALLOWED_EMAILS: "",
      RESEND_API_KEY: "",
      MOVIES_PATH: path.join(dir, "movies"),
      // The in-app Play button is parked in production; this suite is what
      // keeps the pipeline behind it working.
      IN_APP_PLAYBACK: "1",
      TVSHOWS_PATH: "",
      MUSIC_PATH: "",
      ADULT_PATH: "",
      POSTER_CACHE_DIR: path.join(dir, "posters"),
      VIDEO_CACHE_DIR: path.join(dir, "video-cache"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  return { child, logPath };
}

function stopNextDev(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/signin`, { redirect: "manual" });
      if (res.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`next dev on ${BASE} didn't become ready within 120s`);
}

async function seed(prisma: PrismaClient, movies: string): Promise<{ token: string; remuxFilmId: number; directFilmId: number }> {
  const now = new Date();
  await prisma.user.create({ data: { id: USER_ID, name: "E2E Person", email: EMAIL, emailVerified: true } });
  await prisma.household.create({ data: { id: "e2e-household", name: "E2E household", slug: "e2e-household", createdAt: now } });
  await prisma.member.create({
    data: { id: "e2e-member", householdId: "e2e-household", userId: USER_ID, role: "owner", createdAt: now },
  });
  const token = randomBytes(24).toString("base64url");
  await prisma.session.create({
    data: {
      id: `sess-${token.slice(0, 8)}`,
      token,
      userId: USER_ID,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
    },
  });

  // 1. Needs preparing: H.264 + AAC in MKV -- the container alone forces a
  //    remux. (AAC rather than the AC-3 most of the library carries because
  //    Chromium can't decode AC-3 through MediaSource on Linux/macOS; that
  //    limitation is the same with or without HLS and is covered by the
  //    manual plan on Safari.) 720p and 60s so the remote encode takes long
  //    enough to be observed mid-write.
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=duration=60:size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "50",
    "-c:a", "aac", "-shortest",
    path.join(movies, "Remux Film (2021).mkv"),
  ]);
  const remux = await prisma.film.create({
    data: {
      title: "Remux Film",
      sortTitle: "remux film",
      year: 2021,
      owned: true,
      versions: {
        create: {
          filePath: "Remux Film (2021).mkv",
          fileName: "Remux Film (2021).mkv",
          format: "BLURAY",
          width: 1280,
          height: 720,
          videoCodec: "h264",
          container: "mkv",
          durationSecs: 60,
          audioTracks: { create: [{ streamIdx: 1, codec: "aac", channels: 2 }] },
        },
      },
    },
  });

  // 2. Direct-playable: H.264 + AAC in MP4.
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=duration=20:size=640x360:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=20",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", "-shortest",
    path.join(movies, "Direct Film (2022).mp4"),
  ]);
  const direct = await prisma.film.create({
    data: {
      title: "Direct Film",
      sortTitle: "direct film",
      year: 2022,
      owned: true,
      versions: {
        create: {
          filePath: "Direct Film (2022).mp4",
          fileName: "Direct Film (2022).mp4",
          format: "BLURAY",
          width: 640,
          height: 360,
          videoCodec: "h264",
          container: "mp4",
          durationSecs: 20,
          audioTracks: { create: [{ streamIdx: 1, codec: "aac", channels: 2 }] },
        },
      },
    },
  });
  return { token, remuxFilmId: remux.id, directFilmId: direct.id };
}

async function newContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE });
  await context.addCookies([
    { name: "better-auth.session_token", value: sessionCookie(token), domain: "localhost", path: "/" },
  ]);
  return context;
}

/** Collects request URLs (pathname+search) so the tests can assert which
 *  routes the player actually used. */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin === BASE) seen.push(u.pathname + u.search);
  });
  return seen;
}

async function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => (document.querySelector("video") as HTMLVideoElement | null)?.currentTime ?? -1);
}

async function waitForTimeAbove(page: Page, secs: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let t = -1;
  while (Date.now() < deadline) {
    t = await currentTime(page);
    if (t > secs) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return t;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "mediavault-e2e-playback-"));
  for (const sub of ["movies", "posters", "video-cache"]) mkdirSync(path.join(dir, sub));
  const dbUrl = `file:${path.join(dir, "e2e.db")}`;
  execSync("npx prisma migrate deploy", { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" });
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  const { token, remuxFilmId, directFilmId } = await seed(prisma, path.join(dir, "movies"));

  const { child, logPath } = startNextDev(dir, dbUrl);
  let browser: Browser | null = null;
  try {
    await waitForServer();
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.E2E_CHROMIUM || undefined,
      args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"],
    });

    // ---- A. A file that needs preparing plays as HLS (via hls.js here)
    const ctxA = await newContext(browser, token);
    const page = await ctxA.newPage();
    page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
    const requests = recordRequests(page);
    const codecs = await page.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028,mp4a.40.2"'));
    check("browser can decode H.264/AAC (else nothing below is meaningful)", codecs);

    await page.goto(`/film/${remuxFilmId}`);
    await page.getByRole("button", { name: "Play" }).first().click();
    await page.locator("video").waitFor({ timeout: 20_000 });
    const tA = await waitForTimeAbove(page, 2, 40_000);
    check("prepared file starts playing within seconds", tA > 2, `currentTime ${tA.toFixed(1)}s`);
    check("player fetched the original HLS playlist", requests.some((u) => u.endsWith("/hls/original/index.m3u8")));
    check("player fetched HLS segments", requests.some((u) => /\/hls\/original\/seg_\d{5}\.m4s$/.test(u)));
    check("player never used /stream for a prepared file", !requests.some((u) => u.endsWith("/stream")));
    check("Quality control shows Original", (await page.getByLabel("Playback quality").inputValue()) === "original");

    // ---- B. Switch to Remote mid-play: remote playlist while still encoding, position carried over
    const before = await currentTime(page);
    await page.getByLabel("Playback quality").selectOption("remote");
    const remotePlaylistSeen = async () => requests.some((u) => u.endsWith("/hls/remote/index.m3u8"));
    const deadline = Date.now() + 40_000;
    while (!(await remotePlaylistSeen()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    check("switching quality requests the remote playlist", await remotePlaylistSeen());
    const remotePlaylist = await ctxA.request.get(`/api/video/${remuxFilmId}/hls/remote/index.m3u8`);
    const remoteText = await remotePlaylist.text();
    check("remote playlist is served while the encode is still running (event playlist, no ENDLIST yet)",
      remotePlaylist.status() === 200 && remoteText.includes("#EXT-X-PLAYLIST-TYPE:EVENT") && !remoteText.includes("#EXT-X-ENDLIST"),
      `status ${remotePlaylist.status()}, ${remoteText.split("#EXTINF").length - 1} segment(s) so far`);
    const tB = await waitForTimeAbove(page, before + 1, 60_000);
    check("playback continues on Remote from about where it was", tB > before + 1 && tB >= before - 6, `from ${before.toFixed(1)}s to ${tB.toFixed(1)}s`);
    check("Remote fetched remote segments", requests.some((u) => /\/hls\/remote\/seg_\d{5}\.m4s$/.test(u)));
    // Seek backwards while the encode is still running: an event playlist
    // must let the viewer go back over what's already written rather than
    // chase the live edge.
    await page.evaluate(() => { (document.querySelector("video") as HTMLVideoElement).currentTime = 1; });
    const afterSeekStart = await currentTime(page);
    const tSeek = await waitForTimeAbove(page, 2.5, 30_000);
    check("seeking backwards while preparing plays on from there", afterSeekStart < before && tSeek > 2.5 && tSeek < before + 5,
      `seeked to ${afterSeekStart.toFixed(1)}s, now ${tSeek.toFixed(1)}s`);
    check("quality choice remembered per device", (await page.evaluate(() => localStorage.getItem("mv-video-quality"))) === "remote");
    // Closing must actually stop the element: a <video> left with a live
    // src keeps fetching after it leaves the DOM (WebKit especially), which
    // keeps the server's ffmpeg job alive for nobody.
    const beforeClose = requests.length;
    await page.getByRole("button", { name: "Close" }).click();
    await new Promise((r) => setTimeout(r, 4000));
    const afterClose = requests.slice(beforeClose).filter((u) => u.includes("/hls/"));
    check("closing the player stops HLS fetches", afterClose.length === 0, afterClose.length ? `still fetched ${afterClose.slice(0, 3).join(", ")}` : "none in 4s");
    // ... and tells the server it left, so a still-running job isn't kept
    // for the full idle window (the player was on Remote at this point).
    check("closing the player sends the leave beacon for its variant", requests.slice(beforeClose).some((u) => u.endsWith("/leave?variant=remote")));
    check("switching quality sent a leave for the outgoing variant", requests.some((u) => u.endsWith("/leave?variant=original")));
    await ctxA.close();

    // ---- C. A direct-playable file plays from /stream with byte ranges, never HLS
    const ctxC = await newContext(browser, token);
    const pageC = await ctxC.newPage();
    pageC.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
    const requestsC = recordRequests(pageC);
    const statuses: number[] = [];
    pageC.on("response", (r) => {
      if (new URL(r.url()).pathname.endsWith("/stream")) statuses.push(r.status());
    });
    await pageC.goto(`/film/${directFilmId}`);
    await pageC.getByRole("button", { name: "Play" }).first().click();
    await pageC.locator("video").waitFor({ timeout: 20_000 });
    const tC = await waitForTimeAbove(pageC, 2, 30_000);
    check("direct-play file plays", tC > 2, `currentTime ${tC.toFixed(1)}s`);
    check("direct play used /stream", requestsC.some((u) => u.endsWith("/stream")));
    check("direct play served byte ranges (206)", statuses.includes(206), `statuses ${statuses.join(",")}`);
    check("direct play never touched HLS", !requestsC.some((u) => u.includes("/hls/")));
    await ctxC.close();

    // ---- D. Server-side state after all that
    const cacheEntries = execSync(`ls -1 ${path.join(dir, "video-cache")}`).toString().trim().split("\n").sort();
    check("cache holds exactly the original and remote entries for the prepared film",
      JSON.stringify(cacheEntries) === JSON.stringify([`film-${remuxFilmId}`, `film-${remuxFilmId}-remote`].sort()), cacheEntries.join(","));
  } catch (err) {
    failures++;
    console.error("\nRun aborted:", err instanceof Error ? err.message : err);
    console.error(`\n--- tail of ${logPath} ---`);
    console.error(readFileSync(logPath, "utf8").split("\n").slice(-40).join("\n"));
  } finally {
    await browser?.close();
    stopNextDev(child);
    await prisma.$disconnect();
  }

  if (failures === 0) {
    rmSync(dir, { recursive: true, force: true });
    console.log("\nALL PASSED");
    process.exit(0);
  }
  console.log(`\n${failures} FAILED — scratch dir kept for inspection: ${dir}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
