# Go Live — Google Sheet storage + shared numbers + Netlify

This makes the quotation app **live on the internet**, stores every saved
quotation in **one Google Sheet**, and gives **unique quotation numbers for
everyone** (no two people can ever get the same number).

There are two parts:

- **Part A** – the Google Sheet backend (storage + numbering)
- **Part B** – hosting the site on Netlify

Do Part A first, because it gives you a URL you paste into the app.

---

## Part A — Google Sheet backend (about 5 minutes)

1. Go to <https://sheets.google.com> and create a **new blank spreadsheet**.
   Name it something like `RERA Easy Quotations`.

2. In that sheet, open the menu **Extensions ▸ Apps Script**.
   A code editor opens in a new tab.

3. Delete whatever code is in the editor, then open the file
   **`google-apps-script.gs`** (in this project folder), copy **everything**,
   and paste it into the Apps Script editor. Click the **💾 Save** icon.

4. Click **Deploy ▸ New deployment**.
   - Click the ⚙️ gear next to "Select type" → choose **Web app**.
   - **Description:** anything (e.g. `quotation api`).
   - **Execute as:** **Me**.
   - **Who has access:** **Anyone**.
     *(This only exposes the script URL, not your Google account. Keep the
     URL private — treat it like a password.)*
   - Click **Deploy**.

5. The first time, Google asks you to **Authorize access** →
   choose your account → if it warns "Google hasn't verified this app",
   click **Advanced ▸ Go to (your project)** → **Allow**.

6. Copy the **Web app URL**. It looks like:
   `https://script.google.com/macros/s/AKfy........./exec`

7. Open **`app.js`** in this project and paste that URL into the line near
   the top:

   ```js
   const SHEET_API_URL = "https://script.google.com/macros/s/AKfy........./exec";
   ```

   Save the file. **Done** — the app now stores everything in your Sheet and
   hands out shared, never-repeating numbers.

> Test it: open the app, fill a quotation, click **💾 Save**. A row appears in
> the `Quotations` tab of your Google Sheet, and the number becomes the real
> server number (e.g. `QT0001`). Save another → `QT0002`, on any device.

### If you ever change the code

Re-deploy with **Deploy ▸ Manage deployments ▸ ✏️ Edit ▸ Version: New version ▸
Deploy**. The URL stays the same, so you don't need to touch `app.js` again.

---

## Part B — Put the site live on Netlify (about 3 minutes)

The app is plain files (no build step), so this is drag-and-drop.

1. Make sure `SHEET_API_URL` in `app.js` is already filled in (Part A step 7).

2. Go to <https://app.netlify.com/drop>.
   (Sign up / log in — free.)

3. Drag the **whole `Quotation` folder** onto that page.

4. Netlify uploads it and gives you a live link like
   `https://your-name-123.netlify.app`. Share that link — anyone can use it.

5. (Optional) In **Site settings ▸ Change site name** you can rename it to
   something like `reraeasy-quotations.netlify.app`.

### Updating the live site later

When you change any file, just drag the folder onto
<https://app.netlify.com/drop> again (or, in the site's **Deploys** tab, drop
the folder there) to publish the new version.

---

## How the shared numbering works (plain English)

- The app **never** decides the number itself anymore.
- When you press **Save**, the app asks the Google Sheet script for the next
  number. The script uses a **lock**, so if two people save at the same second,
  one gets `QT0007` and the other `QT0008` — never the same one.
- Numbers are **monotonic**: deleting a quotation does **not** free up its
  number for reuse.
- The number shown before you save is just a **preview**; the real one is
  assigned (and shown) the moment you click Save.

## Notes & limits

- **Keep the Web App URL private.** Anyone with it can read/write the sheet.
  If it leaks, redeploy a new deployment to get a fresh URL and update `app.js`.
- **Rates/fees** still save per-browser (they're settings, not quotations) —
  that's intentional.
- Free Google quota is far more than a consultancy needs (thousands of
  saves/day).
- Until you fill in `SHEET_API_URL`, the app quietly keeps working with
  browser-only storage, so nothing breaks in the meantime.
