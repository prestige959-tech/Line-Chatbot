// chatMemory.js
// Minimal Redis-backed chat memory + user registry.
// Requires: REDIS_URL (Railway), optional CHAT_TTL_SECONDS

import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.warn("[chatMemory] REDIS_URL is not set. Redis features will fail.");
}

export const redis = createClient({ url: redisUrl });

redis.on("error", (err) => {
  console.error("[chatMemory] Redis error:", err?.message || err);
});

// Connect once on module load (top-level await supported in ESM)
await (async () => {
  if (!redis.isOpen) {
    await redis.connect();
    console.log("[chatMemory] Connected to Redis");
  }
})();

// --- Chat context helpers (optional; keep if you already use them) ---
const TTL = Number(process.env.CHAT_TTL_SECONDS || 86400); // 1 day
const ctxKey = (userId) => `chat:${userId}`;

export async function getContext(userId) {
  if (!userId) return [];
  const raw = await redis.get(ctxKey(userId));
  return raw ? JSON.parse(raw) : [];
}

export async function setContext(userId, messages) {
  if (!userId) return;
  const trimmed = Array.isArray(messages) ? messages.slice(-10) : [];
  await redis.setEx(ctxKey(userId), TTL, JSON.stringify(trimmed));
}

// --- User registry helpers ---
const USERS_KEY = "users"; // Redis Set of user IDs

export async function addUserId(userId) {
  if (!userId) return 0;
  return redis.sAdd(USERS_KEY, userId);
}

export async function listUserIds() {
  const members = await redis.sMembers(USERS_KEY);
  // Stable output
  return members.sort((a, b) => a.localeCompare(b));
}

// Optional: wipe all remembered users (admin workflows)
export async function clearUsers() {
  return redis.del(USERS_KEY);
}
