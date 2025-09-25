// index.js — LINE bot with OpenRouter + human takeover + Redis-based user list

import express from "express";
import * as line from "@line/bot-sdk";
import { readFile } from "fs/promises";
import { getContext, setContext } from "./chatMemory.js";
import Redis from "ioredis";

const app = express();

// ---- ENV ----
const LINE_ACCESS_TOKEN = (process.env.LINE_ACCESS_TOKEN || "").trim();
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL = process.env.MODEL || "deepseek/deepseek-chat-v3.1";
const MODELS = (process.env.MODELS || `${MODEL},deepseek/deepseek-chat-v3-0324`)
  .split(",").map(s => s.trim()).filter(Boolean);

const SILENCE_MS = Number(process.env.SILENCE_MS || 15000);
const MAX_FRAGS = Number(process.env.MAX_FRAGS || 16);
const MAX_WINDOW_MS = Number(process.env.MAX_WINDOW_MS || 60000);
const OPENROUTER_MAX_CONCURRENCY = Number(process.env.OPENROUTER_MAX_CONCURRENCY || 2);
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 25000);
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const HUMAN_SILENCE_MINUTES = Number(process.env.HUMAN_SILENCE_MINUTES || 60);

// ---- Redis ----
const redis = new Redis(process.env.REDIS_URL);

// ---- LINE Config ----
const lineConfig = { channelAccessToken: LINE_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET };
const lineClient = new line.Client(lineConfig);

// ============================================================================
// Human takeover
// ============================================================================
const humanLive = new Map();
function setHumanLive(userId, minutes = HUMAN_SILENCE_MINUTES) {
  const until = Date.now() + minutes * 60_000;
  humanLive.set(userId, until);
  return until;
}
function clearHumanLive(userId) { humanLive.delete(userId); }
function isHumanLive(userId) {
  const until = humanLive.get(userId);
  if (!until) return false;
  if (Date.now() > until) { humanLive.delete(userId); return false; }
  return true;
}
function isAdmin(req) {
  const token = (req.headers["x-admin-token"] || "").toString().trim();
  return !!ADMIN_TOKEN && token === ADMIN_TOKEN;
}
app.post("/admin/takeover", express.json(), (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const { userId, minutes } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "missing userId" });
  const mins = Number.isFinite(Number(minutes)) ? Number(minutes) : HUMAN_SILENCE_MINUTES;
  const until = setHumanLive(userId, mins);
  res.json({ ok: true, until });
});
app.post("/admin/resume", express.json(), (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "missing userId" });
  clearHumanLive(userId);
  res.json({ ok: true });
});

// ============================================================================
// CSV product loading
// (same as your existing code … no changes needed here)
// ============================================================================
// ... keep your loadProducts(), detectProductGroup(), buildSystemPrompt(), etc.

// ============================================================================
// LINE Webhook
// ============================================================================
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).end();

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for (const ev of events) {
    try {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;

      const userId = ev?.source?.userId;
      const text = ev?.message?.text?.trim();
      if (!userId || !text) continue;

      console.log("IN:", { userId, text });

      // --- Save user profile in Redis ---
      try {
        const profile = await lineClient.getProfile(userId);
        await redis.set(`user:${userId}`, profile.displayName || "Unknown");
      } catch (e) {
        console.warn("Profile fetch failed:", e.message);
      }

      // --- NEW: /listusers command ---
      if (text === "/listusers") {
        const keys = await redis.keys("user:*");
        if (!keys.length) {
          await lineClient.replyMessage(ev.replyToken, { type: "text", text: "ยังไม่มีผู้ใช้ในระบบค่ะ" });
          continue;
        }
        const values = await Promise.all(keys.map(k => redis.get(k)));
        const users = keys.map((k, i) => `${values[i] || "Unknown"} (${k.replace("user:", "")})`);
        const output = "📋 Users:\n" + users.slice(0, 50).join("\n") +
          (users.length > 50 ? `\n...และอีก ${users.length - 50} คน` : "");
        await lineClient.replyMessage(ev.replyToken, { type: "text", text: output });
        continue;
      }

      // === Human takeover guard ===
      if (isHumanLive(userId)) {
        console.log("Silenced user → bot stays quiet:", userId);
        continue;
      }

      // === Continue with your fragment buffer + AI logic (unchanged) ===
      const history = await getContext(userId);
      pushFragment(userId, text, async (frags) => {
        let reply;
        try {
          reply = await answerOnceWithLLM(frags, history);
        } catch (e) {
          reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาโทร 088-277-0145 นะคะ 🙏";
        }
        for (const f of frags) history.push({ role: "user", content: f });
        history.push({ role: "assistant", content: reply });
        await setContext(userId, history);
        await lineClient.replyMessage(ev.replyToken, { type: "text", text: (reply || "").slice(0, 5000) });
      }, SILENCE_MS, MAX_WINDOW_MS, MAX_FRAGS);
    } catch (e) {
      console.error("Webhook handler error:", e?.message);
    }
  }
});

// Health check
app.get("/", (_req, res) => res.send("LINE bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadProducts().catch(err => console.error("Failed to load products.csv:", err?.message));
  console.log("Bot running on port", PORT);
});
