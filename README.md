# Rateaura Technology — Invoicing & Accounts

A lightweight, password-protected Invoice + Receivable + Payable tracker for international B2B billing (USD/INR, no tax/GST). Runs entirely as a static site on GitHub Pages, with a Google Sheet as the database.

No servers, no monthly cost, no build step.

---

## How it works

- **Frontend**: plain HTML/CSS/JS, hosted free on GitHub Pages.
- **Database**: a Google Sheet you own — every customer, vendor, invoice, and payment is a row in it, so you can always open the Sheet directly to double check anything.
- **Backend**: a small Google Apps Script (also free) that sits in front of the Sheet and talks to the website.
- **Login**: a single password, hashed and stored in the Sheet (not visible in your public GitHub code).

---

## Part 1 — Set up the database (Google Sheet)

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet. Name it e.g. `Rateaura Invoicing DB`.
2. In the menu, go to **Extensions → Apps Script**. This opens a script editor tied to this specific sheet.
3. Delete anything in the default `Code.gs` file, and paste in the entire contents of **`apps-script/Code.gs`** from this project.
4. Click the **Save** icon (💾).
5. In the function dropdown at the top (next to "Debug"), select **`setupSheets`**, then click **Run** (▶).
   - The first time, Google will ask you to authorize the script — click **Review permissions**, choose your Google account, click **Advanced → Go to (project name)**, then **Allow**.
   - This creates all the tabs your app needs (Config, Customers, Vendors, Invoices, Payments, Payables, PaySettlements) with sensible defaults, including the company name pre-filled as "Rateaura Technology Limited".
6. Now deploy it as a web app: click **Deploy → New deployment**.
   - Click the gear icon next to "Select type" and choose **Web app**.
   - Description: anything, e.g. "Rateaura Invoicing API".
   - Execute as: **Me**.
   - Who has access: **Anyone**.
   - Click **Deploy**, authorize again if asked.
7. Copy the **Web app URL** it gives you (ends in `/exec`). You'll need this next.

> Anyone with this exact URL can only read/write through the actions your script defines — they can't browse your Drive or anything else. Still, don't publish this URL publicly beyond your own app.

---

## Part 2 — Connect the frontend

1. Open **`assets/app.js`** in this project.
2. At the very top, replace:
   ```js
   API_URL: 'PASTE_YOUR_APPS_SCRIPT_URL_HERE'
   ```
   with the URL you copied above, so it looks like:
   ```js
   API_URL: 'https://script.google.com/macros/s/AKfycb.../exec'
   ```
3. Save the file.

---

## Part 3 — Host it on GitHub Pages

1. Create a new **public or private** GitHub repository (e.g. `rateaura-invoicing`).
   - Private is fine — GitHub Pages works on private repos too if your account has Pages access; if not, use public (the site itself is still password-locked).
2. Upload all the files/folders from this project (`index.html`, `assets/`, `apps-script/` is optional to upload — it's just a reference copy, the real script lives in Google) — you can drag-and-drop via the GitHub web UI, or:
   ```bash
   git init
   git add .
   git commit -m "Initial commit — Rateaura invoicing app"
   git branch -M main
   git remote add origin https://github.com/<your-username>/rateaura-invoicing.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**.
4. Under "Build and deployment", set **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**. Save.
5. Wait a minute, then your app will be live at:
   ```
   https://<your-username>.github.io/rateaura-invoicing/
   ```

---

## Part 4 — First login & setup

1. Open your live site link. Since no password exists yet, whatever you type in the password box on first visit **becomes your password** going forward.
2. Go to **Company Settings** and fill in:
   - Company name, address, email, phone, website
   - Logo (upload an image — it's stored directly in the Sheet)
   - Bank details (for wire transfers — account number, IFSC for INR, SWIFT for USD)
   - Invoice prefix (defaults to `RA-INV-`) and next invoice number (defaults to `1001`)
3. Add your customers under **Customers**, and vendors under **Vendors** (vendors are for tracking what you owe — Payables).
4. Create your first invoice under **Invoices → + New Invoice**. The invoice number is assigned automatically in sequence (e.g. `RA-INV-1001`, `RA-INV-1002`, ...).
5. Click **PDF** on any invoice to download a formatted, professional invoice.
6. When a client pays, click **Settle** on that invoice and record the payment (full or partial) — the Dashboard's Receivable total updates automatically.
7. Same idea for **Payables**: add a vendor bill, then **Settle** it as you pay it off — this feeds the Payable total on the Dashboard.

---

## Troubleshooting

- **"Could not reach the backend" on login**: double-check `API_URL` in `assets/app.js` was pasted correctly and ends in `/exec`.
- **You edited `Code.gs` later and nothing changes**: Apps Script URLs don't auto-update on save. After editing the script, go to **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy** — this is the step people most often miss.
- **Data isn't saving**: open the Google Sheet directly and check the tabs (Customers, Invoices, etc.) — if rows appear there but not on the website, it's usually a stale browser cache; hard-refresh the page.

## Notes & limits

- **This is casual protection, not bank-grade security.** The password gate stops casual access, but a technically determined person could inspect the API and interact with it directly if they had your Apps Script URL. Don't put highly sensitive data in it, and don't share the URL.
- **Currencies**: only USD and INR are supported, and there is no tax/GST calculation anywhere — totals are just quantity × rate, summed.
- **Multi-device**: since everything is stored in the Google Sheet (not the browser), you can log in from your phone or laptop and see the same data.
- **Backups**: your Google Sheet *is* your backup — you can open it any time to see the raw data, export to CSV, or make a copy.
- **Changing the password**: go to Company Settings → "Change Password" section.
