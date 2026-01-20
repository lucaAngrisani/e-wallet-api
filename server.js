import "dotenv/config";
import express, { raw } from "express";
import cors from "cors";
import { Storage } from "@google-cloud/storage";

const app = express();

function yahooHeaders() {
  return {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://finance.yahoo.com",
    "Referer": "https://finance.yahoo.com/",
  };
}

async function yahooLastPrice(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1d&interval=1m&includePrePost=false`;

  const r = await fetch(url, { headers: yahooHeaders() });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Yahoo chart error ${r.status}: ${text.slice(0, 200)}`);
  }

  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo chart: missing result");

  const meta = result.meta ?? {};
  const price = Number(meta.regularMarketPrice ?? meta.previousClose ?? NaN);

  // fallback: ultimo close dalla serie
  let lastClose = NaN;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes)) {
    for (let i = closes.length - 1; i >= 0; i--) {
      const v = Number(closes[i]);
      if (Number.isFinite(v) && v > 0) { lastClose = v; break; }
    }
  }

  const finalPrice = Number.isFinite(price) && price > 0 ? price : lastClose;
  if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
    throw new Error("Yahoo chart: invalid price");
  }

  return {
    symbol: String(meta.symbol ?? symbol).toUpperCase(),
    price: finalPrice,
    currency: String(meta.currency ?? ""),
    exchangeName: String(meta.exchangeName ?? ""),
    asOf: new Date((Number(meta.regularMarketTime ?? 0) || 0) * 1000).toISOString(),
    source: "yahoo-chart",
  };
}

// CORS
const originsEnv = (process.env.CORS_ORIGIN || "").trim();
const originOpt =
  originsEnv === "*"
    ? true
    : originsEnv
    ? originsEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : true;

const corsOptions = {
  origin: originOpt,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Api-Key"],
  credentials: false,
  maxAge: 86400,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// API key: lascia passare l'OPTIONS
const API_KEY = process.env.API_KEY || null;
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204); // <-- lascia stare la preflight
  if (!API_KEY) return next();
  if (req.header("X-Api-Key") === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// GCS
const BUCKET = process.env.GCS_BUCKET;
if (!BUCKET) throw new Error("GCS_BUCKET env mancante");

const storage = new Storage();
const bucket = storage.bucket(BUCKET);

// GET /json/:name
app.get("/json/:name", async (req, res) => {
  try {
    const file = bucket.file(req.params.name);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: "not_found" });
    const [buf] = await file.download();
    const text = buf.toString("utf8");
    res.json(text ? JSON.parse(text) : {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "read_failed" });
  }
});

// POST /json/:name
app.post(
  "/json/:name",
  raw({ type: "application/json", limit: "32mb" }),
  async (req, res) => {
    try {
      const file = bucket.file(req.params.name);
      const [exists] = await file.exists();

      // Se il file non esiste, lo crea comunque
      const ws = file.createWriteStream({ contentType: "application/json" });
      ws.on("error", (e) => {
        console.error(e);
        res.status(500).json({ error: "write_failed" });
      });
      ws.on("finish", () => res.json({ ok: true, name: req.params.name, created: !exists }));
      ws.end(req.body); // req.body è Buffer
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "write_failed" });
    }
  }
);

// GET /market/quote?symbol=ENEL.MI
app.get("/market/quote", async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "missing_symbol" });

    const quote = await yahooLastPrice(symbol);
    res.json(quote);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "quote_failed", message: e?.message ?? String(e) });
  }
});

// GET /market/batch?symbols=ENEL.MI,ENI.MI,ISP.MI
app.get("/market/batch", async (req, res) => {
  try {
    const symbolsRaw = String(req.query.symbols ?? "").trim();
    if (!symbolsRaw) return res.status(400).json({ error: "missing_symbols" });

    const symbols = Array.from(
      new Set(
        symbolsRaw
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    );

    const out = {};
    for (const s of symbols) {
      try {
        out[s] = await yahooLastPrice(s);
      } catch (e) {
        out[s] = { symbol: s, error: true, message: e?.message ?? String(e) };
      }
    }

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "batch_failed" });
  }
});

// SET BODY LIMIT
app.use(express.json({ limit: "32mb" }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Proxy GCS on :" + port));
