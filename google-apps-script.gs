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
    sh.appendRow(["quoteNo", "savedAt", "customer", "status", "date", "total", "json"]);
  }
  return sh;
}

function listAll() {
  var rows = sheet().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var j = rows[i][6];
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

    var total = sum(record.services) + sum(record.customItems);
    var values = [
      record.quoteNo,
      record.savedAt,
      (record.customer && record.customer.name) || "",
      record.status || "",
      record.date || "",
      total,
      JSON.stringify(record),
    ];

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

/* ---------- tiny utils ---------- */

function sum(items) {
  return (items || []).reduce(function (s, it) { return s + (it.amt || 0); }, 0);
}
function pad(n) {
  var s = String(n);
  while (s.length < 4) s = "0" + s;
  return s;
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
