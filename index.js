// index.js (LINE version — AI-only product selection)
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
let NAME_INDEX = new Map(); // norm(name or alias) -> item (kept for future debug/tools; not used for selection)

async function loadProducts() {
  let csv = await readFile(new URL("./products.csv", import.meta.url), "utf8");

  // minimal CSV parser (keeps compatibility with your original)
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

    const price = Number(String(rawPrice).replace(/[^\d.]/g, "")); // numeric if present
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
    // index (kept for potential admin/debug commands)
    addIndex(rawName, item);
    for (const a of aliases) addIndex(a, item);
  }
  console.log(`Loaded ${PRODUCTS.length} products from CSV. (aliases/tags supported)`);
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

// ---- OpenRouter chat with sales-specialist prompt (AI-only selection) ----
async function askOpenRouter(userText, history = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  // Render the catalog so the model can choose/promote products itself
  const productList = PRODUCTS.map(p => {
    const priceTxt = Number.isFinite(p.price) ? `${p.price} บาท` : (p.price || "—");
    const unitTxt  = p.unit ? ` ต่อ ${p.unit}` : "";
    const aliasTxt = (p.aliases && p.aliases.length) ? ` | aliases: ${p.aliases.join(", ")}` : "";
    const tagTxt   = (p.tags && p.tags.length) ? ` | tags: ${p.tags.join(", ")}` : "";
    return `${p.name} = ${priceTxt}${unitTxt}${aliasTxt}${tagTxt}`;
  }).join("\n");

  const systemPrompt = `
You are a Thai **sales specialist** for a building-materials shop. ALWAYS reply in Thai, concise, friendly, and helpful (use appropriate particles: ค่ะ/ครับ/นะคะ/นะครับ).

CATALOG (authoritative — use this only; do not invent prices)
<Each line is: ชื่อสินค้า = ราคา บาท ต่อ <unit> | aliases: ... | tags: ...>
${productList}

MATCHING (important)
- ลูกค้าอาจใช้คำพ้อง/ชื่อเรียกทั่วไป/คำกลุ่ม (เช่น แผ่นฝ้ายิปซั่ม, ฝ้าเพดาน, แผ่นฝ้า, แผ่นผนังกั้นห้อง) ให้เทียบกับชื่อสินค้าโดยใช้ทั้งชื่อจริง, aliases และ tags จาก CATALOG
- ถ้าคำถามกว้างหรือคลุมเครือ ให้เสนอ “ตัวเลือกที่ตรงที่สุด 1–3 รายการ” พร้อมบอกสั้น ๆ ว่าทำไมเหมาะ
- ถ้าตรงหลายรายการ ให้แสดงแบบบูลเล็ต
- ถ้าไม่ตรงเลย ให้เสนอรายการใกล้เคียงและถามยืนยัน 1 คำถามสั้น ๆ

PRICING & FORMAT (strict)
- ใช้ราคา/หน่วยตาม CATALOG เท่านั้น ห้ามเดา
- ถ้าลูกค้าระบุจำนวน ให้คำนวณยอดรวม: จำนวน × ราคาต่อหน่วย
- รูปแบบตอบ:
  • เดี่ยว: "ชื่อสินค้า ราคา N บาท ต่อ <unit>" (+ “• รวม = … บาท” ถ้าระบุจำนวน)
  • หลายตัว: ใช้บูลเล็ต "• ชื่อ ราคา N บาท ต่อ <unit>"
- ถ้าราคาว่าง/ไม่ชัดเจน ให้แจ้ง: "กรุณาโทร 088-277-0145"

SALES GUIDANCE (value add)
- แนะนำรุ่น/ขนาด/ความหนา/อุปกรณ์เสริมที่เหมาะ (เช่น โครง, สกรู, ปูนยาแนว) ถ้าเกี่ยวข้อง
- ถ้ามีคำถามก่อนซื้อ (พื้นที่ใช้งาน, สภาพแวดล้อม, กันชื้น/กันไฟ ฯลฯ) ให้ถามชี้นำสั้น ๆ 1 ข้อเท่านั้น

POLICY REMINDERS (เฉพาะเมื่อเกี่ยวข้อง)
- สั่งซื้อ: ยืนยันสั้น ๆ
- ชำระเงิน: โอนก่อนเท่านั้น
- จัดส่ง: กทม.และปริมณฑล Lalamove ร้านเป็นผู้เรียกรถ ลูกค้าจ่ายค่าส่งเอง

DO NOT
- ห้ามยืนยันสต๊อก/การส่ง/การชำระเงินหากลูกค้าไม่ได้ถาม
- ห้ามเดาข้อมูลนอก CATALOG
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

        // ---- AI-only flow: always ask the model (no code-based selection)
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
