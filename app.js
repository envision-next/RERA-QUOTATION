/* ============================================================
   EnvisionNext Quotation — app.js

   Output design follows the RERA Easy-style consultation
   proposal (5.pdf): letterhead + kicker + big title, proposal
   letter, gold callout, Annexure A service cards (black head,
   gold fee pill, numbered scope items), Professional Fee box
   (exclusive of GST), Annexure B diamond-bullet documents in
   two columns, badge-numbered Terms & Conditions, sign-off.

   Working model (from the Briqhaus builder):
   - Catalogue of 18 MahaRERA services (10 individual + 4
     cumulative retainer packages A–D), each with scope items
     and required documents.
   - Ticking a service adds its Annexure A card instantly and
     rebuilds the de-duplicated Documents Required list.
   - Amounts prefill from an editable default-fee card (✎ Edits)
     and stay editable per quotation — panel & sheet stay in sync.
   - Professional Fee = Subtotal − Discount% (exclusive of GST);
     the GST-inclusive total shows in the panel preview.
   - Quotation numbers auto-increment: QT0001, QT0002, …
   - Save / load / delete via localStorage; status draft / sent /
     accepted / expired. Export PDF = print dialog → Save as PDF.

   Storage:
   - enq.quotations : saved quotes (see saveQuotation for shape)
   - enq.rates.v1   : { amounts:{serviceKey:fee}, gst }
   ============================================================ */

const STORAGE_KEY = "enq.quotations";
const RATES_KEY = "enq.rates.v1";

/* ============================================================
   BACKEND (Google Sheet)  ── shared storage + shared numbers
   ------------------------------------------------------------
   Paste your Google Apps Script Web App URL between the quotes
   below. See SETUP.md for the 5-minute setup.

   • Empty  → app saves to THIS browser only (localStorage).
   • Set    → every Save writes to the shared Google Sheet and
              the quotation number is issued by the server, so
              it is unique for the whole team and never repeats.
   ============================================================ */
const SHEET_API_URL = "https://script.google.com/macros/s/AKfycbz153uFaiXhZNLMJTpUYYfF6Xf09Fbk6za6yoaJBBeJj_Rki5OHdGHslTQ1Vy2lZw0Wag/exec"; // Apps Script Web App

// tracks the server-assigned number of the quotation currently
// on screen; null means "new, not saved yet"
let loadedQuoteNo = null;

/* ---------- login session ----------
   The server issues a token at sign-in; every data call carries it.
   Users see only their own quotations, admins see everything and
   manage the team's logins. */
const AUTH_KEY = "reraQuoteAuth";
let AUTH = null;
try { AUTH = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch {}

function setAuth(a) {
  AUTH = a;
  if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a));
  else localStorage.removeItem(AUTH_KEY);
  updateAuthUi();
}

function updateAuthUi() {
  const chip = $("authChip");
  if (chip) {
    chip.style.display = AUTH ? "" : "none";
    chip.textContent = AUTH ? `Hey, ${AUTH.name}` : "";
  }
  const users = $("btnUsers");
  if (users)
    users.style.display =
      AUTH && (AUTH.role === "admin" || AUTH.role === "manager") ? "" : "none";
  const out = $("btnLogout");
  if (out) out.style.display = AUTH ? "" : "none";
  const pass = $("btnPass");
  if (pass) pass.style.display = AUTH ? "" : "none";
}

/* self-service password change (old password required) */
function openPass() {
  $("cpOld").value = $("cpNew").value = $("cpNew2").value = "";
  $("cpErr").textContent = "";
  $("passWho").textContent = AUTH ? `Signed in as ${AUTH.name} (${AUTH.username})` : "";
  $("passOverlay").style.display = "flex";
  setTimeout(() => $("cpOld").focus(), 50);
}

async function doChangePassword() {
  const err = $("cpErr");
  err.textContent = "";
  if ($("cpNew").value !== $("cpNew2").value) {
    err.textContent = "New passwords do not match";
    return;
  }
  const btn = $("btnPassSave");
  btn.disabled = true;
  try {
    await Store._post({
      action: "changePassword",
      oldPassword: $("cpOld").value,
      newPassword: $("cpNew").value,
    });
    $("passOverlay").style.display = "none";
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function showLogin() {
  const ov = $("loginOverlay");
  if (ov) {
    ov.style.display = "flex";
    document.body.classList.add("modal-open"); // no scrolling behind the gate
    setTimeout(() => $("loginUser")?.focus(), 50);
  }
}
function hideLogin() {
  const ov = $("loginOverlay");
  if (ov) ov.style.display = "none";
  document.body.classList.remove("modal-open");
}

async function doLogin() {
  const err = $("loginErr");
  err.textContent = "";
  const btn = $("btnLogin");
  btn.disabled = true;
  try {
    const data = await Store._post({
      action: "login",
      username: $("loginUser").value.trim(),
      password: $("loginPass").value,
    });
    setAuth(data);
    hideLogin();
    $("loginPass").value = "";
    renderSavedList();
  } catch (e) {
    err.textContent = e.message === "Please sign in" ? "Wrong username or password" : e.message;
  } finally {
    btn.disabled = false;
  }
}

function doLogout() {
  setAuth(null);
  showLogin();
}

/* one session per user: if this login is used on another device, the
   server invalidates our token — poll a lightweight "me" check every
   30s (and on tab focus) so this device drops to the sign-in screen
   by itself, no refresh needed. _post handles the actual logout. */
async function checkSession() {
  if (!AUTH || !Store.remote()) return;
  try {
    await Store._post({ action: "me" });
  } catch (e) {
    /* auth failures already showed the sign-in screen */
  }
}
function startSessionWatch() {
  if (!Store.remote()) return;
  setInterval(checkSession, 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkSession();
  });
  // mobile browsers freeze timers in background and don't always fire
  // visibilitychange on return — cover every wake-up signal they send
  window.addEventListener("focus", checkSession);
  window.addEventListener("pageshow", checkSession);
  window.addEventListener("online", checkSession);
  // tabs of the SAME browser share one session — keep them in sync so
  // a sibling tab's login/logout applies here instantly
  window.addEventListener("storage", (e) => {
    if (e.key !== AUTH_KEY) return;
    try { AUTH = e.newValue ? JSON.parse(e.newValue) : null; } catch { AUTH = null; }
    updateAuthUi();
    if (AUTH) hideLogin();
    else showLogin();
  });
}

/* admin-only: list the team and add/update logins */
async function openUsers() {
  $("usersOverlay").style.display = "flex";
  // managers create plain users only — role choices are admin's
  [...$("nuRole").options].forEach((o) => {
    o.disabled = o.value !== "user" && AUTH?.role !== "admin";
  });
  renderUsersList(null);
  try {
    const data = await Store._post({ action: "listUsers" });
    renderUsersList(data.users || []);
  } catch (e) {
    $("nuErr").textContent = e.message;
  }
}

function renderUsersList(users) {
  const ul = $("usersList");
  if (!users) {
    ul.innerHTML = "<li class='saved-empty'>Loading…</li>";
    return;
  }
  ul.innerHTML = users.length
    ? users
        .map(
          (u) =>
            `<li><strong>${escapeHtml(u.name)}</strong> · ${escapeHtml(u.username)} · ${u.role}${u.active ? "" : " · disabled"}</li>`
        )
        .join("")
    : "<li class='saved-empty'>No users yet.</li>";
}

async function createUser() {
  const err = $("nuErr");
  err.textContent = "";
  const btn = $("btnCreateUser");
  btn.disabled = true;
  try {
    const data = await Store._post({
      action: "createUser",
      user: {
        username: $("nuUser").value.trim(),
        name: $("nuName").value.trim(),
        password: $("nuPass").value,
        role: $("nuRole").value,
      },
    });
    renderUsersList(data.users || []);
    $("nuUser").value = $("nuName").value = $("nuPass").value = "";
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/* inline SVG icons (Lucide-style) reused by generated markup */
const SVG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICON_X = SVG + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_TRASH = SVG + '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_CHECK = SVG + '<polyline points="20 6 9 17 4 12"/></svg>';
const ICON_ALERT = SVG + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const ICON_LOCK = SVG + '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const ICON_UNLOCK = SVG + '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
const ICON_GRIP = '<svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';
const ICON_PLUS = SVG + '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const ICON_SWAP = SVG + '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';

const Store = {
  remote() {
    return typeof SHEET_API_URL === "string" && SHEET_API_URL.trim().startsWith("http");
  },

  _local() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  },
  _localWrite(all) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  },
  _localNext(all) {
    let max = 0;
    all.forEach((q) => {
      const m = /^QT(\d+)$/.exec(q.quoteNo || "");
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return "QT" + String(max + 1).padStart(4, "0");
  },

  // every authed call goes through here — a rejected token clears the
  // session and brings the sign-in screen back
  async _post(payload) {
    const res = await fetch(SHEET_API_URL, {
      method: "POST",
      // text/plain keeps it a "simple" request → no CORS preflight
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      redirect: "follow",
      body: JSON.stringify({ ...payload, token: AUTH && AUTH.token }),
    });
    const data = await res.json();
    if (data.error === "auth") {
      // another tab of this browser may have signed in meanwhile and
      // written a fresh token — adopt it instead of wiping it
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch {}
      if (stored && stored.token && (!AUTH || stored.token !== AUTH.token)) {
        AUTH = stored;
        updateAuthUi();
        throw new Error("Session refreshed - please retry");
      }
      setAuth(null);
      showLogin();
      throw new Error("Please sign in");
    }
    if (data.error) throw new Error(data.error);
    return data;
  },

  async list() {
    if (!this.remote()) return this._local();
    const data = await this._post({ action: "list" });
    return data.quotations || [];
  },

  // preview only — the definitive number is assigned on save()
  async nextNo() {
    if (!this.remote()) return this._localNext(this._local());
    const res = await fetch(SHEET_API_URL + "?action=next", { redirect: "follow" });
    const data = await res.json();
    return data.quoteNo;
  },

  async save(record) {
    // record.savedNo = existing number if this quote was already
    // saved/loaded, else null → server issues a fresh number
    if (!this.remote()) {
      const all = this._local();
      if (record.savedNo) {
        record.quoteNo = record.savedNo;
        const idx = all.findIndex((q) => q.quoteNo === record.savedNo);
        if (idx >= 0) all[idx] = record;
        else all.push(record);
      } else {
        record.quoteNo = this._localNext(all);
        all.push(record);
      }
      this._localWrite(all);
      return record;
    }
    const data = await this._post({ action: "save", record });
    return data.record;
  },

  async remove(quoteNo) {
    if (!this.remote()) {
      this._localWrite(this._local().filter((q) => q.quoteNo !== quoteNo));
      return;
    }
    await this._post({ action: "delete", quoteNo });
  },
};

/* ---------- shared scope blocks ----------
   Content from "RERA Easy - Registration - Retainer Quotation.xlsx".
   Sections repeat across packages, so they live here once. */

const REG_SERVICE_ITEMS = [
  "Consultation and Guidance on Registration Procedures",
  "Assistance with Online Registration Process",
  "Preparation of Necessary Undertakings and Affidavits for RERA Registration",
  "Preparation and Submission of Format D as per Circular 32",
  "Scrutiny Assistance till RERA Certificate is generated",
  "Continued support until the RERA Certificate is issued",
  "Procurement of CERSAI Certificate",
  "Cost accounting in accordance with MahaRERA regulations",
];
const REG_DRAFTING_ITEMS = [
  "Drafting/Review of Agreement for Sale in Compliance with MahaRERA Regulations",
  "Drafting/Review of Allotment Letters in Compliance with MahaRERA Regulations",
  "Preparation/Review and Submission of Deviation Reports for Agreement for Sale",
  "Preparation/Review and Submission of Deviation Reports for Allotment Letters",
];
const REG_VETTING_ITEMS = [
  "Vetting of Agreement for Sale in Compliance with MahaRERA Regulations",
  "Vetting of Allotment Letters in Compliance with MahaRERA Regulations",
  "Vetting and Submission of Deviation Reports for Agreement for Sale",
  "Vetting and Submission of Deviation Reports for Allotment Letters",
];
const REG_VETTING_ITEMS_LUMPSUM = [
  "Vetting of Agreement for Sale (including Registration & Execution)",
  "Vetting of Allotment Letters in Compliance with MahaRERA Regulations",
  "Vetting and Submission of Deviation Reports for Agreement for Sale",
  "Vetting and Submission of Deviation Reports for Allotment Letters",
];
const REG_CERT_ITEMS = [
  "Preparation & Certification of Form 3 (Chartered Accountant's Certificate)",
  "Preparation & Certification of Form 2 (Engineer's Certificate)",
];
const REG_EXCLUSIONS = [
  "Liasoning with RERA authorities for smooth communication between your organization and regulatory bodies",
  "Handling complex paperwork, address compliance issues, and resolve disputes avoiding any delay",
  "Any additional Post-Registration Services",
  "Conducting Title Search / Preparation of Title Report",
  "Litigations and complaint filing costs",
  "Form 1 - Architect Certificate (Preparation & Certification)",
  "Any additional services not specified are excluded from this scope",
];

/* package exclusions differ only in the certificates list */
const pkgExcl = (certs) => [
  "Any kind of drafting of Legal Documents or Contracts other than RERA Compliances are not applicable",
  "Preparation or certification not applicable for any and all Certificates like: " + certs,
  "Project Time Extension under Section 6, Section 7(3), Order No. 40, or any other applicable provisions and directions issued by MahaRERA",
  "Project Amendment under section 14(2)",
  "Project Closure application on the receipt of the OC, Change of Promoter, Removal from Abeyance and Deregistration",
  "Attending any authority hearings and representation in litigation matters",
  "Any and all services not mentioned in the above scope of services are not applicable",
];
const PKG_EXCL_A = pkgExcl(
  "Form 1 (Architect Certificate), Form 2 (Engineers Certificate), Form 3 (CA Certificate), Form 2A (Quality Assurance Certificate), Form 5 (Annual Audit Certificate)"
);
const PKG_EXCL_B = pkgExcl(
  "Form 1 (Architect Certificate), Form 2A (Quality Assurance Certificate), Form 5 (Annual Audit Certificate)"
);
const PKG_EXCL_CD = pkgExcl("Form 2A (Quality Assurance Certificate)");

const PKG_ADVISORY_6 = [
  "Liasoning with RERA authorities for smooth communication between your organization and regulatory bodies",
  "Comprehensive consultation regarding the RERA Act & Rules",
  "Expert Guidance and updates on MahaRERA Orders & Regulations",
  "Detailed insight into functioning of 100%, 70% and 30% Bank Accounts & Procedures for withdrawals",
  "Advisory Services on contractual Agreements with buyers",
  "Preventive/Proactive advice with respect to compliances",
];
const PKG_QPR = [
  "Vetting of Form 1 (Architect Certificate) as per Annexure A (Regulation 3)",
  "Vetting of Form 2 (Engineer Certificate) as per Annexure B (Regulation 3)",
  "Vetting of Form 3 (CA Certificate) as per Annexure D (Regulation 3)",
  "Drafting of Disclosure of Sold/Unsold Inventory as per Circular 29",
  "Updation of Work Progress and Development work",
  "Updation of Cost details (Estimated and Incurred)",
  "Updation of Inventory Details, Building Details, Project Details, FSI Details & Status",
  "Updation of Professional details including Channel Partner, Contractors and others",
  "Filing of QPR Report to MahaRERA on quarterly basis",
];
const PKG_PROFILE = [
  "Updation of amended/revised permissions from the local planning authority",
  "Updation of parking details",
  "Updation and Amendment of Encumbrance Details (Finance/Legal)",
  "Updation of Litigation details",
  "Updation of Promoter and Stakeholder details",
  "Updation of Communication and contact details",
  "Updation of project professional details",
  "Drafting assistance of Form 2A (Quality Assurance Certificate)",
  "Modification & Amendment of Project Details",
  "Obtaining CERSAI Certificate in case of financial encumbrance",
];
const PKG_CERTS = [
  "Preparing/Updating estimates related to cost of construction for the project",
  "Preparation and Certification of Form 2 (Engineers Certificate)",
  "Cost accounting as per RERA for evaluating the expenses incurred in the project as per Books of Accounts",
  "Preparing the detailed report of the Receipts of the Project as per RERA",
  "Constituting the valuation of the unsold inventory",
  "Preparation and Certification of Form 3 (CA Certificate)",
  "Recommendations with respect to modification or amendments to Form 3 (CA Certificate)",
  "Consultation in Compilation of Form 3 (CA Certificate)",
  "Advise on adhering to financial reporting and management practices mandated by RERA for the project",
];
const PKG_AUDIT = [
  "Consultation regarding Examination of the Prescribed Registers, Books & Documents, and Relevant Records",
  "Drafting assistance of Form 5 (Annual Report on Statement of Account) as per the Registers, Books & Documents",
  "Certification & Submission of Form 5",
];

/* ---------- the service catalogue ---------- */

const CATALOGUE = {
  /* — Individual services — */
  project_registration: {
    label: "Project Registration",
    sections: [
      { title: "Project Registration Services", price: 75000, items: REG_SERVICE_ITEMS },
      { title: "Legal Documentation - Drafting & Review", price: null, items: REG_DRAFTING_ITEMS },
      { title: "Legal Documentation - Vetting", price: 25000, items: REG_VETTING_ITEMS },
      { title: "Certifications", price: 30000, items: REG_CERT_ITEMS },
    ],
    exclusions: REG_EXCLUSIONS,
    docs: [
      "PAN & Aadhaar of promoter / partners.",
      "Commencement Certificate.",
      "Approved layout & building plans.",
      "Title report & land documents.",
      "Sale deed / development agreement.",
      "RERA designated bank account details.",
    ],
    amount: 130000,
  },
  registration_lumpsum: {
    label: "Project Registration - Lumpsum",
    sections: [
      { title: "Project Registration Services", price: 650000, items: REG_SERVICE_ITEMS },
      { title: "Legal Documentation - Drafting & Review", price: null, items: REG_DRAFTING_ITEMS },
      { title: "Legal Documentation - Vetting", price: null, items: REG_VETTING_ITEMS_LUMPSUM },
      { title: "Certifications", price: null, items: REG_CERT_ITEMS },
    ],
    exclusions: REG_EXCLUSIONS,
    docs: [
      "PAN & Aadhaar of promoter / partners.",
      "Commencement Certificate.",
      "Approved layout & building plans.",
      "Title report & land documents.",
      "Sale deed / development agreement.",
      "RERA designated bank account details.",
    ],
    amount: 650000,
  },
  extension: {
    label: "Extension of Project Completion Date u/s 7(3)",
    subs: [
      "Project Extension under Section 7(3): Extending the project under Section 7(3) regulations involves prolonging the project's duration in accordance with legal provisions.",
      "Consultation regarding RERA Rules and Regulations: Providing advisory services on compliance with the rules and regulations set forth by the Real Estate Regulatory Authority (RERA).",
      "Uploading of all the relevant documents for Project Extension: Ensuring that all pertinent documents required for extending the project are appropriately uploaded and submitted as per the prescribed guidelines.",
      "Drafting of a detailed consent letter for Extension: Creating a comprehensive consent letter outlining the details of the Extension process to the allottees, adhering to regulatory specifications.",
      "Scrutiny Assistance: Providing support and guidance during the scrutiny process to ensure compliance and smooth execution of all regulatory obligations.",
    ],
    docs: [
      "Project Extension Date.",
      "51% consents of the allottees for extension.",
      "Latest approved Plans and CC for the Project.",
      "Reason for the delay in the project.",
      "Case Details of the project (if any).",
      "RERA Carpet Area Statement.",
      "Index II or Date of Registration of Sold Units.",
      "Form 1 (Architect's Certificate), Form 2 (Engineer's Certificate) & Form 3 (CA's Certificate) for the quarter.",
      "Form 2A (Quality Assurance Certificate by Engineer) & Form 5 (Annual Audit Report of Statutory CA) for the FY.",
    ],
    amount: 80000,
  },
  correction: {
    label: "Project Correction u/s 14(2)",
    subs: [
      "Project Correction under Section 14(2): Correction of the project under Section 14(2) regulations involves correcting the project's details in accordance with legal provisions.",
      "Consultation regarding RERA Rules and Regulations: Providing advisory services on compliance with the rules and regulations set forth by the Real Estate Regulatory Authority (RERA).",
      "Uploading of all the relevant documents for Project Correction: Ensuring that all pertinent documents required for correcting the project are appropriately uploaded and submitted as per the prescribed guidelines.",
      "Drafting of a detailed consent letter for correction: Creating a comprehensive consent letter outlining the details of the correction process to the allottees, adhering to regulatory specifications.",
      "Scrutiny Assistance: Providing support and guidance during the scrutiny process to ensure compliance and smooth execution of all regulatory obligations.",
    ],
    docs: [
      "New Approved Plans and CC.",
      "67% consents of the allottees for correction under section 14(2).",
      "RERA Carpet Area Statement.",
      "Index II or Date of Registration of Sold Units.",
      "Form 1 (Architect's Certificate), Form 2 (Engineer's Certificate) & Form 3 (CA's Certificate) for the quarter / as on OC date or Sanctioned Plan date (as applicable).",
      "Form 2A (Quality Assurance Certificate by Engineer) & Form 5 (Annual Audit Report of Statutory CA) for the FY.",
    ],
    amount: 30000,
  },
  bank_account_change: {
    label: "Correction (Change of Bank Account)",
    subs: [
      "Change of separate bank account as per section 4(2)(l)(D).",
      "Drafting of Duly Notarized Declaration-Cum-Undertaking as per the format prescribed in 'A'.",
      "Declaration in Format 'A' and Format 'B' as per Order No. 5634 of 2024 dated 27/06/2024 issued by MahaRERA.",
      "Consultation regarding RERA Rules and Regulations.",
      "Uploading of all the relevant documents for Project Correction.",
      "Drafting all the relevant Applications, Undertakings and Declarations.",
      "Scrutiny Assistance.",
      "Coordinating with the MahaRERA Authorities.",
    ],
    docs: [
      "New Bank Account details - 100%, 70%, 30% of the promoters and landowners with Bank Email ID.",
      "Latest Sanctioned Plans & CC (Correction under Section 14(2) - Change in FSI, will be applicable if any discrepancies are identified between the latest sanctioned plans, CC, and the project profile upon review.)",
      "Form 1 (Architect's Certificate), Form 2 (Engineer's Certificate) & Form 3 (CA's Certificate) for the quarter.",
      "Form 2A (Quality Assurance Certificate by Engineer) & Form 5 (Annual Audit Report of Statutory CA) for the FY.",
    ],
    amount: 25000,
  },
  profile_migration: {
    label: "MahaRERA Profile Migration",
    subs: [
      "Updation and Migration of the old MahaRERA Profile Details to the new RERA website \"MahaRERA CRITI\".",
      "Drafting Formats of Authorized Signatory.",
      "Updating the Promoter/Partner(s)/Director(s) Details on the Portal.",
      "Updating any details of projects previously developed by the promoter, if applicable.",
      "Adding Grievance Officer and Single Point of Contact.",
      "Updation of Project Professional Details, Progress of the Project etc.",
      "Drafting and updating Legal & Financial Encumbrances of the project (If any).",
      "Updation of Units Details with corresponding carpet area, Unit types, and Booking status along with financial details.",
    ],
    docs: [
      "Form 1 (Architect's Certificate), Form 2 (Engineer's Certificate) & Form 3 (CA's Certificate) for the quarter.",
      "Partner(s) / Director(s) / Proprietor - PAN Card, Photo, Mobile Number and Email ID.",
      "Single Point of Contact Person's, Grievance Officer's, Authorized Signatory's - Name, PAN, Address, Email ID & Mobile Number.",
      "GST Certificate of the Promoter.",
      "New Approved Plans and CC.",
      "Office Address (For Communication) - Address Proof (Agreement / Electricity Bill / Lease Deed / Leave License Agreement / Tenancy Agreement / Telephone Bill).",
      "Architect, RCC Consultant, other professionals - PAN Card, Mobile Number, Email ID, Membership Number.",
      "Carpet Area list (As per sanctioned Plan & As per Full Potential Plans).",
      "Index II of all sold units.",
      "SRO Membership Certificate for the Project. If the certificate is not available, kindly note that the charges for a new registration would be INR 11,800/- or 23,600/- depending on the project location.",
    ],
    amount: 25000,
  },
  project_closure: {
    label: "Project Closure",
    subs: [
      "Project Closure: Applying for Project Closure ensuring everything is in order confirming that the developer has met all obligations under the RERA Act.",
      "Consultation regarding RERA Rules and Regulations: Providing guidance and advice on compliance with the rules and regulations stipulated by the Real Estate Regulatory Authority (RERA).",
      "Drafting all the relevant Applications, Undertakings, and Declarations: Preparing and drafting the required applications, undertakings, and declarations to facilitate the closure process efficiently and effectively.",
      "Uploading of all the relevant documents for Project Closure: Ensuring that all necessary documents for Project Closure are accurately uploaded and submitted in adherence to MahaRERA Guidelines.",
    ],
    docs: [
      "Occupancy Certificate (OC).",
      "Occupancy Certificate (OC) Plans.",
      "Occupancy Certificate (OC) - Verification Email.",
      "Last Approved Plans and CC.",
      "Form 1 (Architect's Certificate), Form 2 (Engineer's Certificate) & Form 3 (CA's Certificate) as on OC Date.",
      "Form 2A (Quality Assurance Certificate by Engineer) & Form 5 (Annual Audit Report of Statutory CA) for the FY.",
    ],
    amount: 60000,
  },
  removal_of_abeyance: {
    label: "Removal from Abeyance",
    subs: [
      "Responding to the MahaRERA Notice: Preparing and submitting an appropriate reply to the notice received from MahaRERA, addressing all concerns raised.",
      "Representation in Virtual Meetings: Attending any online meetings or hearings with MahaRERA officials on behalf of the client to present their case or provide clarifications.",
      "Providing Guidance on RERA Rules and Regulations: Offering expert advice and explanations on the relevant Real Estate (Regulation and Development) Act, 2016 provisions applicable to the issue at hand.",
      "Liaising with MahaRERA Authorities: Acting as a point of Contact to communicate and coordinate with MahaRERA officials for efficient resolution of the matter.",
      "Drafting Necessary Applications, Undertakings, and Declarations: Preparing and submitting all required legal documents, such as applications for compliance, undertakings, or declarations, to address the notice or related compliance requirements.",
    ],
    docs: [
      "Copy of the abeyance notice.",
      "Pending compliance documents.",
    ],
    amount: 35000,
  },
  pending_compliances: {
    label: "Pending Compliances",
    subs: [
      "QPR Filings: Filing of all pending Quarterly Progress Reports.",
      "APR Filings: Filing of all pending Annual Progress Reports.",
      "Form 5 Filing: Annual audit report (Form 5) preparation support & filing.",
    ],
    docs: [
      "Sales & bank statements for pending periods.",
      "Form 3 CA certificates.",
      "Form 5 audit report.",
    ],
    amount: 40000,
  },
  maharera_profile_updation: {
    label: "One Time MahaRERA Profile Updation",
    subs: [
      "Disclosure of Sold/Unsold Inventory: Thorough drafting and meticulous uploading of the disclosure document showcasing the status of sold and unsold inventory, ensuring accuracy and compliance.",
      "Format D Drafting and Uploading: Proficient drafting and systematic uploading of Format D.",
      "CERSAI Report Submission: Facilitating the submission and generation of the CERSAI report, ensuring completeness and adherence to regulatory standards.",
      "Drafted Formats for Form 2A: Preparation and provision of meticulously drafted formats required for Form 2A.",
      "MahaRERA Profile Update: Complete and accurate updating of the MahaRERA profile.",
    ],
    docs: [
      "Updated promoter details.",
      "Certificates / documents to be uploaded.",
    ],
    amount: 15000,
  },
  change_of_promoter: {
    label: "Change of Promoter (Section 15)",
    subs: [
      "Application Drafting: Drafting the application under Section 15.",
      "Allottee Consent: Obtaining consent of 2/3rd allottees.",
      "Liaison: Follow-up with MahaRERA till approval.",
    ],
    docs: [
      "Transfer / assignment agreement.",
      "Consent of 2/3rd allottees.",
      "Incoming promoter KYC & financials.",
    ],
    amount: 100000,
  },
  withdrawal_of_old_correction: {
    label: "Withdrawal of Old Correction",
    subs: [
      "Withdrawal Request: Drafting the withdrawal request with justification.",
      "Portal Filing: Filing on the portal & follow-up till closure.",
    ],
    docs: [
      "Reference of the earlier correction application.",
    ],
    amount: 20000,
  },

  /* — Retainer packages (cumulative: B ⊇ A, C ⊇ B, D ⊇ C) — */
  package_a: {
    label: "Package A",
    sections: [
      {
        title: "Consultation & Advisory Services",
        hidePrice: true,
        price: 75000,
        items: [...PKG_ADVISORY_6, "Implementation of Consents from Allottees"],
      },
      { title: "Quarterly Progress Reports", price: null, items: PKG_QPR },
      { title: "RERA Profile Updation & Compliance", price: null, items: PKG_PROFILE },
    ],
    exclusions: PKG_EXCL_A,
    docs: [
      "Quarterly sales & bank statements.",
      "Form 3 CA certificates.",
      "Form 5 audit report.",
    ],
    amount: 75000,
  },
  package_b: {
    label: "Package B",
    sections: [
      {
        title: "Consultation & Advisory Services",
        hidePrice: true,
        price: 120000,
        items: [
          ...PKG_ADVISORY_6,
          "Advisory Services on agreements & contracts with the buyer",
          "Implementation of Consents from Allottees",
          "Advisory Services on future withdrawals and further functioning of accounts",
        ],
      },
      { title: "Quarterly Progress Reports", price: null, items: PKG_QPR },
      { title: "Professional Certifications", price: null, items: PKG_CERTS },
      { title: "RERA Profile Updation & Compliance", price: null, items: PKG_PROFILE },
    ],
    exclusions: PKG_EXCL_B,
    docs: [
      "Quarterly sales & bank statements.",
      "Form 3 CA certificates.",
      "Form 5 audit report.",
    ],
    amount: 120000,
  },
  package_c: {
    label: "Package C",
    sections: [
      {
        title: "Consultation & Advisory Services",
        hidePrice: true,
        price: 125000,
        items: [
          ...PKG_ADVISORY_6,
          "Implementation of Consents from Allottees",
          "Advisory Services on future withdrawals and further functioning of accounts",
        ],
      },
      { title: "Quarterly Progress Reports", price: null, items: PKG_QPR },
      { title: "Professional Certifications", price: null, items: ["Preparation and Certification of Form 1 (Architects Certificate)", ...PKG_CERTS] },
      { title: "RERA Profile Updation & Compliance", price: null, items: PKG_PROFILE },
      { title: "RERA Annual Audit Consultation", price: null, items: PKG_AUDIT },
    ],
    exclusions: PKG_EXCL_CD,
    docs: [
      "Quarterly sales & bank statements.",
      "Form 3 CA certificates.",
      "Form 5 audit report.",
    ],
    amount: 125000,
  },
  package_d: {
    label: "Package D",
    sections: [
      {
        title: "Consultation & Advisory Services",
        hidePrice: true,
        price: 125000,
        items: [
          ...PKG_ADVISORY_6,
          "Implementation of Consents from Allottees",
          "Advisory Services on future withdrawals and further functioning of accounts",
        ],
      },
      { title: "Quarterly Progress Reports", price: null, items: PKG_QPR },
      {
        title: "Professional Certifications",
        price: null,
        items: ["Preparation and Certification of Form 1 (Architects Certificate)", ...PKG_CERTS],
      },
      { title: "RERA Profile Updation & Compliance", price: null, items: PKG_PROFILE },
      { title: "RERA Annual Audit Consultation", price: null, items: PKG_AUDIT },
    ],
    exclusions: PKG_EXCL_CD,
    docs: [
      "Quarterly sales & bank statements.",
      "Form 3 CA certificates.",
      "Form 5 audit report.",
    ],
    amount: 125000,
  },
};

/* priority order: Registration first, then Packages, then Individual */
const GROUPS = [
  {
    title: "Registration Services",
    keys: ["project_registration", "registration_lumpsum"],
  },
  {
    title: "Retainer Packages",
    keys: ["package_a", "package_b", "package_c", "package_d"],
  },
  {
    title: "Individual Services",
    keys: [
      "extension", "correction", "bank_account_change",
      "profile_migration", "project_closure", "removal_of_abeyance",
      "pending_compliances", "maharera_profile_updation",
      "change_of_promoter", "withdrawal_of_old_correction",
    ],
  },
];

const ORDER = GROUPS.flatMap((g) => g.keys);

/* short display titles for the big proposal heading & kicker —
   the Annexure A card keeps the full label (matches 5.pdf, where
   the title says "Project Extension" but the card says
   "EXTENSION OF PROJECT COMPLETION DATE U/S 7(3)") */
const SHORT_TITLES = {
  project_registration: "Project Registration",
  registration_lumpsum: "Registration - Lumpsum",
  extension: "Project Extension",
  correction: "Project Correction",
  bank_account_change: "Change of Bank Account",
  profile_migration: "Profile Migration",
  project_closure: "Project Closure",
  removal_of_abeyance: "Removal from Abeyance",
  pending_compliances: "Pending Compliances",
  maharera_profile_updation: "Profile Updation",
  change_of_promoter: "Change of Promoter",
  withdrawal_of_old_correction: "Withdrawal of Correction",
  package_a: "Package A",
  package_b: "Package B",
  package_c: "Package C",
  package_d: "Package D",
};

/* ---------- Other Services add-ons (extension / correction) ----------
   Ticking one adds an "Other Services" card and relaxes the matching
   package-exclusion line; the count sets Once / Twice / Thrice. */

const OTHER = {
  extension: { on: false, count: 1 },
  correction: { on: false, count: 1 },
};
const OTHER_DEFS = {
  extension: {
    name: "Extension u/s 7(3)",
    line: (w) => `Project Time Extension under Section 7(3) - Only "${w}" throughout the contract, after that professional fees applicable.`,
  },
  correction: {
    name: "Correction u/s 14(2)",
    line: (w) => `Project Amendment under section 14(2) - Only "${w}" throughout the contract, after that professional fees applicable.`,
  },
};

function countWord(n) {
  return n <= 1 ? "Once" : n === 2 ? "Twice" : n === 3 ? "Thrice" : n + " Times";
}

/* terms from the RERA Easy Registration–Retainer workbook */
const DEFAULT_TERMS = [
  "The above quotation is applicable to the Project and Promoter mentioned above only.",
  "The prices mentioned above are in particular to One Project per year.",
  "The prices mentioned above DO NOT include Government Fees.",
  "18% GST applicable on the above-mentioned charges.",
  "Payment is due at the initiation of services, followed by annual payments thereafter.",
  "The services outlined above are included within the project scope. Any additional services not specified are excluded from this scope.",
].join("\n");

let RATES = null;

/* documents state: removals & manual additions survive save/load */
let removedDocs = new Set();
let extraDocs = [];

const $ = (id) => document.getElementById(id);

/* ---------- amounts: Indian formatting (no paise on the sheet) ---------- */

function parseAmt(v) {
  return parseFloat(String(v).replace(/[^0-9.\-]/g, "")) || 0;
}

function fmt(n) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmt0(n) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

/* ---------- default fees (✎ Edits) ---------- */

function loadRates() {
  try {
    const s = JSON.parse(localStorage.getItem(RATES_KEY));
    if (s && s.amounts) {
      // new catalogue keys fall back to their built-in default
      ORDER.forEach((k) => {
        if (s.amounts[k] === undefined) s.amounts[k] = CATALOGUE[k].amount;
      });
      return s;
    }
  } catch {}
  const amounts = {};
  ORDER.forEach((k) => (amounts[k] = CATALOGUE[k].amount));
  return { amounts, gst: 18 };
}

function saveRates() {
  localStorage.setItem(RATES_KEY, JSON.stringify(RATES));
}

function renderFeeEditor() {
  const body = $("svcAmtBody");
  body.innerHTML = "";
  // sectioned offerings price per section on the sheet itself
  ORDER.filter((k) => !CATALOGUE[k].sections).forEach((key) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="bracket-lbl" title="${escapeAttr(CATALOGUE[key].label)}">${escapeHtml(CATALOGUE[key].label)}</td>
      <td><input type="number" class="fee-input" data-key="${key}" min="0" step="any" value="${RATES.amounts[key]}"></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll(".fee-input").forEach((inp) =>
    inp.addEventListener("input", () => {
      const key = inp.dataset.key;
      RATES.amounts[key] = parseFloat(inp.value) || 0;
      saveRates();
      // a selected service follows its default live (until the amount
      // is edited directly for this quotation)
      const card = serviceCard(key);
      const panelAmt = panelAmtInput(key);
      if (card && !card.dataset.customAmt) {
        card.querySelector(".i-amt").value = fmt0(RATES.amounts[key]);
        if (panelAmt) panelAmt.value = fmt0(RATES.amounts[key]);
        recalc();
      }
    })
  );
}

/* ---------- service picker (left panel) ---------- */

function renderServicePicker() {
  const host = $("svcPicker");
  host.innerHTML = "";
  GROUPS.forEach((group) => {
    const h = document.createElement("div");
    h.className = "svc-group";
    h.textContent = group.title;
    host.appendChild(h);
    group.keys.forEach((key) => {
      const row = document.createElement("div");
      row.className = "svc-row";
      row.dataset.key = key;
      row.innerHTML = `
        <label class="svc-toggle">
          <input type="checkbox" class="svc-check" data-key="${key}">
          <span class="svc-name" title="${escapeAttr(CATALOGUE[key].label)}">${escapeHtml(CATALOGUE[key].label)}</span>
        </label>
        <input type="text" class="svc-amt" data-key="${key}" inputmode="decimal" hidden>
        ${CATALOGUE[key].sections ? `<button class="svc-sub-btn" title="Section prices"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>` : ""}
      `;
      host.appendChild(row);

      const check = row.querySelector(".svc-check");
      const amt = row.querySelector(".svc-amt");

      // sectioned offerings: prices are edited HERE, per section, via a
      // dropdown — the preview pills are read-only
      const subBtn = row.querySelector(".svc-sub-btn");
      if (subBtn) {
        const subs = document.createElement("div");
        subs.className = "svc-subs";
        subs.hidden = true;
        host.appendChild(subs);
        subBtn.addEventListener("click", () => {
          subs.hidden = !subs.hidden;
          subBtn.classList.toggle("open", !subs.hidden);
          if (!subs.hidden) buildSubRows(key, subs);
        });
        check.addEventListener("change", () => {
          if (!check.checked) {
            subs.hidden = true;
            subBtn.classList.remove("open");
          }
        });
      }

      check.addEventListener("change", () => {
        if (check.checked) selectService(key, RATES.amounts[key]);
        else deselectService(key);
      });

      // panel amount -> sheet card (marks the amount as custom).
      // Sectioned offerings: the first priced pill absorbs the change
      // so the total equals the entered amount.
      amt.addEventListener("input", () => {
        if (CATALOGUE[key].sections) {
          const pills = [
            ...document.querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"] .i-amt`),
          ];
          if (!pills.length) return;
          const others = pills.slice(1).reduce((s, p) => s + parseAmt(p.value), 0);
          pills[0].value = fmt0(Math.max(0, parseAmt(amt.value) - others));
          recalc();
          return;
        }
        const card = serviceCard(key);
        if (card) {
          card.dataset.customAmt = "1";
          card.querySelector(".i-amt").value = amt.value;
          recalc();
        }
      });
      amt.addEventListener("focus", () => (amt.value = parseAmt(amt.value) || ""));
      amt.addEventListener("blur", () => (amt.value = fmt0(parseAmt(amt.value))));
    });
  });

  // Other Services add-ons: checkbox + how-many-times counter
  const oh = document.createElement("div");
  oh.className = "svc-group";
  oh.textContent = "Other Services";
  host.appendChild(oh);
  Object.keys(OTHER_DEFS).forEach((okey) => {
    const row = document.createElement("div");
    row.className = "svc-row";
    row.innerHTML = `
      <label class="svc-toggle">
        <input type="checkbox" class="other-check" data-okey="${okey}">
        <span class="svc-name">${escapeHtml(OTHER_DEFS[okey].name)}</span>
      </label>
      <input type="number" class="svc-amt other-count" data-okey="${okey}" min="1" step="1" value="1" title="No. of times included in the contract" hidden>
    `;
    host.appendChild(row);
    const check = row.querySelector(".other-check");
    const cnt = row.querySelector(".other-count");
    check.addEventListener("change", () => {
      OTHER[okey].on = check.checked;
      row.classList.toggle("on", check.checked);
      cnt.hidden = !check.checked;
      refreshOtherServices();
    });
    cnt.addEventListener("input", () => {
      OTHER[okey].count = Math.max(1, parseInt(cnt.value, 10) || 1);
      refreshOtherServices();
    });
  });
}

/* the sidebar dropdown listing an offering's sections: priced ones get
   an input that drives the read-only preview pill; the offering total
   follows as the sum (no rebalancing here — direct control) */
function buildSubRows(key, hostEl) {
  hostEl.innerHTML = "";
  const secs = CATALOGUE[key].sections || [];
  document
    .querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"]`)
    .forEach((card) => {
      const title = (secs[parseInt(card.dataset.sec, 10)] || {}).title || "Section";
      const inp = card.querySelector('input.i-amt:not([type="hidden"])');
      const r = document.createElement("div");
      r.className = "svc-sub-row";
      // the price <-> "Included in our scope" flip lives HERE now, not
      // on the preview card
      const canFlip = !!card.querySelector(".pill-toggle");
      const flipHtml = canFlip
        ? `<button class="svc-sub-flip" title="Switch between a price and Included in our scope">${ICON_SWAP}</button>`
        : "";
      if (inp) {
        r.innerHTML = `<span class="svc-sub-name" title="${escapeAttr(title)}">${escapeHtml(title)}</span>${flipHtml}<input type="text" class="svc-sub-amt" inputmode="decimal" value="${fmt0(parseAmt(inp.value))}">`;
        const si = r.querySelector("input");
        si.addEventListener("input", () => {
          inp.value = si.value;
          const pa = panelAmtInput(key);
          if (pa) pa.value = fmt0(serviceTotal(key));
          recalc();
        });
        si.addEventListener("focus", () => (si.value = parseAmt(si.value) || ""));
        si.addEventListener("blur", () => {
          si.value = fmt0(parseAmt(si.value));
          inp.value = si.value;
          setTimeout(recalc, 0);
        });
      } else {
        r.innerHTML = `<span class="svc-sub-name" title="${escapeAttr(title)}">${escapeHtml(title)}</span>${flipHtml}<span class="svc-sub-inc">Included</span>`;
      }
      r.querySelector(".svc-sub-flip")?.addEventListener("click", () => {
        toggleSectionPill(card, key); // updates card, totals, recalc
        buildSubRows(key, hostEl);    // refresh the dropdown rows
      });
      hostEl.appendChild(r);
    });
  if (!hostEl.children.length)
    hostEl.innerHTML = `<div class="svc-sub-row"><span class="svc-sub-inc">Select the service first</span></div>`;
}

function panelRow(key) {
  return document.querySelector(`.svc-row[data-key="${key}"]`);
}
function panelCheck(key) {
  return document.querySelector(`.svc-check[data-key="${key}"]`);
}
function panelAmtInput(key) {
  return document.querySelector(`.svc-amt[data-key="${key}"]`);
}

/* selecting a service = panel state + Annexure A card(s) + docs rebuild */
function selectService(key, amount, subText, customAmt, secs, headText, included) {
  pushUndo();
  const check = panelCheck(key);
  const amt = panelAmtInput(key);
  check.checked = true;
  panelRow(key).classList.add("on");
  amt.hidden = false;
  if (CATALOGUE[key].sections) {
    // sectioned offering: one card per section; the panel shows the
    // total of the priced pills (edit amounts on the sheet)
    addSectionCards(key, secs);
    amt.value = fmt0(serviceTotal(key));
  } else {
    amt.value = fmt0(included ? 0 : amount);
    amt.disabled = !!included; // price edits come back when flipped to priced
    addServiceCard(key, amount, subText ?? CATALOGUE[key].subs.join("\n"), customAmt, included);
  }
  addOfferingHead(key, headText);
  rebuildDocs();
  recalc();
}

/* every offering prints a big heading above its cards */
function offeringHead(key) {
  return document.querySelector(`.offering-head[data-key="${key}"]`);
}

/* when inserting before another offering's first card, go above its
   heading too — otherwise the new cards land between them */
function anchorWithHead(anchorCard) {
  const prev = anchorCard.previousElementSibling;
  return prev &&
    prev.classList &&
    prev.classList.contains("offering-head") &&
    prev.dataset.key === anchorCard.dataset.key
    ? prev
    : anchorCard;
}

function addOfferingHead(key, headText) {
  if (offeringHead(key)) return;
  const first = serviceCard(key);
  if (!first) return;
  const short = SHORT_TITLES[key] || CATALOGUE[key].label;
  const h = document.createElement("div");
  h.className = "offering-head";
  h.dataset.key = key;
  // each offering opens with the annexure heading, then its name
  h.innerHTML = `
    <div class="prop-annex-head"><i></i><span>Annexure A · Scope of Work</span></div>
    <h1 class="prop-title offering-title" contenteditable="true" spellcheck="false">${escapeHtml(headText || short)}</h1>
  `;
  first.parentNode.insertBefore(h, first);
}

function deselectService(key) {
  pushUndo();
  const check = panelCheck(key);
  const amt = panelAmtInput(key);
  check.checked = false;
  panelRow(key).classList.remove("on");
  amt.hidden = true;
  amt.disabled = false;
  offeringHead(key)?.remove();
  delete REMOVED_SECS[key];
  document.querySelector(`.restore-bar[data-key="${key}"]`)?.remove();
  // a sectioned offering owns several cards — remove them all, along
  // with any custom items added inside this offering
  document
    .querySelectorAll(`.svc-card[data-key="${key}"], .svc-card.custom-card[data-parent="${key}"]`)
    .forEach((card) => {
      document
        .querySelectorAll(`.svc-cont[data-cont-for="${card.dataset.uid}"]`)
        .forEach((c) => c.remove());
      card.remove();
    });
  rebuildDocs();
  recalc();
}

/* ---------- offering groups: sections + their custom items ---------- */

/* every card belongs to a group: an offering's sections carry its key,
   custom items carry the offering in data-parent, and standalone
   custom items form their own group */
function cardGroup(c) {
  return c.dataset.key || c.dataset.parent || (c.classList.contains("custom-card") ? "__custom" : "");
}

/* last element of an offering's block (sections, continuations and
   custom items), in document order */
function groupLast(key) {
  const els = [
    ...document.querySelectorAll(
      `.svc-card:not(.svc-cont)[data-key="${key}"], .svc-card.custom-card[data-parent="${key}"]`
    ),
  ];
  if (!els.length) return null;
  let last = els[els.length - 1];
  while (last.nextElementSibling && last.nextElementSibling.classList.contains("svc-cont"))
    last = last.nextElementSibling;
  return last;
}

/* ---------- drag & drop: reorder cards within their group ---------- */

let DRAG_CARD = null;

function wireSectionDrag(card) {
  const handle = card.querySelector(".drag-handle");
  // the card is only draggable while the grip is held, so text
  // selection and contenteditable keep working everywhere else
  handle.addEventListener("mousedown", () => (card.draggable = true));
  handle.addEventListener("mouseup", () => (card.draggable = false));
  card.addEventListener("dragstart", (e) => {
    DRAG_CARD = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  });
  card.addEventListener("dragend", () => {
    card.draggable = false;
    card.classList.remove("dragging");
    DRAG_CARD = null;
    document
      .querySelectorAll(".drop-above, .drop-below")
      .forEach((c) => c.classList.remove("drop-above", "drop-below"));
  });
  card.addEventListener("dragover", (e) => {
    if (!DRAG_CARD || DRAG_CARD === card || cardGroup(DRAG_CARD) !== cardGroup(card)) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    card.classList.toggle("drop-above", above);
    card.classList.toggle("drop-below", !above);
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop-above", "drop-below"));
  card.addEventListener("drop", (e) => {
    if (!DRAG_CARD || DRAG_CARD === card || cardGroup(DRAG_CARD) !== cardGroup(card)) return;
    e.preventDefault();
    const above = card.classList.contains("drop-above");
    card.classList.remove("drop-above", "drop-below");
    pushUndo();
    if (above) card.before(DRAG_CARD);
    else card.after(DRAG_CARD);
    const grp = cardGroup(card);
    if (grp && grp !== "__custom") updateRestoreBar(grp);
    rebuildDocs();
    recalc();
  });
}

/* removed sections are remembered (per offering, this session) so
   they can be added back with one click from the restore bar */
let REMOVED_SECS = {};

/* remove a SINGLE section of a multi-section offering; only when the
   last remaining section goes do we deselect the whole offering */
function removeSectionCard(card, key) {
  pushUndo();
  // snapshot the section (with any edits) so it can be restored
  const inp = card.querySelector(".i-amt");
  (REMOVED_SECS[key] = REMOVED_SECS[key] || []).push({
    secIdx: parseInt(card.dataset.sec, 10) || 0,
    title: card.querySelector(".card-title")?.innerText.trim() || "Section",
    priced: !!inp,
    hidePrice: inp ? inp.type === "hidden" : false,
    amount: inp ? parseAmt(inp.value) : 0,
    sub: cardSubLines(card).join("\n"),
  });
  REMOVED_SECS[key].sort((a, b) => a.secIdx - b.secIdx);

  document
    .querySelectorAll(`.svc-cont[data-cont-for="${card.dataset.uid}"]`)
    .forEach((c) => c.remove());
  card.remove();
  const remaining = document.querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"]`);
  if (!remaining.length) {
    deselectService(key);
    return;
  }
  const panelAmt = panelAmtInput(key);
  if (panelAmt) panelAmt.value = fmt0(serviceTotal(key));
  updateRestoreBar(key);
  rebuildDocs();
  recalc();
}

/* "+ Add Section" bar (screen only) listing this offering's removed
   sections — clicking one puts it back in its original position */
function updateRestoreBar(key) {
  document.querySelector(`.restore-bar[data-key="${key}"]`)?.remove();
  const removed = REMOVED_SECS[key];
  if (!removed || !removed.length) return;
  const cards = [...document.querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"]`)];
  if (!cards.length) return;
  const bar = document.createElement("div");
  bar.className = "restore-bar no-print";
  bar.dataset.key = key;
  bar.innerHTML =
    `<span class="rb-label">Add section:</span>` +
    removed
      .map((s, i) => `<button class="rb-btn" data-i="${i}">＋ ${escapeHtml(s.title)}</button>`)
      .join("");
  bar.querySelectorAll(".rb-btn").forEach((btn) =>
    btn.addEventListener("click", () => restoreSection(key, parseInt(btn.dataset.i, 10)))
  );
  (groupLast(key) || cards[cards.length - 1]).after(bar);
}

function restoreSection(key, i) {
  pushUndo();
  const removed = REMOVED_SECS[key];
  const s = removed && removed[i];
  if (!s) return;
  removed.splice(i, 1);
  const cards = [...document.querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"]`)];
  // back into catalogue order: after the last card with a lower index
  const afterEl = [...cards].reverse().find((c) => (parseInt(c.dataset.sec, 10) || 0) < s.secIdx) || null;
  const card = addSectionCard(key, s.secIdx, s.title, s.priced, s.amount, s.sub, s.hidePrice, afterEl);
  if (!afterEl && cards.length) cards[0].before(card);
  const panelAmt = panelAmtInput(key);
  if (panelAmt) panelAmt.value = fmt0(serviceTotal(key));
  updateRestoreBar(key);
  rebuildDocs();
  recalc();
}

/* ---------- Annexure A cards ---------- */

/* cards live wherever pagination put them — always query globally */
function serviceCard(key) {
  return document.querySelector(`.svc-card[data-key="${key}"]`);
}

function allCards() {
  return [...document.querySelectorAll(".svc-card:not(.svc-cont)")];
}

function cardSubLines(card) {
  const conts = document.querySelectorAll(
    `.svc-cont[data-cont-for="${card.dataset.uid}"] .card-list > li`
  );
  return [...card.querySelectorAll(".card-list > li"), ...conts]
    .map((li) => li.innerText.trim())
    .filter(Boolean);
}

/* scope lines render numbered; a "Lead-in: detail" line gets a bold lead */
function scopeListHtml(subText) {
  const lines = String(subText).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines
    .map((l) => {
      const m = /^([^:]{2,60}):\s*(.+)$/.exec(l);
      return m
        ? `<li><b>${escapeHtml(m[1])}:</b> ${escapeHtml(m[2])}</li>`
        : `<li>${escapeHtml(l)}</li>`;
    })
    .join("");
}

/* sheet amount -> panel amount (marks the amount as custom) */
function bindServiceAmt(card, key) {
  const amt = card.querySelector('input.i-amt:not([type="hidden"])');
  if (!amt) return;
  amt.addEventListener("input", () => {
    card.dataset.customAmt = "1";
    const panelAmt = panelAmtInput(key);
    if (panelAmt) panelAmt.value = amt.value;
    recalc();
  });
  amt.addEventListener("focus", () => (amt.value = parseAmt(amt.value) || ""));
  amt.addEventListener("blur", () => {
    amt.value = fmt0(parseAmt(amt.value));
    setTimeout(recalc, 0); // run the repagination deferred while typing
  });
}

function addServiceCard(key, amount, subText, customAmt, included) {
  if (serviceCard(key)) return serviceCard(key);
  const card = document.createElement("div");
  card.className = "svc-card";
  card.dataset.key = key;
  card.dataset.uid = String(++CARD_UID);
  if (customAmt) card.dataset.customAmt = "1";
  if (included) card.dataset.included = "1";
  const pill = included
    ? `<div class="card-pill card-pill-outline">Included in our scope</div><input type="hidden" class="i-amt" value="0">`
    : `<div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(amount)}" readonly><span>/-</span></div>`;
  card.innerHTML = `
    <div class="card-head">
      <div class="card-title" contenteditable="true" spellcheck="false">${escapeHtml(CATALOGUE[key].label)}</div>
      ${pill}
      <button class="pill-toggle no-print" title="Switch between a price and Included in our scope">${ICON_SWAP}</button>
      <button class="row-del no-print" title="Remove service">${ICON_X}</button>
    </div>
    <ol class="card-list" contenteditable="true" spellcheck="false" title="Scope items (click to edit)">${scopeListHtml(subText)}</ol>
  `;
  card.querySelector(".row-del").addEventListener("click", () => deselectService(key));
  card.querySelector(".pill-toggle").addEventListener("click", () => toggleServicePill(card, key));
  bindServiceAmt(card, key);

  // service cards keep catalogue order; a custom card inside an
  // offering counts at its parent's position — only standalone
  // custom cards sit below everything
  const myIdx = ORDER.indexOf(key);
  let anchor = null;
  for (const el of allCards()) {
    const k = el.dataset.key || el.dataset.parent;
    if (!k) { anchor = el; break; }            // first standalone custom card
    if (ORDER.indexOf(k) > myIdx) { anchor = el; break; }
  }
  if (anchor) anchor.parentNode.insertBefore(card, anchor);
  else {
    const all = [...document.querySelectorAll(".svc-card")];
    if (all.length) all[all.length - 1].after(card);
    else $("svcCards").appendChild(card);
  }
  return card;
}

/* flip a section between a price and "Included in our scope"; the
   last price is remembered so flipping back restores it */
function toggleSectionPill(card, key) {
  pushUndo();
  const pill = card.querySelector(".card-pill");
  const wasIncluded = pill.classList.contains("card-pill-outline");
  const otherInputs = () =>
    [...document.querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"] input.i-amt:not([type="hidden"])`)]
      .filter((i) => i.closest(".svc-card") !== card);
  if (!wasIncluded) {
    const inp = card.querySelector(".i-amt");
    const amt = parseAmt(inp?.value) || 0;
    card.dataset.lastAmt = String(amt);
    const others = otherInputs();
    if (amt > 0 && !others.length) {
      // no other priced section can absorb this fee (e.g. a package's
      // only priced section) — keep it in a hidden field so the
      // offering total stands while the card reads "Included"
      pill.outerHTML = sectionPillHtml(true, amt, true);
      const panelAmt0 = panelAmtInput(key);
      if (panelAmt0) panelAmt0.value = fmt0(serviceTotal(key));
      recalc();
      return;
    }
    pill.outerHTML = sectionPillHtml(false, 0);
    // the offering total must not change: spread this section's price
    // proportionally over the remaining priced sections below
    if (amt > 0 && others.length) {
      const base = others.reduce((s, i) => s + parseAmt(i.value), 0);
      let remaining = amt;
      const adj = {};
      others.forEach((i, idx) => {
        const v = parseAmt(i.value);
        const share =
          idx === others.length - 1
            ? remaining
            : Math.round(amt * (base > 0 ? v / base : 1 / others.length));
        remaining -= share;
        i.value = fmt0(v + share);
        adj[i.closest(".svc-card").dataset.uid] = share;
      });
      card.dataset.absorbed = JSON.stringify(adj);
    }
  } else {
    // give back exactly what the other sections absorbed, then
    // restore this section's own price
    try {
      const adj = JSON.parse(card.dataset.absorbed || "{}");
      Object.entries(adj).forEach(([uid, share]) => {
        const inp = document.querySelector(`.svc-card[data-uid="${uid}"] input.i-amt:not([type="hidden"])`);
        if (inp) inp.value = fmt0(Math.max(0, parseAmt(inp.value) - share));
      });
    } catch (e) {}
    delete card.dataset.absorbed;
    const secIdx = parseInt(card.dataset.sec, 10) || 0;
    const catAmt =
      (CATALOGUE[key].sections && CATALOGUE[key].sections[secIdx] && CATALOGUE[key].sections[secIdx].price) || 0;
    // a hidden-price section (package fee) restores from its hidden
    // field — remove it so the fee isn't counted twice
    const hidden = card.querySelector('input.i-amt[type="hidden"]');
    const hiddenVal = hidden ? parseAmt(hidden.value) : 0;
    hidden?.remove();
    pill.outerHTML = sectionPillHtml(true, hiddenVal || parseAmt(card.dataset.lastAmt || "0") || catAmt);
    bindSectionAmt(card, key);
  }
  const panelAmt = panelAmtInput(key);
  if (panelAmt) panelAmt.value = fmt0(serviceTotal(key));
  recalc();
}

/* same flip for a single-card (individual) service */
function toggleServicePill(card, key) {
  pushUndo();
  const pill = card.querySelector(".card-pill");
  const wasIncluded = pill.classList.contains("card-pill-outline");
  if (!wasIncluded) {
    card.dataset.lastAmt = String(parseAmt(card.querySelector(".i-amt")?.value) || 0);
    card.dataset.included = "1";
    pill.outerHTML = `<div class="card-pill card-pill-outline">Included in our scope</div><input type="hidden" class="i-amt" value="0">`;
  } else {
    delete card.dataset.included;
    card.querySelector('input.i-amt[type="hidden"]')?.remove();
    const amt = parseAmt(card.dataset.lastAmt || "0") || RATES.amounts[key] || 0;
    card.querySelector(".card-pill").outerHTML =
      `<div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(amt)}" readonly><span>/-</span></div>`;
    bindServiceAmt(card, key);
  }
  const panelAmt = panelAmtInput(key);
  if (panelAmt) panelAmt.value = fmt0(card.dataset.included === "1" ? 0 : parseAmt(card.querySelector(".i-amt").value));
  recalc();
}

/* sectioned offerings (registration & retainer packages) render one
   card per section — priced sections get a fee pill, the rest read
   "INCLUDED IN OUR SCOPE" like the 5.pdf design */
function addSectionCards(key, secs) {
  if (serviceCard(key)) return;
  let prev = null;
  // newer saves carry each section's catalogue index, so removed
  // sections stay removed and a dragged order is reproduced exactly;
  // legacy saves map by position in catalogue order
  const hasIdx = Array.isArray(secs) && secs.length > 0 && secs[0] && secs[0].idx !== undefined;
  if (hasIdx) {
    secs.forEach((s) => {
      const sec = CATALOGUE[key].sections[s.idx];
      if (!sec) return;
      prev = addSectionCard(key, s.idx, sec.title, s.amt != null, s.amt || 0, s.sub, sec.hidePrice, prev);
    });
    return;
  }
  CATALOGUE[key].sections.forEach((sec, i) => {
    const saved = secs ? secs[i] : null;
    const priced = saved ? saved.amt != null : sec.price != null;
    const amount = saved ? saved.amt || 0 : sec.price || 0;
    const sub = saved ? saved.sub : sec.items.join("\n");
    prev = addSectionCard(key, i, sec.title, priced, amount, sub, sec.hidePrice, prev);
  });
}

/* Exclusions print under Terms & Conditions, in the same theme —
   the union of the selected offerings' lists, add-on adjusted */
function rebuildExclusions() {
  const lines = [];
  selectedKeys().forEach((k) => {
    currentExclusionLines(k).forEach((l) => {
      if (!lines.includes(l)) lines.push(l);
    });
  });
  const list = $("exclList");
  list.innerHTML = "";
  lines.forEach((l) => {
    const li = document.createElement("li");
    li.textContent = l;
    list.appendChild(li);
  });
  $("exclBlock").classList.toggle("empty", lines.length === 0);
  schedulePaginate();
}

// pill markup for a section: a price input, or the outline
// "Included in our scope" tag
function sectionPillHtml(priced, amount, hidePrice) {
  // priced but hidden: show the "Included in our scope" tag while the
  // amount rides along in a hidden field so it still feeds the fee
  if (priced && hidePrice) {
    return `<div class="card-pill card-pill-outline">Included in our scope</div><input type="hidden" class="i-amt" value="${amount || 0}">`;
  }
  return priced
    ? `<div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(amount || 0)}" readonly><span>/-</span></div>`
    : `<div class="card-pill card-pill-outline">Included in our scope</div>`;
}

// (re)attach the amount-input listeners for a section card
function bindSectionAmt(card, key) {
  const amt = card.querySelector(".i-amt");
  if (!amt || amt.type === "hidden") return;
  amt.addEventListener("input", () => {
    const panelAmt = panelAmtInput(key);
    if (panelAmt) panelAmt.value = fmt0(serviceTotal(key));
    recalc();
  });
  amt.addEventListener("focus", () => {
    amt.dataset.prev = String(parseAmt(amt.value) || 0);
    amt.value = parseAmt(amt.value) || "";
  });
  amt.addEventListener("blur", () => {
    amt.value = fmt0(parseAmt(amt.value));
    // re-bifurcation: editing one section's price offsets the others
    // so the offering total stays put (registration & individual only)
    if (!isYearly(key))
      rebalanceSections(card, key, parseAmt(amt.dataset.prev || "0"), parseAmt(amt.value));
    setTimeout(recalc, 0); // run the repagination deferred while typing
  });
}

/* spread an edit's delta over the OTHER priced sections (proportional,
   never below zero) so the offering's total does not change */
function rebalanceSections(card, key, oldV, newV) {
  let delta = newV - oldV; // positive → others shrink; negative → grow
  if (!delta) return;
  const others = [
    ...document.querySelectorAll(
      `.svc-card:not(.svc-cont)[data-key="${key}"] input.i-amt:not([type="hidden"])`
    ),
  ].filter((i) => i.closest(".svc-card") !== card);
  if (!others.length) return;
  const base = others.reduce((s, i) => s + parseAmt(i.value), 0);
  if (delta > 0 && base <= 0) return; // nothing left to absorb from
  let remaining = delta;
  others.forEach((i, idx) => {
    const v = parseAmt(i.value);
    let share =
      idx === others.length - 1
        ? remaining
        : Math.round(delta * (base > 0 ? v / base : 1 / others.length));
    if (v - share < 0) share = v; // a section can't go negative
    remaining -= share;
    i.value = fmt0(v - share);
  });
  const panelAmt = panelAmtInput(key);
  if (panelAmt) panelAmt.value = fmt0(serviceTotal(key));
  recalc();
}

function addSectionCard(key, secIdx, title, priced, amount, sub, hidePrice, afterEl) {
  const card = document.createElement("div");
  card.className = "svc-card";
  card.dataset.key = key;
  card.dataset.sec = String(secIdx);
  card.dataset.uid = String(++CARD_UID);
  // every section flips between a price and "Included in our scope"
  // via the sidebar dropdown (the on-card button stays hidden)
  const canToggle = true;
  card.innerHTML = `
    <div class="card-head">
      <button class="drag-handle no-print" title="Drag to reorder within this offering">${ICON_GRIP}</button>
      <div class="card-title" contenteditable="true" spellcheck="false">${escapeHtml(title)}</div>
      ${sectionPillHtml(priced, amount, hidePrice)}
      ${canToggle ? `<button class="pill-toggle no-print" title="Switch between a price and Included in our scope">${ICON_SWAP}</button>` : ""}
      <button class="row-del no-print" title="Remove this section">${ICON_X}</button>
    </div>
    <ol class="card-list" contenteditable="true" spellcheck="false" title="Scope items (click to edit)">${scopeListHtml(sub)}</ol>
  `;
  card.querySelector(".row-del").addEventListener("click", () => removeSectionCard(card, key));
  card.querySelector(".pill-toggle")?.addEventListener("click", () => toggleSectionPill(card, key));
  wireSectionDrag(card);
  bindSectionAmt(card, key);

  if (afterEl) afterEl.after(card);
  else {
    const myIdx = ORDER.indexOf(key);
    let anchor = null;
    for (const el of allCards()) {
      const k = el.dataset.key || el.dataset.parent;
      if (!k) { anchor = el; break; }
      if (ORDER.indexOf(k) > myIdx) { anchor = el; break; }
    }
    if (anchor) {
      const at = anchorWithHead(anchor);
      at.parentNode.insertBefore(card, at);
    } else {
      const all = [...document.querySelectorAll(".svc-card")];
      if (all.length) all[all.length - 1].after(card);
      else $("svcCards").appendChild(card);
    }
  }
  return card;
}

/* index: numbered list of the selected offerings with their fees.
   An offering's amount includes its own custom items. */
function offeringAmount(key) {
  let t;
  if (CATALOGUE[key].sections) t = serviceTotal(key);
  else {
    const card = serviceCard(key);
    t = card ? parseAmt(card.querySelector(".i-amt").value) : 0;
  }
  document
    .querySelectorAll(`.svc-card.custom-card[data-parent="${key}"]:not(.gov-card) .i-amt`)
    .forEach((i) => (t += parseAmt(i.value)));
  return t;
}

/* government fees of one offering (or all, when key is omitted) —
   kept apart from the professional fee: no GST, no grand total */
function govTotal(key) {
  let t = 0;
  const sel = key
    ? `.svc-card.gov-card[data-parent="${key}"] .i-amt`
    : `.svc-card.gov-card .i-amt`;
  document.querySelectorAll(sel).forEach((i) => (t += parseAmt(i.value)));
  return t;
}

function rebuildIndex() {
  const keys = selectedKeys();
  const tbl = $("indexTable");
  if (!tbl) return;

  // one line per billed item: offerings first, then custom items
  const lines = keys.map((k) => ({
    name:
      (offeringHead(k) && offeringHead(k).querySelector(".offering-title")?.innerText.trim()) ||
      SHORT_TITLES[k] || CATALOGUE[k].label,
    amt: offeringAmount(k),
    yearly: isYearly(k),
  }));
  // items inside an offering roll into that offering's amount; only
  // standalone custom items get their own index row
  document.querySelectorAll(".svc-card.custom-card:not([data-parent])").forEach((c) => {
    const desc = c.querySelector(".i-desc")?.value.trim();
    const amt = parseAmt(c.querySelector(".i-amt")?.value);
    if (desc || amt) lines.push({ name: desc || "Custom item", amt, yearly: c.dataset.yearly === "1" });
  });

  // names only — prices live in the Payment Summary at the end
  tbl.innerHTML = lines
    .map(
      (l, i) =>
        `<tr><td class="ix-no">${String(i + 1).padStart(2, "0")}</td><td>${escapeHtml(l.name)}</td></tr>`
    )
    .join("");

  // no totals here — the grand total prints at the end of the document
  // in the Professional Fee box, with the yearly payable under it
  $("indexBlock").classList.toggle("empty", lines.length < 1);
}

/* per-offering fee strip — when more than one thing is billed, each
   offering's charge prints at the end of its own section, before the
   next offering begins (same style as the Professional Fee box) */
/* right side of a professional fee strip (split by billing type) */
function profRightHtml(key, gst) {
  const offYearly = isYearly(key);
  let main = CATALOGUE[key].sections
    ? serviceTotal(key)
    : serviceCard(key)
      ? parseAmt(serviceCard(key).querySelector(".i-amt").value)
      : 0;
  const odd = [];
  document.querySelectorAll(`.svc-card.custom-card[data-parent="${key}"]:not(.gov-card)`).forEach((c) => {
    const amt = parseAmt(c.querySelector(".i-amt")?.value);
    const yr = c.dataset.yearly === "1";
    if (yr === offYearly) main += amt;
    else odd.push({ name: c.querySelector(".i-desc")?.value.trim() || "Custom item", amt, yr });
  });
  const mainLabel = offYearly ? "Package (Per Year)" : "One-time";
  return odd.length
    ? odd
        .map(
          (o) =>
            `<div class="of-line"><span>${escapeHtml(o.name)}${o.yr ? " (Per Year)" : ""}</span><b>₹${fmt0(o.amt)}/-</b></div>`
        )
        .join("") +
      `<div class="of-line"><span>${mainLabel}</span><b>₹${fmt0(main)}/-</b></div>`
    : `<div class="of-amt">₹${fmt0(main)}/-${offYearly ? "*" : ""}</div>` +
      (offYearly ? `<div class="of-per">*Payable per Year</div>` : "");
}

function rebuildOfferingFees() {
  const gst0 = parseFloat($("taxRate").value) || 0;
  // while an input inside a card has focus, only refresh amounts in
  // place — removing/re-adding strips would make the card jump around
  // under the user's cursor; the full rebuild runs on blur
  const typing =
    document.activeElement && document.activeElement.closest && document.activeElement.closest(".svc-card");
  if (typing) {
    document.querySelectorAll(".offering-fee:not(.gov-fee)").forEach((f) => {
      const right = f.querySelector(".of-right");
      if (f.dataset.key && right) right.innerHTML = profRightHtml(f.dataset.key, gst0);
    });
    // gov strips appear/update/disappear LIVE as the value is typed —
    // they sit below the cursor, so the focused card never moves
    selectedKeys().forEach((key) => {
      const gv = govTotal(key);
      let strip = document.querySelector(`.offering-fee.gov-fee[data-key="${key}"]`);
      if (gv > 0 && !strip) {
        let anchor = groupLast(key);
        if (!anchor) return;
        if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("restore-bar"))
          anchor = anchor.nextElementSibling;
        strip = document.createElement("div");
        strip.className = "offering-fee gov-fee";
        strip.dataset.key = key;
        strip.innerHTML = `
          <div class="of-left">
            <div class="of-label">Government Fees</div>
            <div class="of-note">GST not applicable</div>
          </div>
          <div class="of-right"><div class="of-amt">₹${fmt0(gv)}/-</div></div>`;
        anchor.after(strip);
      } else if (strip) {
        if (gv > 0)
          strip.querySelector(".of-right").innerHTML = `<div class="of-amt">₹${fmt0(gv)}/-</div>`;
        else strip.remove();
      }
    });
    return;
  }
  document.querySelectorAll(".offering-fee, .offering-add").forEach((el) => el.remove());
  const keys = selectedKeys();
  const gst = parseFloat($("taxRate").value) || 0;
  // per-offering fee strips only make sense with 2+ offerings — a
  // custom item alone must not trigger them
  const showFees = keys.length >= 2;
  keys.forEach((key) => {
    let anchor = groupLast(key);
    if (!anchor) return;
    // trailing widgets sit after the restore bar, if one is showing
    if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("restore-bar"))
      anchor = anchor.nextElementSibling;

    if (showFees) {
      const div = document.createElement("div");
      div.className = "offering-fee";
      div.dataset.key = key;
      div.innerHTML = `
        <div class="of-left">
          <div class="of-label">Professional Fee</div>
          <div class="of-note">Exclusive of ${gst}% GST</div>
        </div>
        <div class="of-right">${profRightHtml(key, gst)}</div>`;
      anchor.after(div);
    }
    // government fees strip: GST-free, outside the professional totals
    const gv = govTotal(key);
    if (gv > 0) {
      const gdiv = document.createElement("div");
      gdiv.className = "offering-fee gov-fee";
      gdiv.dataset.key = key;
      gdiv.innerHTML = `
        <div class="of-left">
          <div class="of-label">Government Fees</div>
          <div class="of-note">GST not applicable</div>
        </div>
        <div class="of-right"><div class="of-amt">₹${fmt0(gv)}/-</div></div>`;
      anchor.after(gdiv);
    }
    // every offering carries its own add buttons (screen only)
    const addGov = document.createElement("button");
    addGov.className = "btn btn-add no-print offering-add";
    addGov.innerHTML = ICON_PLUS + "Add Government Fees";
    addGov.addEventListener("click", () => addCustomCard({ gov: true }, key));
    anchor.after(addGov);
    const add = document.createElement("button");
    add.className = "btn btn-add no-print offering-add";
    add.innerHTML = ICON_PLUS + "Add Item";
    add.addEventListener("click", () => addCustomCard({}, key));
    anchor.after(add);
  });
  // the global add button only serves quotes without any offering
  const global = $("btnAddRow");
  if (global) global.style.display = keys.length ? "none" : "";
}

/* total of a sectioned offering = sum of its priced pills */
function serviceTotal(key) {
  let t = 0;
  document
    .querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"] .i-amt`)
    .forEach((inp) => (t += parseAmt(inp.value)));
  return t;
}

/* package exclusions, adjusted by the Other Services add-ons:
   - extension on  → the 7(3) exclusion drops "Section 7(3)"
   - correction on → the section 14(2) exclusion line disappears */
function currentExclusionLines(key) {
  let lines = [...(CATALOGUE[key].exclusions || [])];
  if (key.startsWith("package_")) {
    if (OTHER.extension.on)
      lines = lines.map((l) =>
        l.startsWith("Project Time Extension")
          ? "Project Time Extension under Section 6, Order No. 40, or any other applicable provisions and directions issued by MahaRERA"
          : l
      );
    if (OTHER.correction.on)
      lines = lines.filter((l) => !l.startsWith("Project Amendment under section 14(2)"));
  }
  return lines;
}

function setOtherState(okey, on, count) {
  if (OTHER[okey].on !== on || (count && OTHER[okey].count !== count)) pushUndo();
  OTHER[okey].on = on;
  if (count) OTHER[okey].count = count;
  const check = document.querySelector(`.other-check[data-okey="${okey}"]`);
  const cnt = document.querySelector(`.other-count[data-okey="${okey}"]`);
  if (check) {
    check.checked = on;
    check.closest(".svc-row").classList.toggle("on", on);
  }
  if (cnt) {
    cnt.hidden = !on;
    cnt.value = OTHER[okey].count;
  }
}

function removeCardWithConts(card) {
  document
    .querySelectorAll(`.svc-cont[data-cont-for="${card.dataset.uid}"]`)
    .forEach((c) => c.remove());
  card.remove();
}

function refreshOtherServices() {
  // 1 · the printed Exclusions section follows the add-on state
  rebuildExclusions();

  // 2 · maintain the Other Services card
  const lines = [];
  if (OTHER.extension.on) lines.push(OTHER_DEFS.extension.line(countWord(OTHER.extension.count)));
  if (OTHER.correction.on) lines.push(OTHER_DEFS.correction.line(countWord(OTHER.correction.count)));

  let card = document.querySelector('.svc-card[data-other="1"]');
  if (!lines.length) {
    if (card) removeCardWithConts(card);
    recalc();
    return;
  }
  const html = scopeListHtml(lines.join("\n"));
  if (!card) {
    card = document.createElement("div");
    card.className = "svc-card";
    card.dataset.other = "1";
    card.dataset.uid = String(++CARD_UID);
    card.innerHTML = `
      <div class="card-head">
        <div class="card-title">Other Services</div>
        <div class="card-pill card-pill-outline">Included in our scope</div>
        <button class="row-del no-print" title="Remove Other Services">${ICON_X}</button>
      </div>
      <ol class="card-list" contenteditable="true" spellcheck="false" title="Other services (click to edit)">${html}</ol>
    `;
    card.querySelector(".row-del").addEventListener("click", () => {
      setOtherState("extension", false);
      setOtherState("correction", false);
      refreshOtherServices();
    });
    // sits after the last service card, before any custom items
    const firstCustom = document.querySelector(".svc-card.custom-card");
    if (firstCustom) firstCustom.parentNode.insertBefore(card, firstCustom);
    else {
      const all = [...document.querySelectorAll(".svc-card")];
      if (all.length) all[all.length - 1].after(card);
      else $("svcCards").appendChild(card);
    }
  } else if (!card.contains(document.activeElement)) {
    document
      .querySelectorAll(`.svc-cont[data-cont-for="${card.dataset.uid}"]`)
      .forEach((c) => c.remove());
    card.querySelector(".card-list").innerHTML = html;
  }
  recalc();
}

/* free-form custom card (e.g. liaison visits, drafting extras).
   With a parent offering it sits inside that offering's block and its
   amount rolls into the offering's totals; the Per Year / One-time
   toggle decides which grand-total bucket it lands in (packages
   default to Per Year). */
function addCustomCard(item = {}, parentKey) {
  pushUndo();
  const it = { desc: "", sub: "", amt: 0, ...item };
  const parent = parentKey || it.parent || null;
  const gov = !!it.gov; // government fees: no GST, outside the professional totals
  const yearly = it.yearly !== undefined ? !!it.yearly : isYearly(parent);
  const card = document.createElement("div");
  card.className = "svc-card custom-card" + (gov ? " gov-card" : "");
  card.dataset.uid = String(++CARD_UID);
  if (parent) card.dataset.parent = parent;
  if (gov) card.dataset.gov = "1";
  card.dataset.yearly = yearly ? "1" : "0";
  const included = !gov && !!it.included;
  if (included) {
    card.dataset.included = "1";
    card.dataset.lastAmt = String(it.amt || 0);
  }
  const descVal = it.desc || (gov ? "Government Fees" : "");
  const pillHtml = included
    ? `<div class="card-pill card-pill-outline">Included in our scope</div><input type="hidden" class="i-amt" value="0">`
    : `<div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(it.amt)}"><span>/-</span></div>`;
  card.innerHTML = `
    <div class="card-head">
      <button class="drag-handle no-print" title="Drag to reorder">${ICON_GRIP}</button>
      <input type="text" class="i-desc" placeholder="ITEM / SERVICE NAME" value="${escapeAttr(descVal)}">
      ${gov ? "" : `<button class="yr-toggle no-print" title="Billed per year or one-time">${yearly ? "Per Year" : "One-time"}</button>`}
      ${gov ? "" : `<button class="pill-toggle no-print" title="Switch between a price and Included in our scope">${ICON_SWAP}</button>`}
      ${pillHtml}
      <button class="row-del no-print" title="Remove item">${ICON_X}</button>
    </div>
    <ol class="card-list" contenteditable="true" spellcheck="false" title="Details (click to edit)">${scopeListHtml(it.sub) || "<li><br></li>"}</ol>
  `;
  card.querySelector(".yr-toggle")?.addEventListener("click", () => {
    pushUndo();
    const yr = card.dataset.yearly !== "1";
    card.dataset.yearly = yr ? "1" : "0";
    card.querySelector(".yr-toggle").textContent = yr ? "Per Year" : "One-time";
    recalc();
  });
  wireSectionDrag(card);
  card.querySelector(".row-del").addEventListener("click", () => {
    pushUndo();
    document
      .querySelectorAll(`.svc-cont[data-cont-for="${card.dataset.uid}"]`)
      .forEach((c) => c.remove());
    card.remove();
    recalc();
  });
  function wireInputs() {
    card.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", recalc);
      // the full rebuild + repagination deferred while typing runs here
      inp.addEventListener("blur", () => setTimeout(recalc, 0));
    });
    const amt = card.querySelector('input.i-amt:not([type="hidden"])');
    if (amt) {
      amt.addEventListener("focus", () => (amt.value = parseAmt(amt.value) || ""));
      amt.addEventListener("blur", () => (amt.value = fmt0(parseAmt(amt.value))));
    }
  }
  wireInputs();

  // price <-> "Included in our scope"; the price is remembered so
  // flipping back restores it
  card.querySelector(".pill-toggle")?.addEventListener("click", () => {
    pushUndo();
    const pill = card.querySelector(".card-pill");
    if (!pill.classList.contains("card-pill-outline")) {
      card.dataset.lastAmt = String(parseAmt(card.querySelector(".i-amt")?.value) || 0);
      card.dataset.included = "1";
      pill.outerHTML = `<div class="card-pill card-pill-outline">Included in our scope</div><input type="hidden" class="i-amt" value="0">`;
    } else {
      delete card.dataset.included;
      card.querySelector('input.i-amt[type="hidden"]')?.remove();
      const back = parseAmt(card.dataset.lastAmt || "0");
      card.querySelector(".card-pill").outerHTML =
        `<div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(back)}"><span>/-</span></div>`;
      wireInputs();
    }
    recalc();
  });

  // with a parent: inside that offering's block, after its last card;
  // standalone: after every existing card, wherever pagination put it
  const anchor = parent ? groupLast(parent) : null;
  if (anchor) anchor.after(card);
  else {
    const all = [...document.querySelectorAll(".svc-card")];
    if (all.length) all[all.length - 1].after(card);
    else $("svcCards").appendChild(card);
  }
  recalc();
  return card;
}

function readItems() {
  const services = [];
  const customItems = [];
  const seen = new Set();
  allCards().forEach((card) => {
    if (card.dataset.other) return; // Other Services card is derived from OTHER state
    const key = card.dataset.key;
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
      if (CATALOGUE[key] && CATALOGUE[key].sections) {
        // sectioned: capture every section's pill & edited items
        const cards = [...document.querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"]`)];
        const secs = cards.map((c) => ({
          idx: parseInt(c.dataset.sec, 10) || 0,
          amt: c.querySelector(".i-amt") ? parseAmt(c.querySelector(".i-amt").value) : null,
          sub: cardSubLines(c).join("\n"),
        }));
        services.push({ key, amt: serviceTotal(key), secs, head: offeringHead(key)?.querySelector(".offering-title")?.innerText.trim() });
      } else {
        services.push({
          key,
          amt: parseAmt(card.querySelector(".i-amt").value),
          sub: cardSubLines(card).join("\n"),
          customAmt: card.dataset.customAmt === "1",
          included: card.dataset.included === "1",
          head: offeringHead(key)?.querySelector(".offering-title")?.innerText.trim(),
        });
      }
    } else {
      customItems.push({
        desc: card.querySelector(".i-desc").value,
        sub: cardSubLines(card).join("\n"),
        // included items keep their remembered price so toggling back
        // after a reload restores it
        amt: card.dataset.included === "1"
          ? parseAmt(card.dataset.lastAmt || "0")
          : parseAmt(card.querySelector(".i-amt").value),
        included: card.dataset.included === "1",
        parent: card.dataset.parent || null,
        yearly: card.dataset.yearly === "1",
        gov: card.dataset.gov === "1",
      });
    }
  });
  return { services, customItems };
}

/* ---------- totals & proposal sync ---------- */

// retainer packages are billed yearly; everything else is one-time
function isYearly(key) {
  return typeof key === "string" && key.indexOf("package_") === 0;
}

function recalc() {
  let oneTime = 0;
  let yearly = 0;
  allCards().forEach((card) => {
    if (card.classList.contains("gov-card")) return; // govt fees stay apart
    const inp = card.querySelector(".i-amt");   // "included" cards carry no pill
    if (!inp) return;
    const v = parseAmt(inp.value);
    // custom items follow their own Per Year toggle; sections follow
    // their offering type
    const yr = card.classList.contains("custom-card")
      ? card.dataset.yearly === "1"
      : isYearly(card.dataset.key);
    if (yr) yearly += v;
    else oneTime += v;
  });
  const gov = govTotal();
  const svcCount = selectedKeys().length;

  const discountRate = parseFloat($("discountRate").value) || 0;
  const taxRate = parseFloat($("taxRate").value) || 0;
  const afterDisc = (a) => a - a * (discountRate / 100);

  const oneTimeFee = afterDisc(oneTime);      // Grand Total (one-time, excl. GST)
  const yearlyFee = afterDisc(yearly);        // Yearly Payable (excl. GST)
  const totalFee = oneTimeFee + yearlyFee;
  const tax = totalFee * (taxRate / 100);
  const grand = totalFee + tax;

  // Payment Summary (2+ offerings): one line per billed item — each
  // offering's own fee plus each custom item under its own name;
  // single offering keeps the plain amount
  const keys = selectedKeys();
  const grandMode = keys.length >= 2;
  const primaryFee = oneTime > 0 ? oneTimeFee : yearlyFee;
  const feeEl = $("tFee");
  const customLine = (c) => {
    if (c.dataset.included === "1") return null; // "Included in our scope"
    return {
      name: c.querySelector(".i-desc")?.value.trim() || "Custom item",
      amt: parseAmt(c.querySelector(".i-amt")?.value),
      yr: c.dataset.yearly === "1",
    };
  };
  feeEl.classList.toggle("fee-combined", grandMode || (oneTime > 0 && yearly > 0));
  if (grandMode) {
    const lines = [];
    keys.forEach((k) => {
      lines.push({
        name:
          offeringHead(k)?.querySelector(".offering-title")?.innerText.trim() ||
          SHORT_TITLES[k] || CATALOGUE[k].label,
        amt: CATALOGUE[k].sections
          ? serviceTotal(k)
          : serviceCard(k)
            ? parseAmt(serviceCard(k).querySelector(".i-amt").value)
            : 0,
        yr: isYearly(k),
      });
      document
        .querySelectorAll(`.svc-card.custom-card[data-parent="${k}"]:not(.gov-card)`)
        .forEach((c) => lines.push(customLine(c)));
    });
    document
      .querySelectorAll(".svc-card.custom-card:not([data-parent]):not(.gov-card)")
      .forEach((c) => lines.push(customLine(c)));
    feeEl.innerHTML = lines
      .filter(Boolean)
      .map(
        (l) =>
          `<div class="fee-line"><span>${escapeHtml(l.name)}${l.yr ? " (Per Year)" : ""}</span><b>₹${fmt0(l.amt)}/-</b></div>`
      )
      .join("");
  } else if (oneTime > 0 && yearly > 0) {
    feeEl.innerHTML =
      `<div class="fee-line"><span>Other Services</span><b>₹${fmt0(oneTimeFee)}/-</b></div>` +
      `<div class="fee-line"><span>Package (Per Year)</span><b>₹${fmt0(yearlyFee)}/-</b></div>`;
  } else {
    feeEl.textContent = "₹" + fmt0(primaryFee) + "/-";
  }
  // government fees live in their OWN table below the fee box — the
  // fee box note says "exclusive of Government Fees", so mixing them
  // in would read as a contradiction
  const govBox = $("govBox");
  if (govBox) {
    if (gov > 0) {
      govBox.style.display = "";
      const gEl = $("tGovFee");
      const govLines = keys
        .map((k) => ({
          name:
            offeringHead(k)?.querySelector(".offering-title")?.innerText.trim() ||
            SHORT_TITLES[k] || CATALOGUE[k].label,
          amt: govTotal(k),
        }))
        .filter((l) => l.amt > 0);
      // always the same row style as the Payment Summary — name left,
      // amount right; a lone big figure looked stranded
      gEl.classList.add("fee-combined");
      const govRows = govLines.length ? govLines : [{ name: "Government Fees", amt: gov }];
      gEl.innerHTML = govRows
        .map(
          (l) =>
            `<div class="fee-line"><span>${escapeHtml(l.name)}</span><b>₹${fmt0(l.amt)}/-</b></div>`
        )
        .join("");
    } else {
      govBox.style.display = "none";
    }
  }
  $("feeGstPct").textContent = taxRate;
  $("feeDiscNote").textContent = discountRate > 0 ? ` · Includes ${discountRate}% discount` : "";
  // with several offerings the closing box is the Payment Summary —
  // lighter gold look, no amount-in-words line
  $("amountWords").textContent =
    !grandMode && primaryFee > 0 ? "Rupees " + numberToWords(Math.round(primaryFee)) + " Only" : "";
  $("amountWords").style.display = grandMode ? "none" : "";
  document.querySelector(".fee-box")?.classList.toggle("grand", grandMode);
  if ($("feeLabel"))
    $("feeLabel").textContent = grandMode
      ? "Payment Summary"
      : oneTime === 0 && yearly > 0
        ? "Professional Fee (Yearly)"
        : "Professional Fee";

  const yEl = $("feeYearly");
  if (yEl) {
    if (yearly > 0 && oneTime === 0) {
      yEl.textContent = "This package fee is payable yearly.";
      yEl.style.display = "";
    } else {
      yEl.style.display = "none";
    }
  }

  // panel preview (working numbers incl. GST)
  $("svcCount").textContent = svcCount;
  $("pSubtotal").textContent = "₹ " + fmt0(totalFee);
  $("gstPct").textContent = `(${taxRate}%)`;
  $("pGst").textContent = "₹ " + fmt(tax);
  $("pTotal").textContent = "₹ " + fmt(grand);

  rebuildOfferingFees();
  rebuildIndex();
  syncProposal();
  // no page re-pack while typing inside a card — the card would jump
  // under the cursor; the blur handlers run a full recalc afterwards
  const typing =
    document.activeElement && document.activeElement.closest && document.activeElement.closest(".svc-card");
  if (!typing) schedulePaginate();
}

/* title, kicker & callout follow the selection + client details */
function syncProposal() {
  const keys = selectedKeys();
  const labels = keys.map((k) => CATALOGUE[k].label);
  const shorts = keys.map((k) => SHORT_TITLES[k] || CATALOGUE[k].label);

  // page-1 title stays the fixed word "Proposal" (offering names show
  // in each offering's own heading); the old kicker line is retired
  $("propKicker").textContent = "";

  $("coServices").textContent = labels.length ? labels.join(", ") : "the selected services";

  // per-offering headings only make sense when several are selected —
  // with one offering the main title already names it
  // every selected offering carries its own "Annexure A · Scope of Work"
  // + name heading — so it shows whenever anything is selected, and the
  // generic page-1 kicker / title / standalone Annexure A heading hide
  const has = keys.length >= 1;
  document.querySelectorAll(".offering-head").forEach((h) => h.classList.remove("head-hidden"));
  $("annexAHead").classList.toggle("head-hidden", has);
  // page-1 keeps the "Proposal" title; the kicker line is always hidden
  document.querySelector(".prop-kicker").classList.add("head-hidden");
  $("propTitle").classList.remove("head-hidden");
}

/* ---------- Annexure B : documents required ---------- */

function selectedKeys() {
  return ORDER.filter((k) => panelCheck(k)?.checked);
}

function rebuildDocs() {
  // union of the selected services' documents, in catalogue order
  const docs = [];
  selectedKeys().forEach((k) =>
    CATALOGUE[k].docs.forEach((d) => {
      if (!docs.includes(d)) docs.push(d);
    })
  );
  extraDocs.forEach((d) => {
    if (!docs.includes(d)) docs.push(d);
  });

  const visible = docs.filter((d) => !removedDocs.has(d));

  const list = $("docsList");
  list.innerHTML = "";
  visible.forEach((d) => {
    const li = document.createElement("li");
    li.innerHTML = `${escapeHtml(d)} <button class="doc-del no-print" title="Remove">${ICON_X}</button>`;
    li.querySelector(".doc-del").addEventListener("click", () => {
      pushUndo();
      const i = extraDocs.indexOf(d);
      if (i >= 0) extraDocs.splice(i, 1);
      else removedDocs.add(d);
      rebuildDocs();
    });
    list.appendChild(li);
  });

  $("docsBlock").classList.toggle("empty", visible.length === 0);
  rebuildExclusions();
  schedulePaginate();
}

function addExtraDoc() {
  const inp = $("docAddInput");
  const d = inp.value.trim();
  if (!d) return;
  pushUndo();
  removedDocs.delete(d);
  if (!extraDocs.includes(d)) extraDocs.push(d);
  inp.value = "";
  rebuildDocs();
}

/* ---------- client -> proposal live sync ---------- */

function syncCustomer() {
  const name = $("custName").value.trim();
  const proj = $("projName").value.trim();
  const rera = $("reraNo").value.trim();
  $("metaFor").textContent = name || "Promoter Name";
  $("coPromoter").textContent = name || "Promoter Name";
  $("coProject").textContent = proj || "Project Name";
  $("coRera").textContent = rera || "Registration Number";
  // every callout phrase drops out when its field is blank
  $("coProjPhrase").style.display = proj ? "" : "none";
  $("coReraPhrase").style.display = rera ? "" : "none";
  $("coPromoterPhrase").style.display = name ? "" : "none";
  // "…project being developed by…" reads without a comma when there is
  // no project name / RERA number before it
  $("coPromSep").textContent = proj || rera ? ", " : " ";
  syncProposal();
}

/* ---------- settings -> sheet sync ---------- */

function syncMeta() {
  $("metaNo").textContent = $("quoteNo").value.trim() || "-";
  $("metaDate").textContent = prettyDate($("quoteDate").value);
  $("metaValid").textContent = prettyDate($("validTill").value);

  // terms: one per line, leading numbering stripped (list renders badges)
  const list = $("termsList");
  list.innerHTML = "";
  String($("terms").value)
    .split("\n")
    .map((l) => l.trim().replace(/^\d+[\.\)]\s*/, ""))
    .filter(Boolean)
    .forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      list.appendChild(li);
    });

  $("sheetNotes").textContent = $("notes").value.trim();
  schedulePaginate();
}

/* ---------- save / load / delete (localStorage) ---------- */

// break a record down into flat, analytics-friendly numbers + a
// readable service list, so the Google Sheet has real columns to
// pivot on (not just the raw json blob)
function quoteAnalytics(record) {
  const lines = [];
  let subtotal = 0;
  (record.services || []).forEach((s) => {
    const name = (CATALOGUE[s.key] && CATALOGUE[s.key].label) || s.head || s.key;
    const amount = s.amt || 0;
    subtotal += amount;
    lines.push({ name, amount });
  });
  let govFees = 0;
  (record.customItems || []).forEach((it) => {
    const amount = it.amt || 0;
    if (it.gov) {
      govFees += amount; // GST-free, outside the professional totals
      return;
    }
    subtotal += amount;
    lines.push({ name: it.desc || "Custom item", amount });
  });
  const discountRate = record.discountRate || 0;
  const taxRate = record.taxRate || 0;
  const discountAmt = subtotal * (discountRate / 100);
  const professionalFee = subtotal - discountAmt; // excl. GST
  const taxAmt = professionalFee * (taxRate / 100);
  const grandTotal = professionalFee + taxAmt;
  return {
    services: lines,
    serviceCount: lines.length,
    servicesText: lines.map((l) => `${l.name} (₹${fmt0(l.amount)})`).join("; "),
    subtotal,
    discountRate,
    discountAmt,
    professionalFee,
    taxRate,
    taxAmt,
    grandTotal,
    govFees,
  };
}

/* the full state of the sheet as one plain object — used for saving
   AND for undo snapshots */
function buildRecord() {
  const { services, customItems } = readItems();
  return {
    id: Date.now(),
    savedNo: loadedQuoteNo, // null → server issues a fresh, unique number
    quoteNo: $("quoteNo").value.trim(),
    date: $("quoteDate").value,
    validTill: $("validTill").value,
    status: $("quoteStatus").value,
    taxRate: parseFloat($("taxRate").value) || 0,
    discountRate: parseFloat($("discountRate").value) || 0,
    notes: $("notes").value,
    terms: $("terms").value,
    customer: {
      name: $("custName").value,
      address: $("custAddress").value,
      phone: $("custPhone").value,
      email: $("custEmail").value,
    },
    project: {
      name: $("projName").value,
      rera: $("reraNo").value,
    },
    services,
    customItems,
    other: { extension: { ...OTHER.extension }, correction: { ...OTHER.correction } },
    extraDocs: [...extraDocs],
    removedDocs: [...removedDocs],
    savedAt: new Date().toISOString(),
  };
}

/* ---------- global undo (structural changes) ---------- */

let UNDO_STACK = [];
let RESTORING = false; // suppress snapshots while state is being rebuilt

function pushUndo() {
  if (RESTORING) return;
  try {
    const rec = buildRecord();
    rec._loadedNo = loadedQuoteNo;
    delete rec.id;
    delete rec.savedAt;
    const s = JSON.stringify(rec);
    if (UNDO_STACK[UNDO_STACK.length - 1] === s) return; // no-op change
    UNDO_STACK.push(s);
    if (UNDO_STACK.length > 40) UNDO_STACK.shift();
    updateUndoBtn();
  } catch (e) {
    console.error("undo snapshot failed:", e);
  }
}

function undo() {
  const s = UNDO_STACK.pop();
  if (!s) return;
  RESTORING = true;
  try {
    const rec = JSON.parse(s);
    loadQuotation(rec);
    loadedQuoteNo = rec._loadedNo ?? null;
    $("quoteNo").value = rec.quoteNo || $("quoteNo").value;
    syncMeta();
  } finally {
    RESTORING = false;
  }
  updateUndoBtn();
}

function updateUndoBtn() {
  const b = $("btnUndo");
  if (b) b.disabled = !UNDO_STACK.length;
}

async function saveQuotation() {
  const record = buildRecord();
  record.analytics = quoteAnalytics(record);
  try {
    const saved = await Store.save(record);
    // adopt the definitive (server-issued) number
    loadedQuoteNo = saved.quoteNo;
    $("quoteNo").value = saved.quoteNo;
    syncMeta();
    await renderSavedList();
    flash($("btnSave"), ICON_CHECK + "Saved");
  } catch (e) {
    console.error("Save failed:", e);
    flash($("btnSave"), ICON_ALERT + "Save failed");
    window.alert("Could not save the quotation.\n\n" + e.message);
  }
}

function loadQuotation(q) {
  pushUndo(); // loading over the current sheet is undoable
  const wasRestoring = RESTORING;
  RESTORING = true;
  try {
    loadQuotationInner(q);
  } finally {
    RESTORING = wasRestoring;
  }
}

function loadQuotationInner(q) {
  clearSheet();

  loadedQuoteNo = q.quoteNo || null; // saving again updates this row
  $("quoteNo").value = q.quoteNo || "";
  $("quoteDate").value = q.date || "";
  $("validTill").value = q.validTill || "";
  $("quoteStatus").value = q.status || "draft";
  $("taxRate").value = q.taxRate ?? 18;
  $("discountRate").value = q.discountRate ?? 0;
  $("notes").value = q.notes || "";
  $("terms").value = q.terms ?? DEFAULT_TERMS;
  if (q.customer) {
    $("custName").value = q.customer.name || "";
    $("custAddress").value = q.customer.address || "";
    $("custPhone").value = q.customer.phone || "";
    $("custEmail").value = q.customer.email || "";
  }
  if (q.project) {
    $("projName").value = q.project.name || "";
    $("reraNo").value = q.project.rera || "";
  }

  extraDocs = [...(q.extraDocs || [])];
  removedDocs = new Set(q.removedDocs || []);

  (q.services || []).forEach((s) => {
    if (!CATALOGUE[s.key]) return; // catalogue entry removed since save
    // legacy " • "-joined inclusions convert to lines
    const sub = s.sub ? s.sub.split(" • ").join("\n") : undefined;
    selectService(s.key, s.amt, sub, s.customAmt, s.secs, s.head, s.included);
  });
  (q.customItems || []).forEach((it) => addCustomCard(it));

  const o = q.other || {};
  setOtherState("extension", !!(o.extension && o.extension.on), (o.extension && o.extension.count) || 1);
  setOtherState("correction", !!(o.correction && o.correction.on), (o.correction && o.correction.count) || 1);
  refreshOtherServices();

  rebuildDocs();
  syncCustomer();
  syncMeta();
  recalc();
  closeDrawer();
}

async function deleteQuotation(quoteNo) {
  await Store.remove(quoteNo);
  await renderSavedList();
}

async function renderSavedList() {
  const list = $("savedList");
  list.innerHTML = `<li class="saved-empty">Loading…</li>`;
  let all;
  try {
    all = await Store.list();
  } catch (e) {
    console.error("Load failed:", e);
    list.innerHTML = `<li class="saved-empty">Could not load saved quotations.</li>`;
    return;
  }
  list.innerHTML = "";
  if (!all.length) {
    list.innerHTML = `<li class="saved-empty">No saved quotations yet.</li>`;
    return;
  }
  all
    .slice()
    .reverse()
    .forEach((q) => {
      const li = document.createElement("li");
      const total =
        (q.services || []).reduce((s, it) => s + (it.amt || 0), 0) +
        (q.customItems || []).reduce((s, it) => s + (it.amt || 0), 0);
      const title = (q.customer && q.customer.name) || q.quoteNo;
      const status = q.status || "draft";
      li.innerHTML = `<strong>${escapeHtml(title)}</strong><span class="status-badge status-${status}">${status}</span> · ${prettyDate(q.date)}<br>
        <small>${escapeHtml(q.quoteNo || "")} · ${(q.services || []).length} service(s) · ₹ ${fmt0(total)}</small>
        <button class="saved-del" title="Delete this quotation">${ICON_TRASH}</button>`;
      li.addEventListener("click", () => loadQuotation(q));
      li.querySelector(".saved-del").addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.confirm(`Delete quotation ${q.quoteNo}?`)) deleteQuotation(q.quoteNo);
      });
      list.appendChild(li);
    });
}

/* ---------- new quotation ---------- */

async function nextQuoteNo() {
  // preview of the next number — server issues the final one on save
  try {
    return await Store.nextNo();
  } catch (e) {
    console.error("Could not fetch next number:", e);
    return "QT-";
  }
}

function clearSheet() {
  ORDER.forEach((k) => {
    const check = panelCheck(k);
    if (check?.checked) {
      check.checked = false;
      panelRow(k).classList.remove("on");
      const amt = panelAmtInput(k);
      amt.hidden = true;
      amt.value = "";
    }
  });
  document.querySelectorAll(".svc-card, .offering-head, .restore-bar, .offering-fee").forEach((c) => c.remove());
  REMOVED_SECS = {};
  setOtherState("extension", false, 1);
  setOtherState("correction", false, 1);
  delete $("propTitle").dataset.custom;
  extraDocs = [];
  removedDocs = new Set();
  rebuildDocs();
}

async function newQuotation() {
  pushUndo(); // starting fresh is undoable
  RESTORING = true;
  try {
    clearSheet();
  } finally {
    RESTORING = false;
  }
  loadedQuoteNo = null; // fresh quote → server assigns a new number on save
  $("quoteNo").value = await nextQuoteNo();
  $("quoteStatus").value = "draft";
  setDefaultDates();
  $("taxRate").value = RATES.gst ?? 18;
  $("discountRate").value = 0;
  $("notes").value = "";
  $("terms").value = DEFAULT_TERMS;
  ["custName", "custAddress", "custPhone", "custEmail", "projName", "reraNo"].forEach(
    (id) => ($(id).value = "")
  );
  syncCustomer();
  syncMeta();
  recalc();
}

/* ---------- drawer ---------- */

function openDrawer() {
  renderSavedList();
  $("drawerOverlay").hidden = false;
}
function closeDrawer() {
  $("drawerOverlay").hidden = true;
}

/* ---------- helpers ---------- */

function prettyDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function setDefaultDates() {
  const today = new Date();
  $("quoteDate").value = toISO(today);
  const valid = new Date(today);
  valid.setDate(valid.getDate() + 30); // quotations valid for 30 days
  $("validTill").value = toISO(valid);
}

function toISO(d) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s = "") {
  return escapeHtml(s);
}

function flash(btn, html) {
  const old = btn.innerHTML;
  btn.innerHTML = html;
  setTimeout(() => (btn.innerHTML = old), 1200);
}

/* Indian-system number to words */
function numberToWords(num) {
  if (num === 0) return "Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function two(n) {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
  }
  function three(n) {
    return (n >= 100 ? ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " : "") : "") + (n % 100 ? two(n % 100) : "");
  }

  let out = "";
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  if (crore) out += three(crore) + " Crore ";
  if (lakh) out += three(lakh) + " Lakh ";
  if (thousand) out += three(thousand) + " Thousand ";
  if (num) out += three(num);
  return out.trim();
}

/* ---------- on-screen pagination : stacked A4 pages ----------
   Content blocks are packed into 297mm sheets by measured height.
   Every page carries the letterhead top bar and the footer strip
   (both repeat in 5.pdf); blocks only move when their page
   assignment changes, so typing never loses focus. */

const PAGE_BUDGET = 990;        // usable px per page (A4 297mm ≈ 1122px)
const LETTERHEAD_ALLOWANCE = 105;
let CARD_UID = 0;               // stable identity across page moves & splits

function outerH(el) {
  const cs = getComputedStyle(el);
  const mt = cs.marginTop === "auto" ? 38 : parseFloat(cs.marginTop) || 0;
  const mb = parseFloat(cs.marginBottom) || 0;
  return el.offsetHeight + mt + mb;
}

function isFurniture(el) {
  return el.classList.contains("page-letterhead") || el.classList.contains("prop-footer");
}

function buildExtraPage() {
  const div = document.createElement("div");
  div.className = "sheet proposal extra-page";
  const lh = $("quotationSheet").querySelector(".prop-topbar").cloneNode(true);
  lh.classList.add("page-letterhead");
  const foot = $("quotationSheet").querySelector(".prop-footer").cloneNode(true);
  [lh, foot].forEach((el) =>
    el.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"))
  );
  div.appendChild(lh);
  div.appendChild(foot);
  return div;
}

let pagRaf = 0;
function schedulePaginate() {
  cancelAnimationFrame(pagRaf);
  pagRaf = requestAnimationFrame(repaginate);
}

/* split helper: keep the head + the items that fit; the rest
   continue in a headless card fragment on the next page — matches
   5.pdf, where a card's numbered items continue on page 2 with
   their numbering intact */
function trySplitCard(card, remaining) {
  const ol = card.querySelector(".card-list");
  if (!ol) return null;
  const lis = [...ol.children].filter((n) => n.tagName === "LI");
  if (lis.length < 2) return null;
  const top = card.getBoundingClientRect().top;
  let fit = 0;
  for (const li of lis) {
    if (li.getBoundingClientRect().bottom - top + 18 > remaining) break;
    fit++;
  }
  if (fit < 1 || fit >= lis.length) return null;

  const base = parseInt((ol.style.counterReset || "scope 0").split(" ")[1] || "0", 10);
  const cont = document.createElement("div");
  cont.className = "svc-card svc-cont";
  cont.dataset.contFor = card.dataset.contFor || card.dataset.uid || "";
  const nol = document.createElement("ol");
  nol.className = ol.className;      // keeps exclusions styling on splits
  if (ol.isContentEditable) nol.setAttribute("contenteditable", "true");
  nol.setAttribute("spellcheck", "false");
  nol.style.counterReset = "scope " + (base + fit);
  lis.slice(fit).forEach((li) => nol.appendChild(li));
  cont.appendChild(nol);
  card.after(cont);          // in the DOM at once, so it measures
  return cont;
}

/* re-packing detaches and re-appends every block, which blurs the
   focused element and fires focusout on the container — without the
   PAGINATING guard that focusout schedules ANOTHER repack, looping
   forever and dragging the scroll with it. The wrapper also pins the
   scroll position so an add-button click can't jump the viewport. */
let PAGINATING = false;
function repaginate() {
  PAGINATING = true;
  const sx = window.scrollX, sy = window.scrollY;
  try {
    repaginateCore();
  } finally {
    PAGINATING = false;
    window.scrollTo(sx, sy);
  }
}

function repaginateCore() {
  const container = $("pagesContainer");
  const first = $("quotationSheet");
  const focusCard =
    (document.activeElement && document.activeElement.closest && document.activeElement.closest(".svc-card")) || null;
  // typing in a card can change page assignments; moving the element
  // blurs it, so remember who had focus (and the caret) to restore
  const focusEl = document.activeElement;
  const focusSel =
    focusEl && focusEl.tagName === "INPUT" && focusEl.type === "text"
      ? [focusEl.selectionStart, focusEl.selectionEnd]
      : null;

  // merge continuations back into their cards, then re-split fresh —
  // skipped while a card is being edited, so the caret survives
  if (!focusCard) {
    container.querySelectorAll(".svc-card.svc-cont").forEach((cont) => {
      const parent = document.querySelector(`.svc-card[data-uid="${cont.dataset.contFor}"]`);
      const list = parent && parent.querySelector(".card-list");
      if (list) [...cont.querySelectorAll(".card-list > li")].forEach((li) => list.appendChild(li));
      cont.remove();
    });
  }

  // newly added cards start inside the #svcCards marker — lift them
  // out to siblings so every card measures & packs individually
  const marker = $("svcCards");
  while (marker.lastChild) marker.after(marker.lastChild);

  // flow blocks in order from every page (letterheads/footers stay
  // put; fixed cover/client pages are never repacked)
  const blocks = [];
  container.querySelectorAll(".sheet:not(.fixed-page)").forEach((sheet) => {
    [...sheet.children].forEach((el) => {
      if (sheet !== first && el.classList.contains("prop-topbar")) return;
      if (isFurniture(el)) return;
      blocks.push(el);
    });
  });

  // pack blocks into pages by measured height, splitting card lists
  const pages = [[]];
  let used = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const budget = pages.length === 1 ? PAGE_BUDGET : PAGE_BUDGET - LETTERHEAD_ALLOWANCE;
    // hidden blocks take no space — never let them force a page break
    if (getComputedStyle(b).display === "none") {
      pages[pages.length - 1].push(b);
      continue;
    }
    const h = outerH(b);
    const cur = pages[pages.length - 1];
    // every offering begins on a fresh page — its heading never
    // continues below other content
    if (b.classList.contains("offering-head") && used > 0) {
      pages.push([b]);
      used = h;
      continue;
    }
    // a block's bottom margin is invisible at the page's bottom edge —
    // let it (plus a little slack) overflow rather than waste the page
    const mb = parseFloat(getComputedStyle(b).marginBottom) || 0;
    if (h - mb <= budget - used + 16 || !cur.length) {
      cur.push(b);
      used += h;
      continue;
    }
    // screen-only widgets (add buttons, restore bars) are invisible in
    // print, so they cost NO page budget — counting them made pages
    // look full and pushed printable content to the next page
    if (
      b.classList.contains("offering-add") ||
      b.classList.contains("restore-bar") ||
      b.classList.contains("btn-add")
    ) {
      cur.push(b);
      continue;
    }
    // closing blocks (per-offering fee strips, sign-off) never sit
    // alone: squeeze if close, else carry the previous block along so
    // they open the next page together. The grand fee-box flows
    // normally — the documents annexure always follows it, so it can
    // open a page without stranding anything.
    if (
      b.classList.contains("offering-fee") ||
      b.classList.contains("prop-signoff")
    ) {
      if (h - mb <= budget - used + 60) {
        cur.push(b);
        used += h;
      } else {
        const isWidget = (el) =>
          el.classList.contains("offering-add") ||
          el.classList.contains("restore-bar") ||
          el.classList.contains("btn-add");
        // walk back over widgets AND small trailing blocks (a gov-fee
        // strip, a short card) so the whole closing group moves as one
        // — never leaving a strip separated from its cards
        let i = cur.length - 1;
        const carried = [];
        let realH = 0;
        let stoppedAtStrip = false;
        while (i > 0) {
          const el = cur[i];
          if (isWidget(el)) { carried.unshift(el); i--; continue; }
          // never carry another fee strip backward — a strip belongs
          // to the content above it
          if (el.classList.contains("offering-fee")) { stoppedAtStrip = true; break; }
          const eh = outerH(el);
          if (eh <= 350 && realH + eh <= 520) { carried.unshift(el); realH += eh; i--; continue; }
          break;
        }
        // a strip directly above means this block's own content is on
        // this page — squeeze harder rather than break the group
        if (stoppedAtStrip && h - mb <= budget - used + 130) {
          cur.push(b);
          used += h;
          continue;
        }
        const prev = i > 0 ? cur[i] : null;
        // best: split that tall card so its tail opens the next page
        // with the carried group — no void behind, nothing orphaned
        let cont = null;
        if (prev && prev.classList.contains("svc-card") && !focusCard) {
          const usedBefore =
            cur.slice(0, i + 1).reduce((s, el) => s + outerH(el), 0) - outerH(prev);
          cont = trySplitCard(prev, budget - usedBefore);
        }
        if (cont || realH > 0) {
          cur.splice(i + 1);
          const grp = [...(cont ? [cont] : []), ...carried, b];
          pages.push(grp);
          used = grp.reduce((s, el) => s + outerH(el), 0);
        } else {
          // nothing sensible to carry: squeezing beats a big void
          cur.push(b);
          used += h;
        }
      }
      continue;
    }
    // an offering's FIRST card never splits — it stays with its heading
    const offeringStart =
      b.classList.contains("svc-card") &&
      b.dataset.key &&
      (b.dataset.sec === undefined || b.dataset.sec === "0");
    // split whenever at least the card head + a row or two fit — a
    // partially filled table beats a blank stretch
    if (b.classList.contains("svc-card") && !offeringStart && !focusCard && budget - used >= 120) {
      const cont = trySplitCard(b, budget - used);
      if (cont) {
        cur.push(b);
        blocks.splice(i + 1, 0, cont);
        pages.push([]);
        used = 0;
        continue;
      }
    }
    // never leave an annexure or offering heading orphaned at a page's bottom
    const prev = cur[cur.length - 1];
    if (prev && (prev.classList.contains("prop-annex-head") || prev.classList.contains("offering-head"))) {
      cur.pop();
      pages.push([prev, b]);
      used = outerH(prev) + h;
    } else {
      pages.push([b]);
      used = h;
    }
  }

  // make sure there are enough page sheets — new ones slot in
  // before the trailing fixed pages (Our Clients / Contact Us)
  let sheets = [...container.querySelectorAll(".sheet:not(.fixed-page)")];
  const firstTail = container.querySelector(".sheet.fixed-page.tail");
  while (sheets.length < pages.length) {
    container.insertBefore(buildExtraPage(), firstTail);
    sheets = [...container.querySelectorAll(".sheet:not(.fixed-page)")];
  }

  // refresh cloned letterheads & footers from page 1 (skip if focused)
  const realTop = first.querySelector(".prop-topbar");
  const realFoot = first.querySelector(".prop-footer");
  container.querySelectorAll(".sheet.extra-page").forEach((s) => {
    [[".page-letterhead", realTop], [".prop-footer", realFoot]].forEach(([sel, src]) => {
      const dst = s.querySelector(sel);
      if (dst && src && !dst.contains(document.activeElement)) {
        dst.innerHTML = src.innerHTML;
        dst.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
      }
    });
  });

  // distribute blocks — touch the DOM only when a page's content
  // actually changed, so typing never loses focus
  pages.forEach((blks, pi) => {
    const sheet = sheets[pi];
    const foot = sheet.querySelector(".prop-footer");
    const current = [...sheet.children].filter(
      (el) => !isFurniture(el) && !(pi > 0 && el.classList.contains("prop-topbar"))
    );
    const same = blks.length === current.length && blks.every((b, i) => current[i] === b);
    if (!same) blks.forEach((b) => sheet.insertBefore(b, foot));
  });

  // drop now-empty surplus pages (never the first sheet)
  while (sheets.length > pages.length) {
    const s = sheets.pop();
    const rest = [...s.children].filter((el) => !isFurniture(el));
    if (!rest.length) s.remove();
    else break;
  }

  // restore focus + caret if the re-pack moved the focused element
  if (focusEl && focusEl.isConnected && document.activeElement !== focusEl) {
    focusEl.focus({ preventScroll: true });
    if (focusSel && focusEl.setSelectionRange) {
      try { focusEl.setSelectionRange(focusSel[0], focusSel[1]); } catch (e) {}
    }
  }

  // adaptive sign-off rule: no line when the sign-off opens a page
  // (skip invisible zero-height blocks like the empty notes marker)
  const signoff = container.querySelector(".prop-signoff");
  if (signoff) {
    let prevEl = signoff.previousElementSibling;
    while (prevEl && prevEl.offsetHeight === 0 && !prevEl.classList.contains("page-letterhead"))
      prevEl = prevEl.previousElementSibling;
    signoff.classList.toggle(
      "no-rule",
      !prevEl || prevEl.classList.contains("page-letterhead") || prevEl.classList.contains("prop-topbar")
    );
  }
}

/* ---------- Word export (.doc via Word-friendly HTML) ----------
   Reads the live sheet (including on-sheet edits) and produces a
   simple flowing document Word can open & edit. */

function liText(li) {
  const c = li.cloneNode(true);
  c.querySelectorAll("button").forEach((b) => b.remove());
  return c.textContent.trim();
}

function buildWordHtml() {
  const gold = "#e9b308", goldDark = "#b8860b", ink = "#111111", soft = "#6b7280";

  const cardsHtml = [...document.querySelectorAll(".svc-card:not(.svc-cont)")]
    .map((card) => {
      // every offering opens on a fresh page in Word too
      const startsPage =
        card.dataset.key && (card.dataset.sec === undefined || card.dataset.sec === "0");
      const brk = startsPage ? `<br clear="all" style="page-break-before:always">` : "";
      const isStart = startsPage;
      const ohead = isStart
        ? `<p style="letter-spacing:2pt;color:${ink};font-weight:bold;font-size:11pt;margin:18pt 0 0">ANNEXURE A · SCOPE OF WORK</p>` +
          `<p style="font-size:20pt;font-weight:bold;color:${ink};margin:4pt 0 0">${escapeHtml(
            (offeringHead(card.dataset.key)?.querySelector(".offering-title") || { innerText: "" }).innerText.trim() ||
              SHORT_TITLES[card.dataset.key] || CATALOGUE[card.dataset.key].label
          )}</p>`
        : "";
      const title = card.querySelector(".card-title")
        ? card.querySelector(".card-title").textContent
        : (card.querySelector(".i-desc") || {}).value || "";
      const amtInp = card.querySelector(".i-amt");
      const pillEl = card.querySelector(".card-pill-outline");
      const pill = amtInp ? "₹ " + amtInp.value + "/-" : pillEl ? pillEl.textContent.trim() : "";
      const items = cardSubLines(card)
        .map(
          (l, i) =>
            `<tr><td style="width:26pt;color:${goldDark};font-weight:bold;padding:5pt 0;vertical-align:top">${i + 1}</td>` +
            `<td style="padding:5pt 0;border-bottom:0.5pt solid #eeeeee">${escapeHtml(l)}</td></tr>`
        )
        .join("");
      return `${brk}${ohead}<table width="100%" cellspacing="0" cellpadding="0" style="margin-top:10pt">
        <tr><td style="background:${ink};color:#ffffff;font-weight:bold;padding:7pt 10pt;text-transform:uppercase;font-size:10pt">${escapeHtml(title)}</td>
        <td align="right" style="background:${ink};color:${gold};font-weight:bold;padding:7pt 10pt;font-size:10pt">${escapeHtml(pill)}</td></tr></table>
        <table width="100%" cellspacing="0" cellpadding="0">${items}</table>`;
    })
    .join("");

  const list = (sel) =>
    [...document.querySelectorAll(sel)].map((li) => `<li style="margin:4pt 0">${escapeHtml(liText(li))}</li>`).join("");
  const letter = [...document.querySelectorAll(".prop-letter p")]
    .map((p) => `<p>${escapeHtml(p.innerText)}</p>`)
    .join("");
  const head = (t) =>
    `<p style="letter-spacing:2pt;color:${ink};font-weight:bold;font-size:11pt;margin:16pt 0 6pt">${escapeHtml(t.toUpperCase())}</p>`;
  const signRight = (document.querySelector(".signoff-right") || { innerText: "" }).innerText
    .split("\n").map(escapeHtml).join("<br>");

  return (
    "﻿<html xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset='utf-8'></head>" +
    `<body style="font-family:Calibri,Arial,sans-serif;font-size:10.5pt;color:#1f2937">` +
    `<table width="100%"><tr><td style="font-size:16pt;font-weight:bold;color:${ink}">RERA<i style="color:${gold}">Easy</i></td></tr></table>` +
    `<hr style="border:0.75pt solid ${ink}">` +
    `<table width="100%"><tr><td style="font-size:22pt;font-weight:bold;color:${ink}">${escapeHtml($("propTitle").textContent)}</td>` +
    `<td align="right" style="font-size:9pt;color:${soft}">Date: <b style="color:${ink}">${escapeHtml($("metaDate").textContent)}</b><br>` +
    `Prepared for: <b style="color:${ink}">${escapeHtml($("metaFor").textContent)}</b><br>` +
    `Quotation No.: <b style="color:${ink}">${escapeHtml($("metaNo").textContent)}</b><br>` +
    `Valid till: <b style="color:${ink}">${escapeHtml($("metaValid").textContent)}</b></td></tr></table>` +
    letter +
    `<table width="100%" cellspacing="0"><tr><td style="background:#fdf6e0;border-left:3pt solid ${gold};padding:9pt 11pt">${escapeHtml(document.querySelector(".prop-callout").innerText)}</td></tr></table>` +
    (selectedKeys().length >= 1 ? "" : head("Annexure A · Scope of Work")) +
    cardsHtml +
    `<table width="100%" cellspacing="0" style="margin-top:12pt"><tr>` +
    `<td style="background:#fdf6e0;border-left:3pt solid ${gold};padding:10pt 12pt"><b style="letter-spacing:2pt;color:${goldDark}">PROFESSIONAL FEE</b><br>` +
    `<span style="font-size:8.5pt;color:#a16207">${escapeHtml(document.querySelector(".fee-note").innerText)}</span><br>` +
    `<i style="font-size:8.5pt;color:${soft}">${escapeHtml($("amountWords").textContent)}</i></td>` +
    `<td align="right" style="background:#fdf6e0;font-size:20pt;font-weight:bold;color:${ink};padding:10pt 12pt">${escapeHtml($("tFee").textContent)}</td></tr></table>` +
    ($("docsBlock").classList.contains("empty") ? "" : head("Annexure B · Documents Required") + `<ul>${list("#docsList li")}</ul>`) +
    head("Terms & Conditions") + `<ol>${list("#termsList li")}</ol>` +
    ($("exclBlock").classList.contains("empty") ? "" : head("Exclusions") + `<ol>${list("#exclList li")}</ol>`) +
    `<hr style="border:0.75pt solid ${ink}">` +
    `<table width="100%"><tr><td><span style="color:${soft}">Thanks &amp; regards,</span><br><b style="font-size:15pt;color:${ink}">${escapeHtml((document.querySelector(".signoff-name") || { innerText: "RERA Easy" }).innerText)}</b></td>` +
    `<td align="right" style="font-size:9.5pt">${signRight}</td></tr></table>` +
    "</body></html>"
  );
}

function exportWord() {
  const blob = new Blob([buildWordHtml()], { type: "application/msword" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = ($("quoteNo").value.trim() || "quotation") + ".doc";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  flash($("btnWord"), ICON_CHECK + "Exported");
}

/* ---------- wire up ---------- */

document.addEventListener("DOMContentLoaded", async () => {
  // move the Edits panel to <body> — inside the sticky sidebar it gets
  // trapped in a stacking context and paints behind the sheet
  document.body.appendChild($("editsCard"));

  // keep the sidebar's sticky offsets in step with the toolbar, which
  // can wrap to two rows on narrower windows
  const setAppbarVar = () => {
    const bar = document.querySelector(".appbar");
    if (bar) document.documentElement.style.setProperty("--appbar-h", bar.offsetHeight + "px");
  };
  setAppbarVar();
  window.addEventListener("resize", setAppbarVar);
  // fonts change block heights — re-pack once they are ready
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedulePaginate);

  RATES = loadRates();
  renderServicePicker();
  renderFeeEditor();

  nextQuoteNo().then((no) => {
    $("quoteNo").value = no;
    syncMeta();
  });

  // ?demo=1 preselects a spread of services — used for automated
  // print/PDF testing only
  if (new URLSearchParams(location.search).has("demo")) {
    selectService("project_registration");
    selectService("package_a");
    selectService("correction", 30000);
  }
  $("taxRate").value = RATES.gst ?? 18;
  $("terms").value = DEFAULT_TERMS;
  setDefaultDates();
  syncCustomer();
  syncMeta();
  rebuildDocs();
  recalc();

  ["quoteNo", "quoteDate", "validTill", "notes", "terms"].forEach((id) =>
    $(id).addEventListener("input", syncMeta)
  );
  $("discountRate").addEventListener("input", recalc);
  $("taxRate").addEventListener("input", () => {
    RATES.gst = parseFloat($("taxRate").value) || 0;
    saveRates();
    recalc();
  });

  // client details -> live proposal sync
  ["custName", "custAddress", "custPhone", "custEmail", "projName", "reraNo"].forEach((id) =>
    $(id).addEventListener("input", syncCustomer)
  );

  // editing the big title by hand stops the auto-title
  $("propTitle").addEventListener("input", () => {
    $("propTitle").dataset.custom = "1";
  });

  // Lock: view-only preview; unlock: editable preview.
  // The preview starts locked, unlock to fine-tune on the sheet.
  document.body.classList.add("locked");
  $("btnLock").innerHTML = ICON_LOCK + "Locked";
  $("btnLock").addEventListener("click", () => {
    const locked = document.body.classList.toggle("locked");
    $("btnLock").innerHTML = locked ? ICON_LOCK + "Locked" : ICON_UNLOCK + "Unlocked";
  });

  // ✎ Edits (top bar) toggles the floating fixed panel
  $("btnEdits").addEventListener("click", () => {
    $("editsCard").hidden = !$("editsCard").hidden;
  });
  $("btnCloseEdits").addEventListener("click", () => {
    $("editsCard").hidden = true;
  });

  // Annexure B controls
  $("btnAddDoc").addEventListener("click", addExtraDoc);
  $("docAddInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addExtraDoc();
  });

  $("btnAddRow").addEventListener("click", () => addCustomCard());
  $("btnUndo").addEventListener("click", undo);
  $("btnSave").addEventListener("click", saveQuotation);

  // login gate + team management (remote mode only)
  updateAuthUi();
  if (Store.remote() && !AUTH) showLogin();
  startSessionWatch();
  $("btnLogin")?.addEventListener("click", doLogin);
  $("loginPass")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  $("loginUser")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("loginPass").focus();
  });
  $("btnLogout")?.addEventListener("click", doLogout);
  $("btnUsers")?.addEventListener("click", openUsers);
  const closeUsers = () => ($("usersOverlay").style.display = "none");
  $("btnCloseUsers")?.addEventListener("click", closeUsers);
  $("btnUsersBack")?.addEventListener("click", closeUsers);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeUsers();
      $("passOverlay").style.display = "none";
    }
  });
  $("btnPass")?.addEventListener("click", openPass);
  $("btnPassBack")?.addEventListener("click", () => ($("passOverlay").style.display = "none"));
  $("btnPassSave")?.addEventListener("click", doChangePassword);
  $("cpNew2")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doChangePassword();
  });
  $("btnCreateUser")?.addEventListener("click", createUser);
  $("btnNew").addEventListener("click", newQuotation);
  $("btnHistory").addEventListener("click", openDrawer);
  $("btnCloseDrawer").addEventListener("click", closeDrawer);
  $("drawerOverlay").addEventListener("click", (e) => {
    if (e.target === $("drawerOverlay")) closeDrawer();
  });

  // PDF export = browser print dialog -> "Save as PDF"
  $("btnPdf").addEventListener("click", () => window.print());
  $("btnPrint").addEventListener("click", () => window.print());
  $("btnWord").addEventListener("click", exportWord);

  // pagination reacts to loads (fonts), resizes and blur (splits &
  // merges are deferred while a card is being edited)
  window.addEventListener("load", schedulePaginate);
  window.addEventListener("resize", schedulePaginate);
  window.addEventListener("beforeprint", repaginate);
  $("pagesContainer").addEventListener("focusout", () => {
    if (!PAGINATING) schedulePaginate();
  });
  // backspacing away every point leaves an empty editable list that
  // can't be clicked into — put a blank first point back and keep the
  // caret inside it
  $("pagesContainer").addEventListener("input", (e) => {
    const list = e.target.closest && e.target.closest('.card-list[contenteditable="true"]');
    if (!list || list.querySelector("li")) return;
    list.innerHTML = "<li><br></li>";
    const r = document.createRange();
    r.selectNodeContents(list.querySelector("li"));
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  schedulePaginate();
});
