// Back of House Co — WhatsApp sender bot
// Logs into WhatsApp Web with a phone number (scan the QR once), then every few seconds
// picks up queued notifications from Back of House Co and sends them.
//
// ⚠️ This uses WhatsApp Web through an unofficial library. WhatsApp does not allow automated
//    use of normal accounts and may ban the number. Use a separate business SIM, not a personal number.

const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

// ---------------------------------------------------------------- settings (from config.json)
const CONFIG_FILE = path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_FILE)) {
  console.error("Missing config.json — copy config.example.json to config.json and paste your bot key.");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const OUTBOX_URL = cfg.outboxUrl || "https://gqusbphanvsqrieyhluo.supabase.co/functions/v1/boh-wa-outbox";
const BOT_KEY = cfg.botKey;
const POLL_SECONDS = Number(cfg.pollSeconds ?? 20);
const MIN_GAP = Number(cfg.minSecondsBetweenMessages ?? 4);
const MAX_GAP = Number(cfg.maxSecondsBetweenMessages ?? 10);
const MAX_PER_HOUR = Number(cfg.maxMessagesPerHour ?? 120);
if (!BOT_KEY || BOT_KEY.includes("PASTE")) {
  console.error("Put the bot key from Back of House Co → Settings → Notifications into config.json (botKey).");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleString("en-IN"), "-", ...a);

async function api(body) {
  const res = await fetch(OUTBOX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bot-secret": BOT_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".wa-session") }),
  puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("qr", (qr) => {
  log("Scan this QR with WhatsApp on the business phone (Settings → Linked devices → Link a device):");
  qrcode.generate(qr, { small: true });
});
client.on("authenticated", () => log("Logged in."));
client.on("auth_failure", (m) => log("Login failed:", m, "— delete the .wa-session folder and start again."));
client.on("disconnected", (r) => { log("Disconnected:", r, "— restarting in 30s"); setTimeout(() => process.exit(1), 30000); });

let sentTimes = [];
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    sentTimes = sentTimes.filter((t) => Date.now() - t < 3600_000);
    const room = MAX_PER_HOUR - sentTimes.length;
    if (room <= 0) { log(`Hourly limit (${MAX_PER_HOUR}) reached — waiting.`); return; }
    const { messages = [], paused } = await api({ action: "claim", limit: Math.min(10, room) });
    if (paused) return;
    if (!messages.length) return;
    log(`Sending ${messages.length} message(s)…`);
    const results = [];
    for (const m of messages) {
      try {
        const numberId = await client.getNumberId(m.address); // null if the number is not on WhatsApp
        if (!numberId) { results.push({ id: m.id, ok: false, notOnWhatsApp: true, error: `${m.address} is not on WhatsApp` }); continue; }
        await client.sendMessage(numberId._serialized, m.body);
        results.push({ id: m.id, ok: true });
        sentTimes.push(Date.now());
        log("✓", m.address);
      } catch (e) {
        results.push({ id: m.id, ok: false, error: String(e && e.message || e) });
        log("✗", m.address, e && e.message);
      }
      // random pause between messages — looks less like a bot
      await sleep((MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP)) * 1000);
    }
    await api({ action: "report", results });
  } catch (e) {
    log("Problem talking to Back of House Co:", e.message);
  } finally {
    running = false;
  }
}

client.on("ready", () => {
  log("WhatsApp is ready. Checking for messages every", POLL_SECONDS, "seconds. Keep this window open.");
  tick();
  setInterval(tick, POLL_SECONDS * 1000);
});

client.initialize();
