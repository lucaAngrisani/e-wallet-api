import "dotenv/config";
import express, { raw } from "express";
import cors from "cors";
import { Storage } from "@google-cloud/storage";

const app = express();

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
  (req, res) => {
    try {
      const ws = bucket
        .file(req.params.name)
        .createWriteStream({ contentType: "application/json" });
      ws.on("error", (e) => {
        console.error(e);
        res.status(500).json({ error: "write_failed" });
      });
      ws.on("finish", () => res.json({ ok: true, name: req.params.name }));
      ws.end(req.body); // <-- qui req.body è Buffer
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "write_failed" });
    }
  }
);

// SET BODY LIMIT
app.use(express.json({ limit: "32mb" }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Proxy GCS on :" + port));
