// index.js (LINE version)
import express from "express";
import * as line from "@line/bot-sdk"; // correct: no default export
import { readFile } from "fs/promises";
import { getContext, setContext } from "./chatMemory.js";

const app = express();

// ---- ENV ----
const LINE_ACCESS_TOKEN = (process.env.LINE_ACCESS_TOKEN || "").trim();
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const MODEL = process.env.MODEL || "moonshotai/kimi-k2";

const mask = s =>
  !s ? "(empty)" : s.replace(/\s+/g, "").slice(0, 4) + "..." + s.replace(/\s+/g, "").slice(-4);
console.log("ENV → LINE_ACCESS_TOKEN:", mask(LINE_ACCESS_TOKEN));
console.log("ENV → LINE_CHANNEL_SECRET:", mask(LINE_CHANNEL_SECRET));
console.log("ENV → OPENROUTER_API_KEY:", mask(OPENROUTER_API_KEY));
console.log("ENV → MODEL:", MODEL);

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
    .replace(/[.,;:!?'""“”‘’(){}\[\]<>|/\\\-_=+]/g, "");
}
function tokens(s) {
  const t = (s || "").toLowerCase();
  const m = t.match(/[#]?\d+|[a-zA-Zก-๙]+/g);
  return m || [];
}

// ---- CSV load & product index ----
let PRODUCTS = [];
let NAME_INDEX = new Map();

async function loadProducts() {
  let csv = await readFile(new URL("./products.csv", import.meta.url), "utf8");
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

  const header = rows[0].map(h => h.trim().toLowerCase());
  const nameIdx  = header.findIndex(h => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx = header.findIndex(h => ["price","ราคา","amount","cost"].includes(h));
  const unitIdx  = header.findIndex(h => ["unit","หน่วย","ยูนิต"].includes(h));

  PRODUCTS = [];
  NAME_INDEX = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rawName = (cols[nameIdx !== -1 ? nameIdx : 0] || "").trim();
    const rawPrice = (cols[priceIdx !== -1 ? priceIdx : 1] || "").trim();
    const rawUnit  = (cols[unitIdx  !== -1 ? unitIdx  : 2] || "").trim();
    if (!rawName) continue;
    const price = Number(String(rawPrice).replace(/[^\d.]/g, "")); // numeric if present
    const n = norm(rawName);
    const kw = tokens(rawName);
    const codeMatch = rawName.match(/#\s*(\d+)/);
    const num = codeMatch ? codeMatch[1] : null;

    const item = { name: rawName, price, unit: rawUnit, normName: n, num, keywords: kw };
    PRODUCTS.push(item);
    if (!NAME_INDEX.has(n)) NAME_INDEX.set(n, item);
  }
  console.log(`Loaded ${PRODUCTS.length} products from CSV.`);
}

function findProduct(query) {
  const qn = norm(query);
  const qTokens = tokens(query);
  if (NAME_INDEX.has(qn)) return NAME_INDEX.get(qn);

  const num = (query.match(/#\s*(\d+)/) || [])[1];
  const must = qTokens.filter(t => t.length >= 2 && !/^#?\d+$/.test(t));
  let candidates = PRODUCTS;

  if (num) {
    candidates = candidates.filter(p => p.num === num || p.name.includes(`#${num}`));
  }
  if (must.length) {
    candidates = candidates.filter(p => must.every(t => norm(p.name).includes(norm(t))));
  }
  if (candidates.length > 1) {
    candidates.sort((a, b) => {
      const aScore = must.filter(t => norm(a.name).includes(norm(t))).length;
      const bScore = must.filter(t => norm(b.name).includes(norm(t))).length;
      if (aScore !== bScore) return bScore - aScore;
      if (num && a.num !== b.num) return (b.num === num) - (a.num === num);
      return a.name.length - b.name.length;
    });
  }
  return candidates[0] || null;
}

// ---- Multi-match helpers for listing variants ----
function listProductsByTerm(term) {
  const t = norm(term);
  return PRODUCTS.filter(p => norm(p.name).includes(t));
}
function formatPriceLine(p) {
  const priceTxt = Number.isFinite(p.price) ? `${p.price} บาท` : "กรุณาโทร 088-277-0145";
  const unitTxt  = p.unit ? ` ต่อ ${p.unit}` : "";
  return `• ${p.name} ราคา ${priceTxt}${unitTxt}`;
}

// ---- 15s silence window buffer (per user) ----
const buffers = new Map(); // userId -> { frags: string[], timer: NodeJS.Timeout|null, firstAt: number }

function pushFragment(userId, text, onReady, silenceMs = 15000, maxWindowMs = 60000, maxFrags = 16) {
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

  // safety: long sessions or too many frags → process immediately
  if (buf.frags.length >= maxFrags || now - buf.firstAt >= maxWindowMs) {
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = null;
    return void fire();
  }

  // reset "silence" timer every fragment
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(fire, silenceMs);
}

// ---- Semantic Reassembly → JSON (via OpenRouter) ----
function heuristicJson(frags) {
  const text = frags.join(" / ").trim();
  return {
    merged_text: text,
    items: [],
    followups: [text],
  };
}

async function reassembleToJSON(frags, history = []) {
  if (!frags?.length) return heuristicJson([]);

  const sys = `
You are a Thai conversation normalizer for a shop chat.
Input: multiple raw message fragments from a customer.
Goal: merge them into ONE structured JSON capturing products, quantity and follow-up questions.

Rules:
- Do NOT invent products or numbers.
- If a quantity has a unit (เส้น/ตัว/กิโล etc.), keep it.
- If no product is clearly stated, leave items empty and put the text into followups.
- Keep delivery/payment/stock questions as followups.
- Output ONLY minified JSON. No markdown.
JSON schema:
{
  "merged_text": "string (Thai, concise, combined)",
  "items": [
    {"product": "string", "qty": number|null, "unit": "string|null"}
  ],
  "followups": ["string", ...]
}
`.trim();

  const user = frags.map((f,i)=>`[${i+1}] ${f}`).join("\n");

  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/prestige959-tech/Line-Chatbot",
        "X-Title": "line-bot reassembler json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          ...history.slice(-4),
          { role: "user", content: user }
        ]
      })
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("empty reassembler content");
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { parsed = heuristicJson(frags); }
    if (!parsed || typeof parsed !== "object" || !("merged_text" in parsed)) {
      return heuristicJson(frags);
    }
    return parsed;
  } catch (err) {
    console.warn("Reassembler failed, using heuristic:", err?.message);
    return heuristicJson(frags);
  }
}

// ---- OpenRouter chat with product knowledge + history ----
async function askOpenRouter(userText, history = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  const productList = PRODUCTS.map(p => {
    const priceTxt = Number.isFinite(p.price) ? `${p.price} บาท` : (p.price || "—");
    const unitTxt  = p.unit ? ` ต่อ ${p.unit}` : "";
    return `${p.name} = ${priceTxt}${unitTxt}`;
  }).join("\n");

  const systemPrompt = `
You are a friendly Thai shop assistant chatbot. You help customers with product inquiries in a natural, conversational way.

PRODUCT CATALOG:
${productList}

INSTRUCTIONS:
- Answer in Thai language naturally and conversationally.
- When customers ask about prices, reply with only the product name, the unit price, and the total price (if quantity is given).
- Always include the unit after the price from unit column (e.g., "ต่อ กก.", "ต่อ กล่อง").
- Do NOT add order confirmations, payment details, or extra text unless the customer specifically asks about them.
- If a product isn't found, suggest similar products or ask for clarification.
- Be helpful, polite, and use appropriate Thai politeness particles (ค่ะ, ครับ, นะคะ, นะครับ).
- Keep responses very concise and friendly.
- Always use the unit from the unit column in the price file only.
    If customer messages or marketing texts mention bundle terms like "มัด", "แพ็ค", or "ชุด", ignore them and convert back to the correct unit from the file.
- If the user asks a generic category that matches multiple products (เช่น "ฉาก" หรือ "ฉากริมสังกะสี"), list **all** matching items with their unit prices, one per line, concise, no extra commentary.

PRICING & QUANTITY (MANDATORY — PIECES ONLY):
- We sell by pieces only. Never require bundles, sets, packs, or minimum quantities.
- Treat the CSV price as the per-piece price. Total = (customer requested quantity) × (price).
- If the CSV "unit" text contains bundle wording, IGNORE the bundle size and use the base piece unit only.
- When the customer specifies a quantity, compute and state the total.
- If the exact price is missing, do not guess. Escalate: "กรุณาโทร 088-277-0145".
- Keep answers concise. Do not re-explain delivery or policies unless asked.

SUMMARY OF ORDER:
- If the customer asks for a sum, list each item with subtotal then show the final total.

ORDER & PAYMENT:
- If a customer wants to order, confirm succinctly.
- Payment method: โอนก่อนเท่านั้น. If asked: "ขออภัยค่ะ ทางร้านรับชำระแบบโอนก่อนเท่านั้น ไม่รับเงินสดหรือเก็บเงินปลายทางค่ะ"

DELIVERY:
- If asked about delivery: explain Lalamove (BKK & vicinity), shop calls the car, customer pays shipping, no unloading team.
- If asked again, avoid repeating the whole block; be brief.
`.trim();

  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/prestige959-tech/my-shop-prices",
        "X-Title": "my-shop-prices line-bot"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: userText }
        ]
      })
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`OpenRouter ${r.status}: ${text || r.statusText}`);
    }
    const data = await r.json();
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      null;
    if (!content) throw new Error("No content from OpenRouter");
    return content.trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ---- LINE webhook (POST only). Do NOT add express.json() before this.
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).end(); // ack LINE quickly

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for (const ev of events) {
    try {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;

      const userId = ev?.source?.userId;
      const text = ev?.message?.text?.trim();
      if (!userId || !text) continue;

      console.log("IN:", { userId, text });

      const history = await getContext(userId);

      // push into 15s silence buffer; when timer fires, reassemble to JSON then ask once
      pushFragment(userId, text, async (frags) => {
        const parsed = await reassembleToJSON(frags, history);

        // Build a clean merged text for the assistant model
        let mergedForAssistant = parsed.merged_text || frags.join(" / ");
        if (parsed.items?.length) {
          const itemsPart = parsed.items
            .map(it => {
              const qty = (it.qty != null && !Number.isNaN(it.qty)) ? ` ${it.qty}` : "";
              const unit = it.unit ? ` ${it.unit}` : "";
              return `${it.product || ""}${qty}${unit}`.trim();
            })
            .filter(Boolean)
            .join(" / ");
          mergedForAssistant = itemsPart + (parsed.followups?.length ? " / " + parsed.followups.join(" / ") : "");
        }

        // ---- NEW: deterministic listing for ฉาก / ฉากริมสังกะสี
        const qn = norm(mergedForAssistant);
        let repliedWithList = false;
        const replyListFor = async (term) => {
          const matches = listProductsByTerm(term);
          if (!matches.length) return false;

          // stable ordering
          matches.sort((a, b) => a.name.localeCompare(b.name, "th"));

          const lines = matches.map(formatPriceLine);
          const reply = `ในร้านเรามี${term} ${matches.length} แบบนะคะ\n` + lines.join("\n");

          // persist & reply
          history.push({ role: "assistant", content: reply });
          await setContext(userId, history);
          try {
            await lineClient.replyMessage(ev.replyToken, { type: "text", text: reply.slice(0, 5000) });
          } catch (err) {
            console.warn("Reply failed (possibly expired token):", err?.message);
          }
          return true;
        };

        if (qn.includes("ฉากริมสังกะสี")) {
          repliedWithList = await replyListFor("ฉากริมสังกะสี");
        } else if (qn.includes("ฉาก")) {
          repliedWithList = await replyListFor("ฉาก");
        }
        if (repliedWithList) return; // do not continue to LLM for this turn

        // ---- fallback: normal LLM flow ----
        let reply;
        try {
          reply = await askOpenRouter(mergedForAssistant, history);
        } catch (e) {
          console.error("OpenRouter error:", e?.message);
          reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาโทร 088-277-0145 นะคะ 🙏";
        }

        // Persist: raw fragments, JSON summary, merged text, and assistant reply
        for (const f of frags) history.push({ role: "user", content: f });
        history.push({ role: "user", content: `(รวมข้อความ JSON): ${JSON.stringify(parsed)}` });
        history.push({ role: "user", content: `(รวมข้อความพร้อมใช้งาน): ${mergedForAssistant}` });
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
      }, /* silenceMs */ 15000);
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
