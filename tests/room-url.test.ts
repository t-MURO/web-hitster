import assert from "node:assert/strict";
import test from "node:test";
import {
  inviteCodeFromPath,
  normalizeRoomCode,
  roomInviteUrl,
  roomPath,
} from "../src/room-url.js";

test("room codes become canonical invite paths", () => {
  assert.equal(normalizeRoomCode(" a-bc12 "), "ABC12");
  assert.equal(roomPath("abc12"), "/room/ABC12");
});

test("invite codes are recovered from room URLs", () => {
  assert.equal(inviteCodeFromPath("/room/j7k4q"), "J7K4Q");
  assert.equal(inviteCodeFromPath("/room/J7K4Q/"), "J7K4Q");
  assert.equal(inviteCodeFromPath("/room/TOO-LONG"), null);
  assert.equal(inviteCodeFromPath("/"), null);
});

test("full invite links use the public origin", () => {
  assert.equal(
    roomInviteUrl("j7k4q", "https://music.example.com"),
    "https://music.example.com/room/J7K4Q",
  );
});
