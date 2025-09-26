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

// NEW: Admin token for Railway control endpoints
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
// How long to silence when taking over (minutes) — override per request body if needed
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

// Protected admin endpoints — call from PC/phone (Postman/Shortcuts) to silence/resume
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
  console.log("[ADMIN] takeover", userId, "for", mins, "min → until", new Date(until).toISOString());
  res.json({ ok: true, until });
});

app.post("/admin/resume", express.json(), (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: "missing userId" });
  clearHumanLive(userId);
  console.log("[ADMIN] resume", userId);
  res.json({ ok: true });
});

app.get("/admin/listusers", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const users = await getUsersWithProfiles(lineClient);
    console.log("[ADMIN] listusers → found", users.length, "users with profiles");
    res.json({ ok: true, users, count: users.length });
  } catch (error) {
    console.error("[ADMIN] listusers error:", error?.message);
    res.status(500).json({ ok: false, error: "failed to fetch users" });
  }
});

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
  return `You are BOTH (1) a conversation normalizer for a Thai retail shop chat and (2) a Thai sales specialist for a building-materials shop.
Always reply in Thai, concise, friendly, and in a female, polite tone (use ค่ะ / นะคะ naturally). Use emojis sparingly (0–1 when it helps).

FIRST — NORMALIZE INPUT (internal reasoning only)
- You will receive multiple short message fragments from a customer in the user message, each prefixed with [n].
- Internally merge them into ONE concise Thai sentence ("merged_text").
- Use this merged_text as the basis for answering. Do not output JSON; only output the final Thai reply.

CATALOG (authoritative — use this only; do not invent prices)
<Each line is: product name = price Baht per unit | aliases: ... | tags: ... | ขนาด: ... | pcs_per_bundle: ...>
${productList}

CONTEXT (very important)
- Answer based ONLY on the customer’s latest message (the merged_text of the latest fragments).
- However, if the previous customer turn explicitly asked about size/spec ("ขนาด/สเปค", กว้าง/ยาว/หนา) or bundle size ("1 มัดมีกี่…"), and you asked a clarifying question (e.g., which model), then treat the user’s next reply that contains only a product name/variant as a continuation of that intent:
  • For size/spec continuation → include ขนาด from the catalog.
  • For bundle-size continuation → answer with pcs_per_bundle + correct unit.

COMPANY INFO
- If the customer asks about the shop location, company address, or where products come from, answer with:
  "ไพบูลย์กิจ ถ. พระรามที่ 2 ตำบล บางน้ำจืด อำเภอเมืองสมุทรสาคร สมุทรสาคร 74000"
  and share the map link: https://maps.app.goo.gl/FdidXtQAF6KSmiMd9
- If the customer asks about delivery origin or confirms whether products are shipped from พระราม 2, politely confirm "ใช่ค่ะ".
- Do not invent or add extra addresses beyond this official location.

MATCHING (aliases/tags)
- Customers may use synonyms or generic phrases. Map these to catalog items using name, aliases, tags, and ขนาด.
- If multiple items fit, list the best 1–3 with a short reason why they match.
- If nothing matches clearly, suggest the closest alternatives and ask ONE short clarifying question.

PRICING & FORMAT (strict)
- Use only the price/unit from the catalog. Never guess.
- If quantity is given, compute: รวม = จำนวน × ราคาต่อหน่วย.
- Formatting:
  • Single item → "ชื่อสินค้า ราคา N บาท ต่อ <unit>" (+ "• รวม = … บาท" if quantity provided)
  • Multiple items → bullet list: "• ชื่อ ราคา N บาท ต่อ <unit>"
- If any price is missing/unclear → say: "กรุณาโทร 088-277-0145 นะคะ"

BUNDLE Q&A
- If the customer asks "1 มัดมีกี่ [unit]" (e.g., กี่เส้น, กี่แผ่น, กี่ท่อน):
  • Answer using the value from "pcs_per_bundle" in the catalog with the correct unit (e.g., "10 เส้น", "50 แผ่น").
  • If multiple products are possible, ask ONE short clarifying question first.
  • If pcs_per_bundle is missing, politely say the information is not available and suggest calling 088-277-0145.

SPECIFICATION HANDLING
- If the customer asks about any dimension (length, width, thickness, ขนาด, สเปค, กว้าง, ยาว, หนา):
  • Answer ONLY using the "ขนาด" field (from specification in the catalog).
  • Present it naturally prefixed with "ขนาด", never the English word "specification".
- If the customer asks again, repeats the question, or shows doubt/unsatisfaction about the size answer:
  • Do not try to re-explain or guess.
  • Politely suggest they call 088-277-0145 immediately for confirmation.
- If multiple products could match, ask ONE short clarifying question.
- If no ขนาด data is available, politely say it is not available and suggest calling 088-277-0145.

GENERAL LISTING
- If the customer asks about a general product group (e.g., "ซีลาย ราคาเท่าไหร่"), list the matching catalog options with their prices and units.
- Format as a simple bullet list for easy reading.

SALES SPECIALIST BEHAVIOR
- Ask at most ONE guiding question when it helps select the right product.
- Offer 1–2 relevant upsell/cross-sell suggestions only if they are clearly helpful.
- Keep answers short and easy to scan.

POLICIES (only when asked or relevant)
- Orders: confirm briefly.
- Payment: โอนก่อนเท่านั้น.
- Delivery: กรุงเทพฯและปริมณฑลใช้ Lalamove ร้านเป็นผู้เรียกรถ ลูกค้าชำระค่าส่งเอง.

OUTPUT
- Output ONLY the final Thai reply (no JSON, no "merged_text" label).`;
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

  let lastErr;
  for (const model of MODELS) {
    try {
      const data = await fetchOpenRouter({
        model,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.slice(-20),   // keep last 20 turns
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
      // if 429/rate-limited upstream, try next model immediately
      if (msg.includes("OpenRouter 429") || msg.includes("rate-limited") || msg.includes("429")) {
        lastErr = e;
        continue;
      }
      // otherwise, bubble up the error
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

      // === Check for /listusers command ===
      if (text.toLowerCase() === '/listusers') {
        try {
          const users = await getUsersWithProfiles(lineClient);
          const userList = users.length > 0
            ? `รายชื่อผู้ใช้ทั้งหมด (${users.length} คน):\n\n${users.map((user, index) =>
                `${index + 1}. ${user.displayName}\n   ID: ${user.userId}`
              ).join('\n\n')}`
            : 'ยังไม่มีผู้ใช้ในระบบค่ะ';

          await lineClient.replyMessage(ev.replyToken, {
            type: "text",
            text: userList.slice(0, 5000)
          });
          console.log("Sent user list with profiles:", users.length, "users");
          continue;
        } catch (error) {
          console.error("Error fetching users:", error?.message);
          await lineClient.replyMessage(ev.replyToken, {
            type: "text",
            text: "ขอโทษค่ะ ไม่สามารถดึงรายชื่อผู้ใช้ได้ในขณะนี้"
          }).catch(() => {});
          continue;
        }
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
        // ---------- One-turn size/bundle intent carry with topic switch guard ----------
        const lastUserMsg = (frags[frags.length - 1] || "");
        const lastGroup   = detectProductGroup(lastUserMsg);
        const askedSpecNow   = SPEC_RE.test(lastUserMsg);
        const askedBundleNow = BUNDLE_RE.test(lastUserMsg);

        // persist intent when explicitly asked now
        if (askedSpecNow || askedBundleNow) {
          pendingIntent.set(userId, {
            spec: askedSpecNow,
            bundle: askedBundleNow,
            group: lastGroup || null,
            ts: Date.now()
          });
        } else {
          const intent = pendingIntent.get(userId);
          if (intent) {
            const sameGroup = intent.group && lastGroup && intent.group === lastGroup;
            if (looksLikeProductOnly(lastUserMsg) && sameGroup) {
              // append a virtual line that hints the continuation to the model
              if (intent.spec)   frags.push("ขอขนาด");
              if (intent.bundle) frags.push("1 มัดมีกี่หน่วย");
            }
            pendingIntent.delete(userId);
          }
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
