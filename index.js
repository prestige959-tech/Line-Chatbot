// index.js — LINE bot with single OpenRouter call per batch, env-wired batching, 429 backoff,
// simple concurrency limiter, AND human-takeover silence mode with Railway admin endpoints.

import express from "express";
import * as line from "@line/bot-sdk"; // correct: no default export
import { readFile } from "fs/promises";
import { getContext, setContext, getAllUserIds, getUsersWithProfiles } from "./chatMemory.js";

const app = express();

// ---- ENV ----
const LINE_ACCESS_TOKEN = (process.env.LINE_ACCESS_TOKEN || "").trim();
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL = process.env.MODEL || "deepseek/deepseek-chat-v3.1";
const MODELS = (process.env.MODELS || `${MODEL},deepseek/deepseek-chat-v3-0324`)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const SILENCE_MS = Number(process.env.SILENCE_MS || 15000);
const MAX_FRAGS = Number(process.env.MAX_FRAGS || 16);
const MAX_WINDOW_MS = Number(process.env.MAX_WINDOW_MS || 60000);
const OPENROUTER_MAX_CONCURRENCY = Number(process.env.OPENROUTER_MAX_CONCURRENCY || 2);
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 25000);

// How long to silence when taking over (minutes)
const HUMAN_SILENCE_MINUTES = Number(process.env.HUMAN_SILENCE_MINUTES || 60);

const mask = s =>
  !s ? "(empty)" : s.replace(/\s+/g, "").slice(0, 4) + "..." + s.replace(/\s+/g, "").slice(-4);
console.log("ENV → LINE_ACCESS_TOKEN:", mask(LINE_ACCESS_TOKEN));
console.log("ENV → LINE_CHANNEL_SECRET:", mask(LINE_CHANNEL_SECRET));
console.log("ENV → OPENROUTER_API_KEY:", mask(OPENROUTER_API_KEY));
console.log("ENV → MODEL:", MODEL);
console.log("ENV → MODELS:", MODELS.join(", "));
console.log("ENV → SILENCE_MS:", SILENCE_MS, "MAX_FRAGS:", MAX_FRAGS, "MAX_WINDOW_MS:", MAX_WINDOW_MS);
console.log("ENV → OPENROUTER_MAX_CONCURRENCY:", OPENROUTER_MAX_CONCURRENCY);
console.log("ENV → HUMAN_SILENCE_MINUTES:", HUMAN_SILENCE_MINUTES);

if (!LINE_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.warn("⚠️ Missing LINE credentials — webhook will not work correctly.");
}
if (!OPENROUTER_API_KEY) {
  console.warn("⚠️ Missing OPENROUTER_API_KEY — model calls will fail.");
}

const lineConfig = {
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// ---- Small helpers ----
function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ \t\r\n]/g, "")
    .replace(/[.,;:!?'"“”‘’(){}\[\]<>|/\\\-_=+]/g, "");
}
function tokens(s) {
  const t = (s || "").toLowerCase();
  const m = t.match(/[#]?\d+|[a-zA-Zก-๙]+/g);
  return m || [];
}

// ============================================================================
// NEW: Human-takeover (silence mode) — per-user flag + Railway admin endpoints
// ============================================================================

/** userId -> silence-until timestamp (ms) */
const humanLive = new Map();

/** userId -> menu session state */
const menuSessions = new Map();

function setHumanLive(userId, minutes = HUMAN_SILENCE_MINUTES) {
  const until = Date.now() + minutes * 60_000;
  humanLive.set(userId, until);
  return until;
}
function clearHumanLive(userId) {
  humanLive.delete(userId);
}
function isHumanLive(userId) {
  const until = humanLive.get(userId);
  if (!until) return false;
  if (Date.now() > until) { humanLive.delete(userId); return false; }
  return true;
}


// ---- CSV load & product index (with aliases/tags/spec/pcs_per_bundle) ----
let PRODUCTS = [];
let NAME_INDEX = new Map(); // kept for potential debug/admin

async function loadProducts() {
  let csv = await readFile(new URL("./products.csv", import.meta.url), "utf8");

  // minimal CSV parser
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < csv.length) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      } else { field += c; i++; continue; }
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      field += c; i++; continue;
    }
  }
  row.push(field); rows.push(row);

  if (!rows.length) {
    console.warn("products.csv appears empty.");
    PRODUCTS = [];
    NAME_INDEX = new Map();
    return;
  }

  const header = rows[0].map(h => h.trim().toLowerCase());
  const nameIdx    = header.findIndex(h => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx   = header.findIndex(h => ["price","ราคา","amount","cost"].includes(h));
  const unitIdx    = header.findIndex(h => ["unit","หน่วย","ยูนิต"].includes(h));
  const aliasIdx   = header.findIndex(h => ["aliases","alias","aka","synonyms","คำพ้อง","ชื่อเรียก","อีกชื่อ"].includes(h));
  const tagsIdx    = header.findIndex(h => ["tags","tag","หมวด","หมวดหมู่","ประเภท","คีย์เวิร์ด","keywords","keyword"].includes(h));
  const specIdx    = header.findIndex(h => ["specification","specifications","dimension","dimensions","ขนาด","สเปค","รายละเอียด"].includes(h));
  const bundleIdx  = header.findIndex(h => ["pcs_per_bundle","pieces_per_bundle","pieces/bundle","pcs/bundle","bundle_pcs","จำนวนต่อมัด","ชิ้นต่อมัด","แผ่นต่อมัด","แท่งต่อมัด","ชิ้น/มัด","ต่อมัด"].includes(h));

  PRODUCTS = [];
  NAME_INDEX = new Map();

  const addIndex = (key, item) => {
    const k = norm(key);
    if (!k) return;
    if (!NAME_INDEX.has(k)) NAME_INDEX.set(k, item);
  };

  const splitList = (s) => (s || "")
    .split(/;|,|\||\/|。|、|·/g)
    .map(x => x.trim())
    .filter(Boolean);

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rawName     = (cols[nameIdx   !== -1 ? nameIdx   : 0] || "").trim();
    const rawPrice    = (cols[priceIdx  !== -1 ? priceIdx  : 1] || "").trim();
    const rawUnit     = (cols[unitIdx   !== -1 ? unitIdx   : 2] || "").trim();
    const rawAliases  = aliasIdx  !== -1 ? (cols[aliasIdx]  || "") : "";
    const rawTags     = tagsIdx   !== -1 ? (cols[tagsIdx]   || "") : "";
    const rawSpec     = specIdx   !== -1 ? (cols[specIdx]   || "").trim() : "";
    const rawBundle   = bundleIdx !== -1 ? (cols[bundleIdx] || "").trim() : "";

    if (!rawName) continue;

    const aliases = splitList(rawAliases);
    const tags    = splitList(rawTags);

    const price = Number(String(rawPrice).replace(/[^\d.]/g, ""));
    const n = norm(rawName);
    const kw = Array.from(new Set([
      ...tokens(rawName),
      ...aliases.flatMap(a => tokens(a)),
      ...tags.flatMap(t => tokens(t)),
      ...tokens(rawSpec),
      ...tokens(rawBundle),
    ]));

    const codeMatch = rawName.match(/#\s*(\d+)/);
    const num = codeMatch ? codeMatch[1] : null;

    // parse bundle into number if possible
    const piecesPerBundle = (() => {
      const v = Number(String(rawBundle).replace(/[^\d.]/g, ""));
      return Number.isFinite(v) && v > 0 ? v : null;
    })();

    const searchText = [rawName, ...aliases, ...tags, rawSpec, rawBundle].join(" ");
    const item = {
      name: rawName,
      price,
      unit: rawUnit,
      normName: n,
      num,
      keywords: kw,
      aliases,
      tags,
      searchNorm: norm(searchText),
      specification: rawSpec || null,
      pcsPerBundle: piecesPerBundle,
      bundleRaw: rawBundle || null
    };

    PRODUCTS.push(item);
    addIndex(rawName, item);
    for (const a of aliases) addIndex(a, item);
  }
  console.log(`Loaded ${PRODUCTS.length} products from CSV. (aliases/tags/specs supported)`);
}

// ---- 15s silence window buffer (per user) — now env-wired
const buffers = new Map();

function pushFragment(userId, text, onReady, silenceMs = SILENCE_MS, maxWindowMs = MAX_WINDOW_MS, maxFrags = MAX_FRAGS) {
  let buf = buffers.get(userId);
  const now = Date.now();

  // If buffer exists but has been idle for too long, clear it to start fresh
  if (buf && buf.firstAt && (now - buf.firstAt) > maxWindowMs * 2) {
    console.log(`Clearing stale buffer for ${userId}`);
    buffers.delete(userId);
    buf = null;
  }

  if (!buf) { buf = { frags: [], timer: null, firstAt: now }; buffers.set(userId, buf); }

  buf.frags.push(text);
  if (!buf.firstAt) buf.firstAt = now;

  const fire = async () => {
    const payload = buf.frags.slice();
    buffers.delete(userId);
    await onReady(payload);
  };

  if (buf.frags.length >= maxFrags || now - buf.firstAt >= maxWindowMs) {
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = null;
    return void fire();
  }

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(fire, silenceMs);
}

// --- One-turn intent memory per user (size/bundle), cancelled on topic switch
const pendingIntent = new Map(); // userId -> { spec:boolean, bundle:boolean, group:string, ts:number }

function baseTokens(s) { return tokens(s).map(t => norm(t)); }
function detectProductGroup(query) {
  const qn = norm(query || "");
  const qTokens = new Set(baseTokens(query || ""));
  let best = null;
  for (const p of PRODUCTS) {
    const nameHit = p.searchNorm?.includes(qn);
    const kwHit = p.keywords?.some(k => qTokens.has(norm(k)));
    if (nameHit || kwHit) {
      const head = (p.name.match(/[A-Za-zก-๙#]+/g) || [p.name])[0];
      const group = head ? head.toLowerCase() : p.name.toLowerCase();
      best = group;
      break;
    }
  }
  return best;
}

// Detect if current question is about a completely different domain (more conservative approach)
function isTopicChange(currentQuery, recentHistory) {
  if (!recentHistory.length) return false;

  // Only consider major topic changes that would benefit from context reset
  const currentIsDelivery = /ส่ง|จัดส่ง|delivery|ค่าส่ง|lalamove/i.test(currentQuery);
  const currentIsLocation = /ที่อยู่|แผนที่|map|location|เปิด|ปิด|เวลา/i.test(currentQuery);
  const currentIsPayment = /จ่าย|ชำระ|โอน|payment|บัตร|เงินสด/i.test(currentQuery);

  // Check recent conversation topics
  const recentWasProduct = recentHistory.slice(-4).some(msg =>
    msg.role === 'user' && detectProductGroup(msg.content)
  );

  // Only reset context for major domain switches that could cause confusion
  // Allow all product-related conversations (pricing, specs, comparisons) to keep context
  const majorTopicSwitch = (currentIsDelivery || currentIsLocation || currentIsPayment) && recentWasProduct;

  return majorTopicSwitch;
}
const SPEC_RE   = /ขนาด|สเปค|สเป็ค|กว้าง|ยาว|หนา/i;
const BUNDLE_RE = /(มัด).*กี่|กี่เส้น|กี่แผ่น|กี่ท่อน/i;
function looksLikeProductOnly(msg) {
  const m = (msg || "").toLowerCase();
  if (SPEC_RE.test(m) || BUNDLE_RE.test(m)) return false;
  return baseTokens(m).length > 0;
}

// ---- Simple concurrency limiter
let inFlight = 0;
const queue = [];
function withLimiter(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      inFlight++;
      try {
        const res = await fn();
        resolve(res);
      } catch (e) {
        reject(e);
      } finally {
        inFlight--;
        const next = queue.shift();
        if (next) next();
      }
    };
    if (inFlight < OPENROUTER_MAX_CONCURRENCY) task();
    else queue.push(task);
  });
}

// ---- OpenRouter call helper with timeout + one 429 retry
async function fetchOpenRouter(body, { title, referer }) {
  return withLimiter(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": referer,
            "X-Title": title,
          },
          body: JSON.stringify(body),
        });
        if (r.status === 429 && attempt === 0) {
          // backoff then retry once
          clearTimeout(timer);
          const wait = 800 + Math.floor(Math.random() * 800);
          await new Promise(res => setTimeout(res, wait));
          continue;
        }
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          throw new Error(`OpenRouter ${r.status}: ${text || r.statusText}`);
        }
        const data = await r.json();
        return data;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("OpenRouter 429");
  });
}

// ---- Build unified system prompt (merge + answer)
function buildSystemPrompt(productList) {
  return `You are a Thai sales assistant for ไพบูลย์กิจ building materials shop. Respond in Thai with polite female tone (ค่ะ/นะคะ).

APPROACH: Answer customer questions directly. For multiple questions, group by topic (เรื่องราคา:, เรื่องขนาด:, เรื่องการส่ง:). Use conversation history for related questions only - reset context for major topic switches (products→delivery→payment).

PRODUCT CATALOG (authoritative):
${productList}

CORE RULES:
• Use ONLY catalog data - NEVER invent prices, specs, or bundles
• Only mention phone 088-277-0145 (no name) when: missing catalog info, ordering details, complex questions
• Match products using name/aliases/tags/ขนาด - list best 1-3 matches if multiple fit
• Ask max ONE clarifying question when needed

PRICING FORMAT:
• Single: "ชื่อสินค้า ราคา N บาท ต่อ <unit>" (+ "• รวม = … บาท" if quantity)
• Multiple: bullet list "• ชื่อ ราคา N บาท ต่อ <unit>"
• Missing price: "กรุณาโทร 088-277-0145 นะคะ"

SPECIFICATIONS & BUNDLES:
• ONLY provide when EXPLICITLY asked about ขนาด/dimensions/มัด/pieces per bundle
• Never auto-include in pricing responses
• Use "ขนาด" field from catalog only
• If missing data or customer shows doubt: redirect to phone immediately

COMPANY INFO:
• Location: ไพบูลย์กิจ ถ. พระรามที่ 2 ตำบล บางน้ำจืด อำเภอเมืองสมุทรสาคร สมุทรสาคร 74000
• Map: https://maps.app.goo.gl/FdidXtQAF6KSmiMd9
• Hours: เปิด 7:30-17:00 จันทร์-เสาร์ (ปิดวันอาทิตย์)
• Payment: โอนก่อนเท่านั้น

DELIVERY: กรุงเทพฯและปริมณฑลใช้ Lalamove ร้านเป็นผู้เรียกรถ ลูกค้าชำระค่าส่งเอง
• NEVER mention free delivery or minimum orders
• Costs: "ใช้ Lalamove คิดค่าส่งตามจริง"

SPECIAL POLICIES:
• VAT: "ราคาในแคตตาล็อกยังไม่รวม VAT กรุณาโทร 088-277-0145 เพื่อสอบถามราคารวม VAT ค่ะ"
• มอก. standards: "สินค้าเป็นสินค้าทั่วไป ไม่มี มอก. ค่ะ"

OUTPUT RULES:
• Thai language only
• NO closing statements/pleasantries/contact reminders
• End naturally after providing info
• For off-topic questions (construction advice, usage recommendations, installation): "กรุณาติดต่อ 088-277-0145 เพื่อสอบถามข้อมูลเพิ่มเติมค่ะ"

CRITICAL: Stick to catalog facts only. Never invent information.`;
}

// ---- Build product list text for the system prompt
function buildCatalogForPrompt() {
  return PRODUCTS.map(p => {
    const priceTxt = Number.isFinite(p.price) ? `${p.price} บาท` : (p.price || "—");
    const unitTxt  = p.unit ? ` ต่อ ${p.unit}` : "";
    const aliasTxt = (p.aliases && p.aliases.length) ? ` | aliases: ${p.aliases.join(", ")}` : "";
    const tagTxt   = (p.tags && p.tags.length) ? ` | tags: ${p.tags.join(", ")}` : "";
    const specTxt  = p.specification ? ` | ขนาด: ${p.specification}` : "";
    const bundleTxt= (p.pcsPerBundle ? ` | pcs_per_bundle: ${p.pcsPerBundle}` : (p.bundleRaw ? ` | pcs_per_bundle: ${p.bundleRaw}` : ""));
    return `${p.name} = ${priceTxt}${unitTxt}${aliasTxt}${tagTxt}${specTxt}${bundleTxt}`;
  }).join("\n");
}

// ---- Unified LLM call: merge fragments + produce final sales reply
async function answerOnceWithLLM(frags, history = []) {
  const productList = buildCatalogForPrompt();
  const systemPrompt = buildSystemPrompt(productList);
  const user = frags.map((f, i) => `[${i+1}] ${f}`).join("\n");

  // Check for topic change - if detected, don't use any history
  const currentQuery = frags.join(' ');
  const recentHistory = history.slice(-10);  // Changed from -4 to -10 turns
  const topicChanged = isTopicChange(currentQuery, recentHistory);

  // Limit history to prevent context bleeding
  // If topic changed completely, don't use any history to avoid mixing topics
  const limitedHistory = topicChanged ? [] : recentHistory;

  let lastErr;
  for (const model of MODELS) {
    try {
      const data = await fetchOpenRouter({
        model,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          ...limitedHistory,   // keep only last 4 turns instead of 20
          { role: "user", content: user }
        ]
      }, { title: `my-shop-prices single-call (${model})`, referer: "https://github.com/prestige959-tech/my-shop-prices"});

      const content =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.text ??
        null;
      if (!content) throw new Error("No content from OpenRouter");
      return content.trim();
    } catch (e) {
      const msg = String(e?.message || "");
      // Try next model for common recoverable errors
      if (msg.includes("OpenRouter 429") || msg.includes("rate-limited") || msg.includes("429") ||
          msg.includes("aborted") || msg.includes("timeout") || msg.includes("network") ||
          msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) {
        console.log(`Model ${model} failed (${msg}), trying next model...`);
        lastErr = e;
        continue;
      }
      // For non-recoverable errors, bubble up immediately
      throw e;
    }
  }
  // All models failed
  throw lastErr || new Error("All models failed");
}

// ---- LINE webhook
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

      // === Interactive Menu System ===
      const session = menuSessions.get(userId);

      // Main menu - /listusers command
      if (text.toLowerCase() === '/listusers') {
        try {
          const users = await getUsersWithProfiles(lineClient);
          if (users.length === 0) {
            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: "ยังไม่มีผู้ใช้ในระบบค่ะ"
            });
            continue;
          }

          const menuText = `รายชื่อผู้ใช้ทั้งหมด (${users.length} คน):\n\nเลือกการดำเนินการ:\n1. Pause ผู้ใช้\n2. Resume ผู้ใช้\n\nพิมพ์ตัวเลข 1 หรือ 2`;

          menuSessions.set(userId, {
            step: 'main_menu',
            users: users,
            timestamp: Date.now()
          });

          await lineClient.replyMessage(ev.replyToken, {
            type: "text",
            text: menuText
          });
          console.log("Sent main menu to:", userId);
          continue;
        } catch (error) {
          console.error("Error in /listusers:", error?.message);
          await lineClient.replyMessage(ev.replyToken, {
            type: "text",
            text: "ขอโทษค่ะ ไม่สามารถดึงรายชื่อผู้ใช้ได้ในขณะนี้"
          }).catch(() => {});
          continue;
        }
      }

      // Handle menu navigation
      if (session && Date.now() - session.timestamp < 300000) { // 5 minute timeout
        const input = text.trim();

        // Main menu selection
        if (session.step === 'main_menu') {
          if (input === '1') {
            // Show users that are NOT paused
            const unpausedUsers = session.users.filter(user => !isHumanLive(user.userId));

            if (unpausedUsers.length === 0) {
              await lineClient.replyMessage(ev.replyToken, {
                type: "text",
                text: "ไม่มีผู้ใช้ที่สามารถ Pause ได้ (ทุกคนถูก Pause แล้ว)\n\nพิมพ์ /listusers เพื่อเริ่มใหม่"
              });
              menuSessions.delete(userId);
              continue;
            }

            const pauseList = `เลือกผู้ใช้ที่ต้องการ Pause:\n\n${unpausedUsers.map((user, index) =>
              `${index + 1}. ${user.displayName}`
            ).join('\n')}\n\nพิมพ์หมายเลข 1-${unpausedUsers.length}`;

            menuSessions.set(userId, {
              step: 'pause_selection',
              users: unpausedUsers,
              timestamp: Date.now()
            });

            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: pauseList
            });
            continue;

          } else if (input === '2') {
            // Show users that ARE paused
            const pausedUsers = session.users.filter(user => isHumanLive(user.userId));

            if (pausedUsers.length === 0) {
              await lineClient.replyMessage(ev.replyToken, {
                type: "text",
                text: "ไม่มีผู้ใช้ที่ถูก Pause อยู่\n\nพิมพ์ /listusers เพื่อเริ่มใหม่"
              });
              menuSessions.delete(userId);
              continue;
            }

            const resumeList = `เลือกผู้ใช้ที่ต้องการ Resume:\n\n${pausedUsers.map((user, index) =>
              `${index + 1}. ${user.displayName}`
            ).join('\n')}\n\nพิมพ์หมายเลข 1-${pausedUsers.length}`;

            menuSessions.set(userId, {
              step: 'resume_selection',
              users: pausedUsers,
              timestamp: Date.now()
            });

            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: resumeList
            });
            continue;

          } else {
            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: "กรุณาพิมพ์ 1 หรือ 2 เท่านั้น\n\nพิมพ์ /listusers เพื่อเริ่มใหม่"
            });
            continue;
          }
        }

        // Pause user selection
        else if (session.step === 'pause_selection') {
          const selectedIndex = parseInt(input) - 1;

          if (selectedIndex >= 0 && selectedIndex < session.users.length) {
            const selectedUser = session.users[selectedIndex];
            const until = setHumanLive(selectedUser.userId, HUMAN_SILENCE_MINUTES);

            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: `✅ Pause สำเร็จ!\n\n${selectedUser.displayName} ถูก Pause แล้ว\nจนถึง: ${new Date(until).toLocaleString('th-TH')}\n\nพิมพ์ /listusers เพื่อจัดการผู้ใช้อื่น`
            });

            console.log("[MENU] Paused user:", selectedUser.userId, selectedUser.displayName);
            menuSessions.delete(userId);
            continue;
          } else {
            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: `กรุณาพิมพ์หมายเลข 1-${session.users.length} เท่านั้น`
            });
            continue;
          }
        }

        // Resume user selection
        else if (session.step === 'resume_selection') {
          const selectedIndex = parseInt(input) - 1;

          if (selectedIndex >= 0 && selectedIndex < session.users.length) {
            const selectedUser = session.users[selectedIndex];
            clearHumanLive(selectedUser.userId);

            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: `✅ Resume สำเร็จ!\n\n${selectedUser.displayName} สามารถใช้งาน AI ได้แล้ว\n\nพิมพ์ /listusers เพื่อจัดการผู้ใช้อื่น`
            });

            console.log("[MENU] Resumed user:", selectedUser.userId, selectedUser.displayName);
            menuSessions.delete(userId);
            continue;
          } else {
            await lineClient.replyMessage(ev.replyToken, {
              type: "text",
              text: `กรุณาพิมพ์หมายเลข 1-${session.users.length} เท่านั้น`
            });
            continue;
          }
        }
      } else if (session) {
        // Session expired
        menuSessions.delete(userId);
      }

      // === NEW: human takeover guard ===
      if (isHumanLive(userId)) {
        // Extend timer on ping if you prefer:
        // setHumanLive(userId, HUMAN_SILENCE_MINUTES);
        console.log("Silenced user → bot stays quiet:", userId);
        continue; // skip AI reply entirely
      }

      const history = await getContext(userId);

      pushFragment(userId, text, async (frags) => {
        // Debug logging for fragment issues
        console.log(`Processing fragments for ${userId}:`, frags.map((f, i) => `[${i+1}] ${f}`));

        // ---------- Clear pendingIntent completely to prevent mixing topics ----------
        // This prevents previous specification or bundle questions from affecting current questions
        pendingIntent.delete(userId);

        // Only handle spec/bundle if asked in the CURRENT message
        const lastUserMsg = (frags[frags.length - 1] || "");
        const askedSpecNow   = SPEC_RE.test(lastUserMsg);
        const askedBundleNow = BUNDLE_RE.test(lastUserMsg);

        // Only persist intent if explicitly asked in current message
        if (askedSpecNow || askedBundleNow) {
          const lastGroup = detectProductGroup(lastUserMsg);
          pendingIntent.set(userId, {
            spec: askedSpecNow,
            bundle: askedBundleNow,
            group: lastGroup || null,
            ts: Date.now()
          });
        }

        let reply;
        try {
          reply = await answerOnceWithLLM(frags, history);
        } catch (e) {
          console.error("OpenRouter error:", e?.message);
          reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาโทร 088-277-0145 นะคะ 🙏";
        }

        for (const f of frags) history.push({ role: "user", content: f });
        history.push({ role: "assistant", content: reply });
        await setContext(userId, history);

        try {
          await lineClient.replyMessage(ev.replyToken, {
            type: "text",
            text: (reply || "").slice(0, 5000)
          });
        } catch (err) {
          console.warn("Reply failed (possibly expired token):", err?.message);
        }
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
  await loadProducts().catch(err => {
    console.error("Failed to load products.csv:", err?.message);
  });
  console.log("Bot running on port", PORT);
});
