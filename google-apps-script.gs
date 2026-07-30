/************************************************************
 * RERA Easy — Quotation backend (Google Apps Script)
 * ----------------------------------------------------------
 * Paste this whole file into the Apps Script editor of your
 * Google Sheet (Extensions ▸ Apps Script), then Deploy as a
 * Web App. Full steps are in SETUP.md.
 *
 * What it does:
 *   • Stores every saved quotation as a row in the Sheet.
 *   • Issues quotation numbers (QT0001, QT0002, …) from ONE
 *     shared counter, locked so two people saving at the same
 *     time can never get the same number, and numbers are
 *     never reused (monotonic).
 ************************************************************/

var SHEET_NAME  = "Quotations";
var COUNTER_KEY = "quoteCounter";

// Column order written to the sheet (analytics-friendly). The full
// quotation JSON stays in the last column for completeness.
var HEADER = [
  "quoteNo", "savedAt", "date", "validTill", "status",
  "customer", "phone", "email", "address",
  "project", "reraNumber",
  "services", "serviceCount",
  "subtotal", "discountRate", "discountAmt",
  "gstRate", "gstAmt", "grandTotal",
  "notes", "json"
];
var JSON_COL = HEADER.length - 1; // 0-based index of the json column

/* ---------- HTTP entry points ---------- */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "list";
  if (action === "next") return json({ quoteNo: peekNext() });
  return json({ quotations: listAll() });
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json({ error: "Bad request body" });
  }
  if (body.action === "save")   return json({ record: saveRecord(body.record || {}) });
  if (body.action === "delete") { deleteRecord(body.quoteNo); return json({ ok: true }); }
  return json({ error: "Unknown action" });
}

/* ---------- sheet helpers ---------- */

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADER);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Flatten a saved record into a sheet row matching HEADER.
function buildRow(record) {
  var a = record.analytics || {};
  var c = record.customer || {};
  var p = record.project || {};
  return [
    record.quoteNo,
    record.savedAt,
    record.date || "",
    record.validTill || "",
    record.status || "",
    c.name || "",
    c.phone || "",
    c.email || "",
    c.address || "",
    p.name || "",
    p.rera || "",
    a.servicesText || "",
    a.serviceCount || 0,
    a.subtotal || 0,
    a.discountRate || 0,
    a.discountAmt || 0,
    a.taxRate || 0,
    a.taxAmt || 0,
    a.grandTotal || 0,
    record.notes || "",
    JSON.stringify(record)
  ];
}

function listAll() {
  var rows = sheet().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var j = rows[i][JSON_COL];
    if (j) { try { out.push(JSON.parse(j)); } catch (err) {} }
  }
  return out;
}

/* ---------- shared, never-repeating numbers ---------- */

function currentMaxFromSheet() {
  var rows = sheet().getDataRange().getValues();
  var max = 0;
  for (var i = 1; i < rows.length; i++) {
    var m = /^QT(\d+)$/.exec(rows[i][0] || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// what the NEXT number will look like (preview, does not reserve it)
function peekNext() {
  var props = PropertiesService.getScriptProperties();
  var cur = props.getProperty(COUNTER_KEY);
  var n = (cur === null ? currentMaxFromSheet() : parseInt(cur, 10)) + 1;
  return "QT" + pad(n);
}

// reserve and return the next number (call only inside a lock)
function nextNumberAtomic() {
  var props = PropertiesService.getScriptProperties();
  var cur = props.getProperty(COUNTER_KEY);
  var base = (cur === null ? currentMaxFromSheet() : parseInt(cur, 10));
  var n = base + 1;
  props.setProperty(COUNTER_KEY, String(n));
  return "QT" + pad(n);
}

/* ---------- save / delete ---------- */

function saveRecord(record) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet();
    var rows = sh.getDataRange().getValues();
    var rowIndex = -1; // 1-based sheet row

    if (record.savedNo) {
      for (var i = 1; i < rows.length; i++) {
        if (rows[i][0] === record.savedNo) { rowIndex = i + 1; break; }
      }
    }

    if (rowIndex === -1) {
      record.quoteNo = nextNumberAtomic(); // brand new → fresh unique number
    } else {
      record.quoteNo = record.savedNo;     // update → keep its number
    }
    record.savedAt = new Date().toISOString();

    var values = buildRow(record);
    if (rowIndex === -1) sh.appendRow(values);
    else sh.getRange(rowIndex, 1, 1, values.length).setValues([values]);

    return record;
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord(quoteNo) {
  if (!quoteNo) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet();
    var rows = sh.getDataRange().getValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === quoteNo) sh.deleteRow(i + 1);
    }
  } finally {
    lock.releaseLock();
  }
}

/* ---------- one-time reset (run manually from the editor) ----------
   Select "resetAll" in the toolbar function dropdown and click Run.
   Wipes all saved rows and restarts numbering, so the next save is
   QT0001. Does NOT touch anything served over the web. ----------- */
function resetAll() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_NAME);
    if (sh) ss.deleteSheet(sh);          // drop old data + any old schema
    sh = ss.insertSheet(SHEET_NAME);     // recreate with the new HEADER
    sh.appendRow(HEADER);
    sh.setFrozenRows(1);
    PropertiesService.getScriptProperties().deleteProperty(COUNTER_KEY);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- tiny utils ---------- */

function pad(n) {
  var s = String(n);
  while (s.length < 4) s = "0" + s;
  return s;
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
