// index.js — Middleware DOKU Checkout ⇄ dslrBooth
// npm i express axios uuid qrcode dotenv cookie-parser

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const app = express();

// simpan RAW body untuk verifikasi signature callback DOKU
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

// ====== ENV & Config ======
const DOKU_BASE_URL     = (process.env.DOKU_BASE_URL || "https://api.doku.com").replace(/\/+$/, "");
const DOKU_CLIENT_ID    = process.env.DOKU_CLIENT_ID || "";
const DOKU_SECRET_KEY   = process.env.DOKU_SECRET_KEY || "";
const PUBLIC_BASE_URL   = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const DSLRBOOTH_API_URL = process.env.DSLRBOOTH_API_URL || "";
const PORT              = process.env.PORT || 3000;

// NEW: default payment methods (CSV), default ke QRIS saja biar langsung ke QRIS Checkout
const DEFAULT_PAYMENT_METHODS = (process.env.DEFAULT_PAYMENT_METHODS || "QRIS")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const COOKIE_SECURE = PUBLIC_BASE_URL.startsWith("https");

// ====== Utils ======
const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";
const digestBase64 = (s) => Buffer.from(crypto.createHash("sha256").update(s, "utf-8").digest()).toString("base64");
function signHmac({ clientId, requestId, requestTimestamp, requestTarget, digest, secret }) {
  let c = `Client-Id:${clientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${requestTimestamp}\nRequest-Target:${requestTarget}`;
  if (digest) c += `\nDigest:${digest}`;
  const sig = crypto.createHmac("sha256", secret).update(c).digest();
  return "HMACSHA256=" + Buffer.from(sig).toString("base64");
}

// NEW: generator invoice format timestamp
function makeInvoice() {
  const d = new Date();
  const pad = (n, w=2) => String(n).padStart(w, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(),3)}`;
  return `INV-${ts}`;
}

// ====== DOKU API ======
async function dokuCreatePayment({ amount, invoiceNumber, customer, callbackBase, paymentMethodTypes }) {
  const requestId = uuidv4();
  const requestTimestamp = nowIso();
  const requestTarget = "/checkout/v1/payment";

  const inv = invoiceNumber || requestId;
  const callbackUrl = `${callbackBase}/doku/callback`; // POST (server-to-server)
  const returnUrl   = `${callbackBase}/doku/callback?invoice=${encodeURIComponent(inv)}`; // GET (Back to Merchant)

  const body = {
    order: {
      amount,
      invoice_number: inv,
      currency: "IDR",
      callback_url: callbackUrl,
      callback_url_cancel: callbackUrl,
      // tulis di berbagai field biar Checkout menangkap return URL
      return_url: returnUrl,
      success_url: returnUrl,
      failed_url: `${callbackBase}/doku/callback?invoice=${encodeURIComponent(inv)}&status=FAILED`,
    },
    payment: { payment_due_date: 5 }, // menit
    customer: customer || { id: "guest", name: "Guest", phone: "628000000000", country: "ID" },
    additional_info: {
      return_url: returnUrl,
      success_page_url: returnUrl,
      front_callback_url: returnUrl,
      doku_wallet_notify_url: callbackUrl,
    }
  };
  // Kirim method hanya jika diminta (kalau undefined, biarkan DOKU pilih yang available)
  if (Array.isArray(paymentMethodTypes) && paymentMethodTypes.length > 0) {
    body.payment.payment_method_types = paymentMethodTypes;
  }

  const jsonBody = JSON.stringify(body);
  const digest = digestBase64(jsonBody);
  const signature = signHmac({
    clientId: DOKU_CLIENT_ID,
    requestId,
    requestTimestamp,
    requestTarget,
    digest,
    secret: DOKU_SECRET_KEY
  });

  const headers = {
    "Client-Id": DOKU_CLIENT_ID,
    "Request-Id": requestId,
    "Request-Timestamp": requestTimestamp,
    "Signature": signature,
    "Content-Type": "application/json"
  };

  console.log(">> createPayment callbackUrl =", callbackUrl);
  console.log(">> createPayment returnUrl   =", returnUrl);

  const { data } = await axios.post(DOKU_BASE_URL + requestTarget, jsonBody, { headers });
  return { data, invoiceNumber: inv };
}

async function dokuGetStatus(invoiceNumber) {
  const requestId = uuidv4();
  const requestTimestamp = nowIso();
  const requestTarget = `/orders/v1/status/${invoiceNumber}`;
  const signature = signHmac({
    clientId: DOKU_CLIENT_ID,
    requestId,
    requestTimestamp,
    requestTarget,
    secret: DOKU_SECRET_KEY
  });

  const headers = {
    "Client-Id": DOKU_CLIENT_ID,
    "Request-Id": requestId,
    "Request-Timestamp": requestTimestamp,
    "Signature": signature
  };

  const { data } = await axios.get(DOKU_BASE_URL + requestTarget, { headers });
  return data;
}

// ====== dslrBooth trigger (GET) ======
async function triggerDslrBooth({ invoiceNumber, amount }) {
  if (!DSLRBOOTH_API_URL) {
    console.warn("DSLRBOOTH_API_URL belum diset, skip trigger");
    return { skipped: true };
  }
  const url = `${DSLRBOOTH_API_URL}&invoice=${encodeURIComponent(invoiceNumber)}&amount=${encodeURIComponent(amount)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data ?? { ok: true };
}

// ====== Routes ======

// Buat session payment (JSON) -> kembalikan URL + QR data
app.post("/session", async (req, res) => {
  try {
    const { amount, invoice_number, customer, payment_method_types } = req.body || {};
    if (!amount) return res.status(400).json({ error: "amount wajib diisi" });
    if (!PUBLIC_BASE_URL) return res.status(400).json({ error: "PUBLIC_BASE_URL belum diset" });

    const { data, invoiceNumber } = await dokuCreatePayment({
      amount,
      invoiceNumber: invoice_number,
      customer,
      callbackBase: PUBLIC_BASE_URL,
      paymentMethodTypes: payment_method_types
    });

    const payUrl = data?.response?.payment?.url;
    if (!payUrl) return res.status(502).json({ error: "Tidak mendapat payment.url dari DOKU", raw: data });

    const qrDataUrl = await QRCode.toDataURL(payUrl);
    res.json({ ok: true, invoice_number: invoiceNumber, payment_url: payUrl, payment_qr_data_url: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: "Gagal membuat sesi pembayaran", detail: err?.response?.data || err?.message });
  }
});

// Halaman QR praktis untuk operator (GET) — tetap dipertahankan jika sewaktu-waktu butuh
app.get("/pay/:invoice", async (req, res) => {
  try {
    const baseInv = req.params.invoice || `INV-${Date.now()}`;
    const amount = Number(req.query.amount || 15000);
    const methods = req.query.method ? req.query.method.split(",") : undefined;

    const callbackBase = (req.query.callback_base || PUBLIC_BASE_URL).replace(/\/+$/, "");
    if (!callbackBase) return res.status(400).send("Set .env PUBLIC_BASE_URL atau query ?callback_base=");

    const { data, invoiceNumber } = await dokuCreatePayment({
      amount,
      invoiceNumber: baseInv,
      callbackBase,
      paymentMethodTypes: methods
    });

    const payUrl = data?.response?.payment?.url;
    if (!payUrl) return res.status(502).send("Gagal mendapatkan payment.url dari DOKU.");

    // set cookie invoice (fallback jika DOKU tidak kirim ?invoice= di return_url)
    res.cookie("doku_inv", invoiceNumber, {
      maxAge: 30 * 60 * 1000,   // 30 menit
      httpOnly: false,          // perlu dibaca dari JS jika mau
      sameSite: "Lax",
      secure: COOKIE_SECURE
    });

    const qrDataUrl = await QRCode.toDataURL(payUrl);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Bayar ${invoiceNumber}</title>
      <style>body{font-family:system-ui;margin:24px;text-align:center}</style></head>
      <body>
        <h3>Scan untuk bayar</h3>
        <p>Invoice: <b>${invoiceNumber}</b><br/>Amount: <b>Rp ${amount.toLocaleString("id-ID")}</b></p>
        <img src="${qrDataUrl}" alt="QR to Pay" style="width:320px;height:320px"/>
        <p><a href="${payUrl}" target="_blank" rel="noreferrer">Atau tap di sini</a></p>
      </body></html>
    `);
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    res.status(500).send("Gagal membuat QR/URL pembayaran.\n" + (status ? `HTTP ${status}\n` : "") + (data ? JSON.stringify(data, null, 2) : e?.message || ""));
  }
});

// CALLBACK server-to-server dari DOKU (POST)
app.post("/doku/callback", async (req, res) => {
  try {
    // logging
    console.log(">> [CALLBACK] headers:", {
      "Client-Id": req.header("Client-Id"),
      "Request-Id": req.header("Request-Id"),
      "Request-Timestamp": req.header("Request-Timestamp"),
      "Signature": req.header("Signature")
    });
    console.log(">> [CALLBACK] raw body:", req.rawBody?.toString("utf-8"));

    const clientId = req.header("Client-Id");
    const requestId = req.header("Request-Id");
    const requestTimestamp = req.header("Request-Timestamp");
    const receivedSignature = req.header("Signature");
    const requestTarget = "/doku/callback";

    const raw = req.rawBody ? req.rawBody.toString("utf-8") : JSON.stringify(req.body || {});
    const digest = digestBase64(raw);
    const expected = signHmac({
      clientId: clientId || DOKU_CLIENT_ID,
      requestId,
      requestTimestamp,
      requestTarget,
      digest,
      secret: DOKU_SECRET_KEY
    });

    if (receivedSignature !== expected) {
      console.warn(">> [CALLBACK] signature mismatch");
      return res.status(200).json({ ok: false, reason: "invalid signature" });
    }

    const invoiceNumber =
      req.body?.order?.invoice_number ||
      req.body?.order?.invoice_number_original ||
      req.body?.transaction?.invoice_number;
    const amount = req.body?.order?.amount || req.body?.transaction?.amount;
    const status = String(req.body?.transaction?.status || req.body?.status || "").toUpperCase();

    console.log(">> [CALLBACK] parsed:", { invoiceNumber, amount, status });

    if (status === "SUCCESS") {
      try {
        const trig = await triggerDslrBooth({ invoiceNumber, amount });
        console.log(">> [CALLBACK] dslrBooth triggered:", trig);
      } catch (e) {
        console.error(">> [CALLBACK] gagal trigger dslrBooth:", e?.response?.data || e?.message);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(">> [CALLBACK] error:", err?.message);
    return res.status(200).json({ ok: false, error: err?.message });
  }
});

// Landing GET untuk tombol "Back to Merchant" — cek status & trigger
app.get("/doku/callback", async (req, res) => {
  const invoice =
    req.query.invoice ||
    req.query.invoice_number ||
    req.query.order_id ||
    req.query.orderId ||
    req.cookies?.doku_inv || ""; // fallback dari cookie

  if (!invoice) {
    // NEW: kalau invoice tidak ada, arahkan balik ke home
    return res.redirect("/?status=UNKNOWN");
  }

  try {
    const data = await dokuGetStatus(invoice);
    const status = String(data?.transaction?.status || "").toUpperCase();
    const amount = data?.order?.amount || data?.transaction?.amount || 0;

    if (status === "SUCCESS") {
      await triggerDslrBooth({ invoiceNumber: invoice, amount });
    }
    // NEW: selalu redirect ke halaman utama dengan status + invoice
    const u = new URL(PUBLIC_BASE_URL || "http://localhost:" + PORT);
    u.searchParams.set("status", status || "UNKNOWN");
    u.searchParams.set("invoice", invoice);
    return res.redirect(u.toString());
  } catch (e) {
    // NEW: jika gagal cek status, tetap kembalikan ke home dgn info error
    const u = new URL(PUBLIC_BASE_URL || "http://localhost:" + PORT);
    u.searchParams.set("status", "ERROR");
    u.searchParams.set("message", (e?.message || "unknown error"));
    return res.redirect(u.toString());
  }
});

// Cek status (JSON)
app.get("/status/:invoice", async (req, res) => {
  try {
    const data = await dokuGetStatus(req.params.invoice);
    res.json({ ok: true, status: data?.transaction?.status, raw: data });
  } catch (err) {
    res.status(500).json({ error: "Gagal cek status", detail: err?.response?.data || err?.message });
  }
});

// (Opsional) trigger manual by invoice (dipakai kalau perlu)
app.post("/trigger/:invoice", async (req, res) => {
  try {
    const inv = req.params.invoice;
    const data = await dokuGetStatus(inv);
    const status = String(data?.transaction?.status || "").toUpperCase();
    const amount = data?.order?.amount || data?.transaction?.amount || 0;
    if (status === "SUCCESS") {
      const trig = await triggerDslrBooth({ invoiceNumber: inv, amount });
      return res.json({ ok: true, triggered: true, response: trig });
    }
    res.json({ ok: true, triggered: false, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message });
  }
});

// ====== NEW: Halaman utama dengan tombol "Lakukan Pembayaran"
app.get("/", (req, res) => {
  const status = (req.query.status || "").toUpperCase();
  const invoice = req.query.invoice || "";
  const message = req.query.message || "";

  const badge = status
    ? `<div style="margin:12px auto;max-width:560px;padding:12px 16px;border-radius:12px;border:1px solid #ddd">
        <b>Status:</b> ${status}${invoice ? ` &nbsp;•&nbsp; <b>Invoice:</b> ${invoice}` : ""}${message ? `<br/><small>${message}</small>` : ""}
      </div>`
    : "";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Photobooth Payment</title>
        <style>
          body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:24px;display:flex;justify-content:center}
          .card{max-width:640px;width:100%;text-align:center;padding:24px;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
          .btn{display:inline-block;margin-top:12px;padding:12px 18px;border-radius:12px;border:0;background:#342C2A;color:#fff;text-decoration:none;font-weight:600}
          .btn:active{transform:translateY(1px)}
          .hint{color:#6b7280;font-size:14px;margin-top:8px}
          /* --- Tambahan style avatar --- */
          .avatar{width:120px;height:120px;border-radius:9999px;object-fit:cover;display:block;margin:0 auto 12px;border:2px solid #e5e7eb}
          .title{margin:8px 0 4px}
          .subtitle{margin:0 0 12px;color:#6b7280;font-size:14px}
        </style>
      </head>
      <body>
        <div class="card">
          <!-- GAMBAR PROFIL DI SINI -->
          <img class="avatar" src="premio_logo.jpg" alt="Profil">
          <h2 class="title">Photobooth — Pembayaran</h2>
          <p class="subtitle">Klik tombol di bawah untuk membuat invoice otomatis dan menuju halaman Checkout.</p>
          ${badge}
          <a class="btn" href="/pay-now">Lakukan Pembayaran</a>
        </div>
      </body>
    </html>
  `);
});

// ====== NEW: Endpoint ringkas — generate invoice & amount=1 lalu redirect ke Checkout DOKU
app.get("/pay-now", async (req, res) => {
  try {
    if (!PUBLIC_BASE_URL) return res.status(500).send("PUBLIC_BASE_URL belum diset");
    const invoice = makeInvoice();
    const amount = 1; // Rp 1 sesuai requirement

    const { data } = await dokuCreatePayment({
      amount,
      invoiceNumber: invoice,
      callbackBase: PUBLIC_BASE_URL,
      paymentMethodTypes: DEFAULT_PAYMENT_METHODS // QRIS by default
    });

    const payUrl = data?.response?.payment?.url;
    if (!payUrl) return res.status(502).send("Gagal mendapatkan payment.url dari DOKU.");

    // Taruh cookie invoice sebagai fallback (tidak wajib)
    res.cookie("doku_inv", invoice, {
      maxAge: 30 * 60 * 1000,
      httpOnly: false,
      sameSite: "Lax",
      secure: COOKIE_SECURE
    });

    // Redirect langsung ke halaman checkout
    return res.redirect(payUrl);
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    res.status(500).send("Gagal membuat pembayaran.\n" + (status ? `HTTP ${status}\n` : "") + (data ? JSON.stringify(data, null, 2) : e?.message || ""));
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log("DOKU_BASE_URL  =", DOKU_BASE_URL);
  console.log("PUBLIC_BASE_URL=", PUBLIC_BASE_URL);
  console.log("DEFAULT_PAYMENT_METHODS =", DEFAULT_PAYMENT_METHODS.join(","));
});


