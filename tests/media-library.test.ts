import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MediaLibrary,
  type MediaCommandRunner,
  selectYouTubeCandidate,
  type YouTubeCandidate,
} from "../server/media-library.js";
import type { Track } from "../shared/types.js";

function track(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    year: 1999,
    originalYear: 1999,
    coverUrl: null,
    audioCue: `spotify:${id}`,
  };
}

test("YouTube matching prefers the close studio recording over risky variants", () => {
  const source: Track = {
    ...track("match"),
    title: "Electric Feel",
    artist: "MGMT",
    durationMs: 229_000,
  };
  const candidates: YouTubeCandidate[] = [
    {
      id: "karaoke01",
      title: "Electric Feel karaoke instrumental",
      duration: 230,
      uploader: "Karaoke Channel",
      liveStatus: null,
    },
    {
      id: "official01",
      title: "MGMT - Electric Feel (Official Audio)",
      duration: 229,
      uploader: "MGMT - Topic",
      liveStatus: null,
    },
    {
      id: "concert01",
      title: "MGMT Electric Feel live",
      duration: 310,
      uploader: "Concert Archive",
      liveStatus: null,
    },
  ];

  assert.equal(
    selectYouTubeCandidate(source, candidates)?.id,
    "official01",
  );
  assert.equal(
    selectYouTubeCandidate(source, [
      {
        id: "unrelated1",
        title: "Completely Different Song",
        duration: 500,
        uploader: "Another Artist",
        liveStatus: null,
      },
    ]),
    null,
  );
});

test("prepared MP3 files are isolated by room and deleted with the room", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "webstar-media-test-"));
  const root = path.join(parent, "audio");
  t.after(async () => rm(parent, { recursive: true, force: true }));

  const run: MediaCommandRunner = async (_executable, arguments_) => {
    if (arguments_.includes("--dump-single-json")) {
      const query = arguments_.at(-1) ?? "";
      const title = /Song\s+\w+/i.exec(query)?.[0] ?? "Song one";
      return {
        stdout: JSON.stringify({
          entries: [
            {
              id: "youtube01",
              title: `${title} Artist official audio`,
              duration: 180,
              uploader: "Artist - Topic",
            },
          ],
        }),
        stderr: "",
      };
    }
    const outputIndex = arguments_.indexOf("--output");
    const template = arguments_[outputIndex + 1];
    assert.ok(template);
    const filePath = template.replace("%(ext)s", "mp3");
    await writeFile(filePath, Buffer.from("test-mp3-bytes"));
    return { stdout: `${filePath}\n`, stderr: "" };
  };
  const media = new MediaLibrary({
    root,
    run,
    concurrency: 2,
  });
  await media.initialize();

  const results: string[] = [];
  await media.preparePlaylist({
    roomCode: "ABCDE",
    tracks: [track("one"), track("two")],
    onResult: ({ track: preparedTrack, error }) => {
      assert.equal(error, null);
      results.push(preparedTrack.id);
    },
  });

  assert.deepEqual(results.sort(), ["one", "two"]);
  const prepared = media.get("ABCDE", "one");
  assert.ok(prepared);
  assert.equal(prepared.youtubeVideoId, "youtube01");
  assert.equal((await stat(prepared.filePath)).isFile(), true);

  await media.prepareAdditional({
    roomCode: "ABCDE",
    tracks: [track("three")],
    onResult: ({ error }) => assert.equal(error, null),
  });
  assert.ok(media.get("ABCDE", "one"));
  assert.ok(media.get("ABCDE", "three"));

  await media.cleanupRoom("ABCDE");
  assert.equal(media.get("ABCDE", "one"), null);
  await assert.rejects(() => stat(prepared.filePath));
});

test("generated hosted audio needs ffmpeg but no Spotify or YouTube access", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "webstar-demo-test-"));
  const root = path.join(parent, "audio");
  t.after(async () => rm(parent, { recursive: true, force: true }));

  const run: MediaCommandRunner = async (executable, arguments_) => {
    assert.equal(executable, "ffmpeg");
    const filePath = arguments_.at(-1);
    if (!filePath?.endsWith(".mp3")) {
      throw new Error("Expected an MP3 output path.");
    }
    await writeFile(filePath, Buffer.from("generated-tone"));
    return { stdout: "", stderr: "" };
  };
  const media = new MediaLibrary({ root, run });
  await media.initialize();
  await media.prepareGeneratedPlaylist({
    roomCode: "DEMO1",
    tracks: [track("tone")],
    onResult: ({ error }) => assert.equal(error, null),
  });

  assert.ok(media.get("DEMO1", "tone"));
});

test("media diagnostics report missing tools without preventing server startup", async (t) => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "webstar-diagnostics-test-"),
  );
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const run: MediaCommandRunner = async (executable) => {
    if (executable === "yt-dlp") {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }
    return { stdout: "ffmpeg version 8.1\n", stderr: "" };
  };
  const media = new MediaLibrary({
    root: path.join(parent, "audio"),
    run,
  });

  const diagnostics = await media.diagnostics();

  assert.equal(diagnostics.youtubeDownloader.available, false);
  assert.match(
    diagnostics.youtubeDownloader.message ?? "",
    /not installed/,
  );
  assert.equal(diagnostics.ffmpeg.available, true);
  assert.equal(diagnostics.ffmpeg.version, "ffmpeg version 8.1");
});
