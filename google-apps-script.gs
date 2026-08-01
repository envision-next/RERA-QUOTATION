/************************************************************
 * RERA Easy — Quotation backend (Google Apps Script)
 * ----------------------------------------------------------
 * Paste this whole file into the Apps Script editor of your
 * Google Sheet (Extensions ▸ Apps Script), then Deploy as a
 * Web App. Full steps are in SETUP.md.
 *
 * What it does:
 *   • Login-protected: every request (except login) carries a
 *     token issued at sign-in. Users see only their own saved
 *     quotations; admins see everything and manage accounts.
 *   • Stores every saved quotation as a row in the Sheet, with
 *     createdBy / creatorName columns for per-person analytics.
 *   • Issues quotation numbers (QT0001, QT0002, …) from ONE
 *     shared counter, locked so two people saving at the same
 *     time can never get the same number, and numbers are
 *     never reused (monotonic).
 *
 * FIRST-TIME SETUP after pasting:
 *   1. In the toolbar function dropdown pick "seedAdmin" and
 *      click Run (creates login  admin / admin123).
 *   2. Deploy ▸ Manage deployments ▸ Edit ▸ New version.
 *   3. Sign in to the app as admin and change the password
 *      (Team Logins ▸ re-save "admin" with a new password).
 ************************************************************/

var SHEET_NAME  = "Quotations";
var USERS_NAME  = "Users";
var COUNTER_KEY = "quoteCounter";
var TOKEN_DAYS  = 7; // sign-in stays valid this long

// Column order written to the sheet (analytics-friendly). The full
// quotation JSON stays where it always was; the login columns are
// appended AFTER it so rows saved before login existed still parse.
var HEADER = [
  "quoteNo", "savedAt", "date", "validTill", "status",
  "customer", "phone", "email", "address",
  "project", "reraNumber",
  "services", "serviceCount",
  "subtotal", "discountRate", "discountAmt",
  "gstRate", "gstAmt", "grandTotal",
  "notes", "json",
  "createdBy", "creatorName"
];
var JSON_COL = HEADER.indexOf("json");

var USERS_HEADER = [
  "username", "name", "role", "salt", "passwordHash",
  "token", "tokenExp", "createdAt", "active"
];

/* ---------- HTTP entry points ---------- */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "";
  if (action === "next") return json({ quoteNo: peekNext() });
  // data never leaves without a token — use POST {action:"list", token}
  return json({ error: "auth" });
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json({ error: "Bad request body" });
  }

  if (body.action === "login") return json(login(body.username, body.password));

  var user = auth(body.token);
  if (!user) return json({ error: "auth" });

  if (body.action === "save")
    return json({ record: saveRecord(body.record || {}, user) });

  if (body.action === "delete") {
    var err = deleteRecord(body.quoteNo, user);
    return json(err ? { error: err } : { ok: true });
  }

  if (body.action === "list") {
    var all = listAll();
    if (user.role !== "admin")
      all = all.filter(function (q) { return q.createdBy === user.username; });
    return json({ quotations: all, me: publicUser(user) });
  }

  // lightweight session check — the app polls this to notice a forced
  // logout (someone signed in elsewhere) without a page refresh
  if (body.action === "me") return json({ me: publicUser(user) });

  if (body.action === "changePassword")
    return json(changePassword(user, body.oldPassword, body.newPassword));

  if (body.action === "listUsers") {
    if (user.role !== "admin" && user.role !== "manager") return json({ error: "auth" });
    return json({ users: listUsers() });
  }

  if (body.action === "createUser") {
    if (user.role !== "admin" && user.role !== "manager") return json({ error: "auth" });
    var res = upsertUser(body.user || {}, user);
    return json(res);
  }

  return json({ error: "Unknown action" });
}

/* ---------- users & sessions ---------- */

function usersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(USERS_NAME);
  if (!sh) {
    sh = ss.insertSheet(USERS_NAME);
    sh.appendRow(USERS_HEADER);
    sh.setFrozenRows(1);
  }
  return sh;
}

function hashPass(salt, pass) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + "|" + String(pass),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function userRows() {
  return usersSheet().getDataRange().getValues();
}

function rowToUser(row) {
  var u = {};
  USERS_HEADER.forEach(function (h, i) { u[h] = row[i]; });
  return u;
}

function publicUser(u) {
  return { username: u.username, name: u.name, role: u.role };
}

function findUserRow(username) {
  var rows = userRows();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === String(username).toLowerCase())
      return { index: i + 1, user: rowToUser(rows[i]) };
  }
  return null;
}

// ONE active session per user: a new sign-in replaces the old token,
// and the old device drops to the sign-in screen on its next session
// check (the app polls every 30s). The token cell holds a JSON list
// of {t: token, e: expiry}; old plain-uuid cells still parse.
var MAX_SESSIONS = 1;

function parseTokens(cell, legacyExp) {
  var s = String(cell || "");
  if (s.charAt(0) === "[") {
    try { return JSON.parse(s); } catch (err) { return []; }
  }
  return s ? [{ t: s, e: Number(legacyExp) || 0 }] : [];
}

function liveTokens(list) {
  var now = Date.now();
  return list.filter(function (x) { return x && x.t && Number(x.e) > now; });
}

function login(username, password) {
  if (!username || !password) return { error: "Enter username and password" };
  var hit = findUserRow(username);
  if (!hit || String(hit.user.active) === "false" || hit.user.active === false)
    return { error: "Wrong username or password" };
  if (hashPass(hit.user.salt, password) !== hit.user.passwordHash)
    return { error: "Wrong username or password" };

  var token = Utilities.getUuid();
  var exp = Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000;
  var list = liveTokens(parseTokens(hit.user.token, hit.user.tokenExp));
  list.push({ t: token, e: exp });
  if (list.length > MAX_SESSIONS) list = list.slice(list.length - MAX_SESSIONS);
  var sh = usersSheet();
  sh.getRange(hit.index, USERS_HEADER.indexOf("token") + 1).setValue(JSON.stringify(list));
  sh.getRange(hit.index, USERS_HEADER.indexOf("tokenExp") + 1).setValue("");
  return { token: token, username: hit.user.username, name: hit.user.name, role: hit.user.role };
}

function auth(token) {
  if (!token) return null;
  var rows = userRows();
  var ti = USERS_HEADER.indexOf("token");
  var ei = USERS_HEADER.indexOf("tokenExp");
  for (var i = 1; i < rows.length; i++) {
    var list = liveTokens(parseTokens(rows[i][ti], rows[i][ei]));
    for (var j = 0; j < list.length; j++) {
      if (list[j].t === token) {
        var u = rowToUser(rows[i]);
        if (String(u.active) === "false" || u.active === false) return null;
        return u;
      }
    }
  }
  return null;
}

function listUsers() {
  var rows = userRows();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var u = rowToUser(rows[i]);
    out.push({
      username: u.username, name: u.name, role: u.role,
      active: !(String(u.active) === "false" || u.active === false)
    });
  }
  return out;
}

// admin (or a manager the admin appointed) creates a new login, or
// updates an existing one (new name, role, active flag, and — when a
// password is supplied — new password). Managers may only create and
// edit plain "user" accounts; roles stay in admin's hands.
function upsertUser(u, actor) {
  if (!u.username) return { error: "Username required" };
  var role = u.role === "admin" ? "admin" : u.role === "manager" ? "manager" : "user";
  var hit = findUserRow(u.username);
  if (actor && actor.role !== "admin") {
    if (role !== "user") return { error: "Only admin can create admins or managers" };
    if (hit && hit.user.role !== "user") return { error: "Only admin can edit this account" };
  }
  if (!hit && !u.password) return { error: "Password required for a new user" };

  var salt, hash;
  if (u.password) {
    salt = Utilities.getUuid();
    hash = hashPass(salt, u.password);
  } else {
    salt = hit.user.salt;
    hash = hit.user.passwordHash;
  }
  var row = [
    String(u.username).trim(),
    u.name || (hit ? hit.user.name : u.username),
    role,
    salt, hash,
    hit ? hit.user.token : "",
    hit ? hit.user.tokenExp : "",
    hit ? hit.user.createdAt : new Date().toISOString(),
    u.active === false ? false : true
  ];
  var sh = usersSheet();
  if (hit) sh.getRange(hit.index, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true, users: listUsers() };
}

// any signed-in user can change their own password (old one required)
function changePassword(user, oldPass, newPass) {
  if (!newPass || String(newPass).length < 4)
    return { error: "New password must be at least 4 characters" };
  var hit = findUserRow(user.username);
  if (!hit) return { error: "auth" };
  if (hashPass(hit.user.salt, oldPass) !== hit.user.passwordHash)
    return { error: "Current password is wrong" };
  var salt = Utilities.getUuid();
  var sh = usersSheet();
  sh.getRange(hit.index, USERS_HEADER.indexOf("salt") + 1).setValue(salt);
  sh.getRange(hit.index, USERS_HEADER.indexOf("passwordHash") + 1).setValue(hashPass(salt, newPass));
  return { ok: true };
}

/* Run ONCE from the editor after pasting: creates admin / admin123.
   Change the password right after your first sign-in. */
function seedAdmin() {
  usersSheet();
  upsertUser({ username: "admin", name: "Admin", role: "admin", password: "admin123" });
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
    JSON.stringify(record),
    record.createdBy || "",
    record.creatorName || ""
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

function saveRecord(record, user) {
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

    // who saved it — updates keep the original owner
    if (rowIndex !== -1) {
      try {
        var prev = JSON.parse(rows[rowIndex - 1][JSON_COL] || "{}");
        record.createdBy = prev.createdBy || user.username;
        record.creatorName = prev.creatorName || user.name;
      } catch (err) {
        record.createdBy = user.username;
        record.creatorName = user.name;
      }
    } else {
      record.createdBy = user.username;
      record.creatorName = user.name;
    }

    var values = buildRow(record);
    if (rowIndex === -1) sh.appendRow(values);
    else sh.getRange(rowIndex, 1, 1, values.length).setValues([values]);

    return record;
  } finally {
    lock.releaseLock();
  }
}

// users may delete only their own quotations; admins any
function deleteRecord(quoteNo, user) {
  if (!quoteNo) return null;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet();
    var rows = sh.getDataRange().getValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === quoteNo) {
        if (user.role !== "admin") {
          var owner = "";
          try { owner = (JSON.parse(rows[i][JSON_COL] || "{}").createdBy) || ""; } catch (err) {}
          if (owner && owner !== user.username) return "Only admin can delete this quotation";
        }
        sh.deleteRow(i + 1);
      }
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- one-time reset (run manually from the editor) ----------
   Select "resetAll" in the toolbar function dropdown and click Run.
   Wipes all saved rows and restarts numbering, so the next save is
   QT0001. Does NOT touch the Users tab or anything served over the
   web. ----------------------------------------------------------- */
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
