// index.js (LINE version) — with UNIT support
import express from "express";
import * as line from "@line/bot-sdk";            // <— no default export; use namespace import
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

  // Simple CSV parser (handles quotes)
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
  const nameIdx = header.findIndex(h => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx = header.findIndex(h => ["price","ราคา","amount","cost"].includes(h));
  // NEW: unit column (supports common variations)
  const unitIdx = header.findIndex(h => ["unit","units","uom","หน่วย","per","per_unit","perunit"].includes(h));

  PRODUCTS = [];
  NAME_INDEX = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];

    const rawName = (cols[(nameIdx !== -1 ? nameIdx : 0)] || "").trim();
    const rawPrice = (cols[(priceIdx !== -1 ? priceIdx : 1)] || "").trim();
    const rawUnit  = unitIdx !== -1 ? (cols[unitIdx] || "").trim() : "";

    if (!rawName) continue;

    const price = Number(String(rawPrice).replace(/[^\d.]/g, ""));
    const unit  = rawUnit;

    const n = norm(rawName);
    const kw = tokens(rawName);
    const codeMatch = rawName.match(/#\s*(\d+)/);
    const num = codeMatch ? codeMatch[1] : null;

    // Store unit on item
    const item = { name: rawName, price, unit, normName: n, num, keywords: kw };
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

// ---- OpenRouter chat with product knowledge + history ----
async function askOpenRouter(userText, history = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  // Build product catalog lines with price + unit
  const productList = PRODUCTS.map(p => {
    const priceText = Number.isFinite(p.price) ? `${p.price} บาท` : "ไม่มีราคา";
    const unitText = p.unit ? ` ต่อ ${p.unit}` : "";
    return `${p.name} = ${priceText}${unitText}`;
  }).join("\n");

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
          {
            role: "system",
            content: `You are a friendly Thai shop assistant chatbot. You help customers with product inquiries in a natural, conversational way.

PRODUCT CATALOG:
${productList}

INSTRUCTIONS:
- Answer in Thai language naturally and conversationally
- When customers ask about prices, provide the exact price from the catalog above
- Always include the unit after the price if available (e.g., "ต่อ กก.", "ต่อ กล่อง")
- Bold the product name and price (you may leave the unit unbolded)
- If a product isn't found, suggest similar products or ask for clarification
- Be helpful, polite, and use appropriate Thai politeness particles (ค่ะ, นะ, etc.)
- Handle variations in product names, codes, and customer questions flexibly
- If customers ask general questions not related to products, respond helpfully as a shop assistant would
- Keep responses concise but friendly
- If customers ask for delivery such as "ส่งไหม" or มีบริการส่งไหม, answer 
  "บริษัทเรามีบริการจัดส่งโดยใช้ Lalamove ในพื้นที่กรุงเทพฯ และปริมณฑลค่ะ
  ทางร้านจะเป็นผู้เรียกรถให้ ส่วน ค่าขนส่งลูกค้าชำระเองนะคะ
  เรื่อง ยกสินค้าลง ทางร้านไม่มีทีมบริการให้ค่ะ ลูกค้าต้อง จัดหาคนช่วยยกลงเอง นะคะ"`
          },
          ...history,
          { role: "user", content: userText }
        ]
      })
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`OpenRouter ${r.status}: ${text}`);
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? null;
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

      let reply;
      try {
        reply = await askOpenRouter(text, history);
      } catch (e) {
        console.error("OpenRouter error:", e?.message);
        reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง 🙏";
      }

      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: reply });
      await setContext(userId, history);

      await lineClient.replyMessage(ev.replyToken, {
        type: "text",
        text: (reply || "").slice(0, 5000)
      });
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
