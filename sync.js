// 📌 716 Storage Overdue Sync
// Scrapes the Collections Report (past-due renters) from
// https://716selfstorage.storageunitsoftware.com/reports/collections
// and posts each one to a Zapier webhook → GHL (location WPHXIsSaU2aQpYy8rwzK).
//
// Required env vars:
//   EMAIL        - 716 Storage login email
//   PASSWORD     - 716 Storage login password
//   WEBHOOK_URL  - Zapier catch-hook URL
// Optional:
//   DEBUG_DUMP=1 - dump HTML + screenshot of the collections page, then exit
//                  (use this if scrape returns 0 customers, so selectors can be tuned)

const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔐 Constants
const BASE = "https://716selfstorage.storageunitsoftware.com";
const LOGIN_URL = `${BASE}/login`;
// per_page=200 to fit everyone on one page (small facility), sorted by balance desc so biggest first
const OVERDUE_URL = `${BASE}/reports/collections?per_page=200&filter=past_due&sort=balance`;

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DEBUG_DUMP = process.env.DEBUG_DUMP === "1";
const GHL_LOCATION_ID = "WPHXIsSaU2aQpYy8rwzK";

if (!EMAIL || !PASSWORD || !WEBHOOK_URL) {
  console.error("❌ Missing required env vars: EMAIL, PASSWORD, WEBHOOK_URL");
  process.exit(1);
}

// Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns "" if invalid.
function normalizePhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });

  const page = await browser.newPage();

  // === CI hardening (same as Vulcan) ===
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") req.abort();
    else req.continue();
  });

  page.on("console", (msg) => console.log("[BROWSER]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[PAGEERROR]", err));
  page.on("requestfailed", (req) =>
    console.log("[REQ FAILED]", req.url(), req.failure()?.errorText)
  );

  try {
    // ============================================================
    // 🔐 Two-step login: email → Continue → password → Login
    // ============================================================
    console.log("🔐 Loading login page...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    // --- Step 1: email ---
    await page.waitForSelector(
      'input[type="email"], input[name="email"], input[name="user[email]"], #email',
      { timeout: 60000 }
    );
    const emailSel = (await page.$('input[type="email"]'))
      ? 'input[type="email"]'
      : (await page.$('input[name="email"]'))
      ? 'input[name="email"]'
      : (await page.$('input[name="user[email]"]'))
      ? 'input[name="user[email]"]'
      : "#email";

    await page.type(emailSel, EMAIL, { delay: 30 });
    console.log(`  → typed email into ${emailSel}`);

    // Click Continue (could trigger navigation OR a JS-rendered password view)
    const continueClick = page.click(
      'button[type="submit"], input[type="submit"]'
    );

    // Wait for the password field to show up — handles both navigation and DOM-update flows
    await Promise.race([
      page
        .waitForSelector('input[type="password"], input[name="password"], #password', {
          timeout: 30000,
        })
        .then(() => "password_field"),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).then(() => "nav"),
    ]).catch((e) => console.log("  ⚠️ continue-wait race ended:", e.message));

    // Make sure the click resolved too
    await continueClick.catch(() => {});
    await sleep(500);

    // --- Step 2: password ---
    await page.waitForSelector('input[type="password"], input[name="password"], #password', {
      timeout: 30000,
    });
    const passSel = (await page.$('input[type="password"]'))
      ? 'input[type="password"]'
      : (await page.$('input[name="password"]'))
      ? 'input[name="password"]'
      : "#password";

    await page.type(passSel, PASSWORD, { delay: 30 });
    console.log(`  → typed password into ${passSel}`);

    await Promise.all([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);

    console.log("✅ Login complete, current URL:", page.url());

    // ============================================================
    // 📄 Load Collections Report (past-due filter, 200 per page)
    // ============================================================
    console.log("📄 Loading collections report...");
    await page.goto(OVERDUE_URL, { waitUntil: "domcontentloaded" });
    await sleep(1500);

    // 🐛 Debug-dump mode: save the rendered HTML + screenshot and exit
    if (DEBUG_DUMP) {
      const html = await page.content();
      fs.writeFileSync("debug_overdue_page.html", html);
      await page.screenshot({ path: "debug_overdue_page.png", fullPage: true });
      console.log("🐛 DEBUG: wrote debug_overdue_page.html and .png — exiting");
      await browser.close();
      return;
    }

    // ============================================================
    // 📋 Scrape every row from the collections table
    // Columns: Customer | Balance | Contact | Rentals | Days Behind | Status
    // ============================================================
    const customers = await page.evaluate(() => {
      const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
      const rows = document.querySelectorAll("table tbody tr");
      const out = [];

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) continue; // skip header / empty rows

        // --- Customer (col 0) ---
        const nameLink = cells[0].querySelector("a");
        const full_name = clean(nameLink?.innerText || cells[0].innerText);
        if (!full_name) continue;

        // Customer ID from link href, if pattern matches
        const href = nameLink?.getAttribute("href") || "";
        const idMatch = href.match(/\/customers?\/(\d+)/);
        const customer_id = idMatch ? idMatch[1] : "";

        // --- Balance (col 1) ---
        const balance_text = clean(cells[1].innerText);
        const balance = balance_text.replace(/[^0-9.]/g, "");

        // --- Contact (col 2) ---
        // Layout is something like:
        //   "Phone: (716) 307-4066"
        //   "Cell: (716) 244-7284"
        //   "email@example.com"
        // Any of those three lines may be missing.
        const contactCell = cells[2];
        const contactText = contactCell.innerText;

        const phoneMatch = contactText.match(/Phone:\s*([\d\s\-\(\)\.\+]+)/i);
        const cellMatch = contactText.match(/Cell:\s*([\d\s\-\(\)\.\+]+)/i);
        const phone = phoneMatch ? clean(phoneMatch[1]) : "";
        const cell = cellMatch ? clean(cellMatch[1]) : "";

        // Email — prefer mailto link if present, fall back to regex
        const mailto = contactCell.querySelector('a[href^="mailto:"]');
        let email = mailto
          ? mailto.getAttribute("href").replace(/^mailto:/, "").trim()
          : "";
        if (!email) {
          const em = contactText.match(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/);
          email = em ? em[0] : "";
        }

        // --- Rentals (col 3) — collect "Unit 1", "Unit 53", etc. ---
        const unitMatches = cells[3].innerText.match(/Unit\s+\S+/gi) || [];
        const rentals = Array.from(new Set(unitMatches.map(clean)));

        // --- Days Behind (col 4) ---
        const daysText = clean(cells[4].innerText);
        const daysNum = parseInt(daysText.replace(/\D/g, ""), 10);
        const days_overdue = Number.isFinite(daysNum) ? daysNum : null;

        out.push({
          customer_id,
          full_name,
          balance,
          phone_raw: phone,
          cell_raw: cell,
          email,
          rentals,
          days_overdue,
        });
      }
      return out;
    });

    console.log(`✅ Found ${customers.length} overdue customers`);

    if (customers.length === 0) {
      console.log("⚠️  No customers extracted — auto-saving debug artifacts.");
      const html = await page.content();
      fs.writeFileSync("debug_overdue_page.html", html);
      await page.screenshot({ path: "debug_overdue_page.png", fullPage: true });
    }

    // ============================================================
    // 📤 Send each customer to Zapier
    // Stamp every payload with `last_seen_overdue` so the GHL workflow
    // can detect stale (paid) contacts and remove their tag.
    // ============================================================
    const last_seen_overdue = new Date().toISOString();
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const c of customers) {
      // Prefer cell for the primary phone (textable). Fall back to phone if no cell.
      const cellE164 = normalizePhone(c.cell_raw);
      const phoneE164 = normalizePhone(c.phone_raw);
      const primary_phone = cellE164 || phoneE164;

      if (!primary_phone) {
        skipped++;
        console.log(`⏭️  Skipping ${c.full_name} — no valid phone (raw: phone="${c.phone_raw}" cell="${c.cell_raw}")`);
        continue;
      }

      const nameParts = c.full_name.split(/\s+/);
      const first_name = nameParts[0] || "";
      const last_name = nameParts.slice(1).join(" ");

      const payload = {
        timestamp: last_seen_overdue,
        last_seen_overdue,
        ghl_location_id: GHL_LOCATION_ID,
        tag: "overdue_payment",
        lead: {
          customer_id: c.customer_id,
          full_name: c.full_name,
          first_name,
          last_name,
          phone: primary_phone,        // best textable number → map this to GHL Phone
          cell: cellE164,              // explicit cell (E.164)
          home_phone: phoneE164,       // explicit landline/home phone (E.164)
          email: c.email,
          rentals: c.rentals.join(", "), // e.g. "Unit 1, Unit 53"
          rentals_array: c.rentals,
          days_overdue: c.days_overdue,
          balance: c.balance,
        },
      };

      try {
        await axios.post(WEBHOOK_URL, payload, { timeout: 15000 });
        sent++;
        console.log(
          `📤 Sent: ${c.full_name} | ${primary_phone} | ${c.rentals.join(",")} | ${c.days_overdue}d | $${c.balance}`
        );
      } catch (err) {
        failed++;
        console.error(`❌ Failed to send ${c.full_name}: ${err.message}`);
      }
      await sleep(150); // be polite to Zapier
    }

    console.log(`\n✅ Done. Sent: ${sent} | Failed: ${failed} | Skipped (no phone): ${skipped}`);
  } catch (err) {
    console.error("❌ Script Error:", err);
    try {
      await page.screenshot({ path: "failure.png", fullPage: true });
      const html = await page.content();
      fs.writeFileSync("failure.html", html);
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
