import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MediaLibrary,
  type MediaCommandRunner,
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

test("prepared MP3 files are isolated by room and deleted with the room", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "webstar-media-test-"));
  const root = path.join(parent, "audio");
  t.after(async () => rm(parent, { recursive: true, force: true }));

  const run: MediaCommandRunner = async (_executable, arguments_) => {
    const outputIndex = arguments_.indexOf("--output");
    const template = arguments_[outputIndex + 1];
    assert.ok(template);
    const filePath = template.replace("%(ext)s", "mp3");
    await writeFile(filePath, Buffer.from("test-mp3-bytes"));
    return { stdout: `youtube-id\n${filePath}\n`, stderr: "" };
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
  assert.equal(prepared.youtubeVideoId, "youtube-id");
  assert.equal((await stat(prepared.filePath)).isFile(), true);

  await media.cleanupRoom("ABCDE");
  assert.equal(media.get("ABCDE", "one"), null);
  await assert.rejects(() => stat(prepared.filePath));
});
