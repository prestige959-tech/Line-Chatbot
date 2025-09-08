// index.js (LINE version — AI-only product selection + female Thai sales specialist, 20-turn memory)
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

// ---- CSV load & product index (with optional aliases/tags) ----
let PRODUCTS = [];
let NAME_INDEX = new Map(); // kept for potential debug/admin — not used for selection

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
  const nameIdx   = header.findIndex(h => ["name","product","title","สินค้า","รายการ","product_name"].includes(h));
  const priceIdx  = header.findIndex(h => ["price","ราคา","amount","cost"].includes(h));
  const unitIdx   = header.findIndex(h => ["unit","หน่วย","ยูนิต"].includes(h));
  const aliasIdx  = header.findIndex(h => ["aliases","alias","aka","synonyms","คำพ้อง","ชื่อเรียก","อีกชื่อ"].includes(h));
  const tagsIdx   = header.findIndex(h => ["tags","tag","หมวด","หมวดหมู่","ประเภท","คีย์เวิร์ด","keywords","keyword"].includes(h));

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
    const rawName   = (cols[nameIdx  !== -1 ? nameIdx  : 0] || "").trim();
    const rawPrice  = (cols[priceIdx !== -1 ? priceIdx : 1] || "").trim();
    const rawUnit   = (cols[unitIdx  !== -1 ? unitIdx  : 2] || "").trim();
    const rawAliases= aliasIdx !== -1 ? (cols[aliasIdx] || "") : "";
    const rawTags   = tagsIdx  !== -1 ? (cols[tagsIdx]  || "") : "";

    if (!rawName) continue;

    const aliases = splitList(rawAliases);
    const tags    = splitList(rawTags);

    const price = Number(String(rawPrice).replace(/[^\d.]/g, ""));
    const n = norm(rawName);
    const kw = Array.from(new Set([
      ...tokens(rawName),
      ...aliases.flatMap(a => tokens(a)),
      ...tags.flatMap(t => tokens(t)),
    ]));

    const codeMatch = rawName.match(/#\s*(\d+)/);
    const num = codeMatch ? codeMatch[1] : null;

    const searchText = [rawName, ...aliases, ...tags].join(" ");
    const item = {
      name: rawName,
      price,
      unit: rawUnit,
      normName: n,
      num,
      keywords: kw,
      aliases,
      tags,
      searchNorm: norm(searchText)
    };

    PRODUCTS.push(item);
    addIndex(rawName, item);
    for (const a of aliases) addIndex(a, item);
  }
  console.log(`Loaded ${PRODUCTS.length} products from CSV. (aliases/tags supported)`);
}

// ---- 15s silence window buffer (per user) ----
const buffers = new Map();

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

  if (buf.frags.length >= maxFrags || now - buf.firstAt >= maxWindowMs) {
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = null;
    return void fire();
  }

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(fire, silenceMs);
}

// ---- Semantic Reassembly → JSON (via OpenRouter)
function heuristicJson(frags) {
  const text = frags.join(" / ").trim();
  return { merged_text: text, items: [], followups: [text] };
}

async function reassembleToJSON(frags, history = []) {
  if (!frags?.length) return heuristicJson([]);

  const sys = `
You are a conversation normalizer for a Thai retail shop chat.

TASK
- You receive multiple short message fragments from a customer.
- Merge them into ONE concise Thai sentence and extract a structured list of items.

OUTPUT (JSON ONLY, MINIFIED — no markdown, comments, or extra text)
{
  "merged_text":"string",
  "items":[
    {"product":"string","qty":number|null,"unit":"string|null"}
  ],
  "followups":["string", ...]
}

RULES
- Do NOT hallucinate products or quantities.
- Preserve user-provided units exactly (e.g., เส้น/ตัว/กก./เมตร).
- If quantity is missing or ambiguous → "qty": null.
- If the product is unclear or not stated → leave "items" empty and put the customer’s questions/intents into "followups".
- Keep delivery/payment/stock questions in "followups".
- "merged_text" must be short, natural Thai, combining the fragments into a single sentence.
- Return valid, minified JSON only. No extra whitespace.
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

// ---- OpenRouter chat with sales-specialist prompt (20-turn memory)
async function askOpenRouter(userText, history = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  const productList = PRODUCTS.map(p => {
    const priceTxt = Number.isFinite(p.price) ? `${p.price} บาท` : (p.price || "—");
    const unitTxt  = p.unit ? ` ต่อ ${p.unit}` : "";
    const aliasTxt = (p.aliases && p.aliases.length) ? ` | aliases: ${p.aliases.join(", ")}` : "";
    const tagTxt   = (p.tags && p.tags.length) ? ` | tags: ${p.tags.join(", ")}` : "";
    return `${p.name} = ${priceTxt}${unitTxt}${aliasTxt}${tagTxt}`;
  }).join("\n");

  const systemPrompt = `
You are a Thai sales specialist for a building-materials shop.
Always reply in Thai, concise, friendly, and in a female, polite tone (use ค่ะ / นะคะ naturally). Use emojis sparingly (0–1 when it helps).

CATALOG (authoritative — use this only; do not invent prices)
<Each line is: product name = price Baht per unit | aliases: ... | tags: ...>
${productList}

CONTEXT (very important)
- Answer based ONLY on the customer’s latest message.
- Do NOT combine products or details from earlier turns unless the customer explicitly refers back.
- If the new message appears to be a new product/topic, treat it independently.
- If it’s a follow-up, you may use relevant recent context.

MATCHING (aliases/tags)
- Customers may use synonyms or generic phrases. Map these to catalog items using name, aliases, and tags.
- If multiple items fit, list the best 1–3 with a short reason why they match.
- If nothing matches clearly, suggest the closest alternatives and ask ONE short clarifying question.

PRICING & FORMAT (strict)
- Use only the price/unit from the catalog. Never guess.
- If quantity is given, compute: รวม = จำนวน × ราคาต่อหน่วย.
- Formatting:
  • Single item → "ชื่อสินค้า ราคา N บาท ต่อ <unit>" (+ "• รวม = … บาท" if quantity provided)
  • Multiple items → bullet list: "• ชื่อ ราคา N บาท ต่อ <unit>"
- If any price is missing/unclear → say: "กรุณาโทร 088-277-0145 นะคะ"

SALES SPECIALIST BEHAVIOR
- Ask at most ONE guiding question when it helps select the right product.
- Offer 1–2 relevant upsell/cross-sell suggestions only if they’re clearly helpful.
- Keep answers short and easy to scan.

POLICIES (only when asked or relevant)
- Orders: confirm briefly.
- Payment: โอนก่อนเท่านั้น.
- Delivery: กรุงเทพฯและปริมณฑลใช้ Lalamove ร้านเป็นผู้เรียกรถ ลูกค้าชำระค่าส่งเอง.

TONE & EMPATHY
- Be warm and respectful; greet at the start of a new conversation and close politely when appropriate.
- If the customer shows concern, acknowledge politely before providing options.

DO NOT
- Do not claim stock status, shipping time, or payment confirmation unless asked.
- Do not invent or alter catalog data.
- Do not include unrelated items from previous questions unless explicitly referenced.

OUTPUT QUALITY
- Keep it concise, clear, and helpful.
- Prioritize correctness and readability.
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
          ...history.slice(-20),   // <-- keep last 20 turns
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

      const history = await getContext(userId);

      pushFragment(userId, text, async (frags) => {
        const parsed = await reassembleToJSON(frags, history);

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

        let reply;
        try {
          reply = await askOpenRouter(mergedForAssistant, history);
        } catch (e) {
          console.error("OpenRouter error:", e?.message);
          reply = "ขอโทษค่ะ ระบบขัดข้องชั่วคราว กรุณาโทร 088-277-0145 นะคะ 🙏";
        }

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
      }, 15000);
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
