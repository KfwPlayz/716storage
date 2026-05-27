# 716 Storage Overdue Sync

Scrapes the **Collections Report** from `716selfstorage.storageunitsoftware.com/reports/collections` daily, and pushes each past-due renter to a Zapier webhook → GHL with the `overdue_payment` tag.

The GHL workflow uses a **timestamp staleness check** to auto-remove the tag from anyone who paid (they stop appearing in the scrape → their `last_seen_overdue` stamp goes stale → workflow exits them).

---

## What it scrapes

For each past-due customer on the report:

| Field | Source |
|---|---|
| `full_name` / `first_name` / `last_name` | Customer column |
| `customer_id` | Customer link href (`/customers/:id`) |
| `balance` | Balance column (numeric only, no `$`) |
| `phone` | Cell phone (preferred), falls back to landline. Normalized to E.164 (`+17162447284`) |
| `cell` | Cell phone explicitly (E.164) |
| `home_phone` | Landline / "Phone:" field (E.164) |
| `email` | Email address from Contact column |
| `rentals` | All unit badges joined, e.g. `"Unit 1, Unit 53"` |
| `days_overdue` | Days Behind column (integer) |
| `last_seen_overdue` | ISO timestamp of this scrape run (top-level) |

---

## 1. First-time setup

### Push this folder to a **private** GitHub repo

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR-ORG/716-storage-overdue-sync.git
git push -u origin main
```

### Add three repo secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name                  | Value                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| `STORAGE_EMAIL`       | The 716 Storage login email                                           |
| `STORAGE_PASSWORD`    | The 716 Storage login password                                        |
| `ZAPIER_WEBHOOK_URL`  | `https://hooks.zapier.com/hooks/catch/20665472/4oqwqpa/`              |

---

## 2. Zapier setup (create this BEFORE running the GitHub workflow)

Build one Zap:

**Step 1 — Trigger: Webhooks by Zapier → Catch Hook**
- URL is the one already in your `ZAPIER_WEBHOOK_URL` secret above.
- To test, you can either trigger one manual GitHub Actions run OR wait for the first scheduled run to populate sample data.

**Step 2 — Action: GoHighLevel → Find or Create Contact**
- Lookup by: **Phone** → map `lead.phone` (already E.164 formatted)
- On create:
  - First Name → `lead.first_name`
  - Last Name → `lead.last_name`
  - Email → `lead.email`
  - Phone → `lead.phone`

**Step 3 — Action: GoHighLevel → Update Contact**
- Contact ID: from Step 2
- Custom fields:
  - `days_overdue` → `lead.days_overdue`
  - `last_seen_overdue` → top-level `last_seen_overdue` ← **critical for the auto-remove logic**
  - `unit_number` → `lead.rentals`
  - `balance` → `lead.balance`
  - (Optional) `home_phone` → `lead.home_phone` (in case you want to fall back to landline for ringless voicemail later)

**Step 4 — Action: GoHighLevel → Add Contact Tag**
- Tag: `overdue_payment`

Turn the Zap on.

---

## 3. GHL setup

### Custom fields (Settings → Custom Fields, on Contact object)

| Name                  | Type             |
| --------------------- | ---------------- |
| `days_overdue`        | Numeric          |
| `last_seen_overdue`   | Date / Date Time |
| `unit_number`         | Text             |
| `balance`             | Text (or Monetary) |
| `home_phone`          | Phone (optional) |

### Workflow: "Overdue Payment Reminder"

**Trigger:** Contact Tag → tag `overdue_payment` is added

**Steps:**

1. **Wait** until business hours (e.g., 10:00 AM contact time, Mon–Sat).
2. **If/Else: `days_overdue`**
   - `<= 5` → Send SMS: gentle reminder *("Hey {first_name}, just a heads up — your storage unit {unit_number} is showing past due. Let us know if you need a hand sorting it out!")*
   - `6–15` → Send SMS: firmer reminder, mention balance
   - `>= 16` → Send SMS: final notice, mention next steps
3. **Wait 26 hours**
4. **If/Else: is `last_seen_overdue` within the last 25 hours?**
   - **Yes** (still overdue) → loop back to step 2
   - **No** (they paid — didn't show up in the latest scrape) → **Remove tag `overdue_payment`** → End workflow

That last step is the "stop texting once they pay" mechanism. The scrape runs daily and refreshes `last_seen_overdue` for everyone still overdue, so paid contacts will have a stale timestamp on the next check and exit cleanly.

---

## 4. Run it

The workflow runs automatically every day at **13:00 UTC** (8 AM ET in summer, 9 AM ET in winter). Adjust the cron in `.github/workflows/sync.yml` if needed.

**To trigger manually** (recommended for the first run):

1. Go to repo → **Actions → Sync 716 Storage Overdue → Run workflow**
2. Leave `debug_dump = false`
3. Click **Run workflow**
4. Open the run → check logs. You should see `📤 Sent: <name> | <phone> | ...` for each customer.
5. Open Zapier → confirm the catch hook received the test data → finish wiring the Zap → turn it on.

---

## 5. Troubleshooting

### "0 customers extracted"

The script auto-saves `debug_overdue_page.html` + `.png` and uploads them as workflow artifacts. Download from the failed run, send back, and selectors can be tightened.

You can also force a debug dump anytime: **Run workflow → toggle `debug_dump = true`**. It logs in, dumps the page, and exits without sending anything.

### Login fails

Check `failure.png` / `failure.html` in the workflow artifacts. The two-step login flow (email → continue → password) is handled, but if the form changes you may need to update the selectors in the `🔐 Two-step login` block of `sync.js`.

### Some customers skipped with "no valid phone"

The script needs at least a cell OR landline to send an SMS-able contact to GHL. Customers with only an email get logged and skipped. Check `phone_raw` / `cell_raw` in the log output to confirm the contact column parsed correctly.

### Cloudflare or bot blocking

GitHub Actions runs on Azure IPs. If you ever see login failures specifically tied to bot detection, the same script can be moved to Windows Task Scheduler on your machine (or a Hetzner VPS) — just set the same env vars in a `.env` file and run `node sync.js`.

---

## Local testing

```bash
npm install
cp .env.example .env
# Edit .env with real credentials (webhook URL is already filled in)
node -r dotenv/config sync.js
# or for debug dump:
DEBUG_DUMP=1 node -r dotenv/config sync.js
```

(`dotenv` is only needed locally; install it with `npm i -D dotenv`.)
