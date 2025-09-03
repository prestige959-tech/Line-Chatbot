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
  const nameIdx = header.findIndex(h => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx = header.findIndex(h => ["price","ราคา","amount","cost"].includes(h));

  PRODUCTS = [];
  NAME_INDEX = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rawName = (cols[nameIdx !== -1 ? nameIdx : 0] || "").trim();
    const rawPrice = (cols[priceIdx !== -1 ? priceIdx : 1] || "").trim();
    if (!rawName) continue;
    const price = Number(String(rawPrice).replace(/[^\d.]/g, "")); // numeric price if present
    const n = norm(rawName);
    const kw = tokens(rawName);
    const codeMatch = rawName.match(/#\s*(\d+)/);
    const num = codeMatch ? codeMatch[1] : null;

    const item = { name: rawName, price, normName: n, num, keywords: kw };
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

  // Build product list for the prompt. If your catalog is huge, consider truncating or retrieving by match.
  const productList = PRODUCTS.map(
    p => `${p.name} = ${Number.isFinite(p.price) ? p.price + " บาท" : (p.price || "—")}`
  ).join("\n");

  const systemPrompt = `
You are a friendly Thai shop assistant chatbot. You help customers with product inquiries in a natural, conversational way.

PRODUCT CATALOG:
${productList}

INSTRUCTIONS:
- Answer in Thai language naturally and conversationally
- When customers ask about prices, provide the exact price from the catalog above
- Always include the unit after the price if available (e.g., "ต่อ กก.", "ต่อ กล่อง")
- If a product isn't found, suggest similar products or ask for clarification
- Be helpful, polite, and use appropriate Thai politeness particles (ค่ะ, ครับ, นะคะ, นะครับ)
- Keep responses concise but friendly
- Always add a polite closing like "ขอบคุณที่สนใจสินค้าค่ะ" where suitable

UNITS & ORDER SIZE:
- Always follow the "unit" column from the CSV when answering. Each product has a unit that indicates how the price is quoted (e.g., เส้น, กล่อง, มัด, กก.).
- Do NOT force customers to buy in bulk. We also sell in smaller quantities. If the customer requests less than one bundle, respond according to the CSV unit or politely ask for the exact quantity (e.g., "How many [unit] would you like?").
- If the customer requests a unit that is different from the CSV unit (for example, they ask for pieces when the product is priced per bundle), do not invent conversions. Instead, politely clarify: "This product is priced at [price] Baht per [unit]. How many [unit] would you like?" 
- If a unit conversion is requested but not available in the CSV, do not calculate yourself. Instead, escalate to admin: "Sorry, this requires admin assistance to calculate the price per [requested unit]. Please call 088-277-0145."
- Avoid telling the customer "must buy in bundle only" or "wholesale only" unless explicitly asked, and only if such a restriction is written in the CSV data.
- For totals, always include the unit “Baht” and end politely with "ค่ะ" (for statements).


ORDER & PAYMENT:
- If a customer wants to order, confirm with:
  "คุณลูกค้าต้องการสั่ง [product] [quantity] รวมทั้งหมด [total price] ใช่ไหมคะ?"
- Payment method: โอนก่อนเท่านั้น. Answer clearly if customers ask about payment.
- If customer asks aboutเงินสด/จ่ายปลายทาง/เก็บเงินปลายทาง → reply clearly: 
  "ขออภัยค่ะ ทางร้านรับชำระแบบโอนก่อนเท่านั้น ไม่รับเงินสดหรือเก็บเงินปลายทางค่ะ"

DELIVERY:
- If customers ask about delivery such as "ส่งไหม" or "มีบริการส่งไหม", answer:
  "บริษัทเรามีบริการจัดส่งโดยใช้ Lalamove ในพื้นที่กรุงเทพฯ และปริมณฑลค่ะ
  ทางร้านจะเป็นผู้เรียกรถให้ ส่วน ค่าขนส่งลูกค้าชำระเองนะคะ
  เรื่อง ยกสินค้าลง ทางร้านไม่มีทีมบริการให้ค่ะ ลูกค้าต้อง จัดหาคนช่วยยกลงเอง นะคะ"
- If customer asks aboutส่งฟรี/ค่าจัดส่ง, reply: 
  "ค่าจัดส่งลูกค้าชำระเองนะคะ ไม่ใช่บริการส่งฟรีค่ะ"
- If you have already explained the delivery service earlier in the same conversation, do NOT repeat the full explanation. 
- Instead, reply briefly with something like: "มีบริการส่งแล้วค่ะ ตามที่แจ้งไปก่อนหน้านี้" or answer the follow-up question directly.

ADMIN ESCALATION:
- If customers ask about:
  • Products not in the catalog (and no similar alternatives exist)
  • Discounts, promotions, or warranty questions
  • Special requests outside the instructions
  • Asking for a phone number or saying they want to talk to staff directly
- Then reply:
  "ขออภัยค่ะ เรื่องนี้ต้องให้แอดมินช่วยตรวจสอบเพิ่มเติม กรุณาโทร 088-277-0145 นะคะ"
  → Do not attempt to answer further.

EXTRAS:
- If appropriate, you may suggest related products to upsell.
- Keep the experience warm and service-oriented, like a real shop assistant.
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

      // LINE text message limit ~5000 chars
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
