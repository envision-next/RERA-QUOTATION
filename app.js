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

/* inline SVG icons (Lucide-style) reused by generated markup */
const SVG = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICON_X = SVG + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_TRASH = SVG + '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_CHECK = SVG + '<polyline points="20 6 9 17 4 12"/></svg>';
const ICON_ALERT = SVG + '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const ICON_LOCK = SVG + '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const ICON_UNLOCK = SVG + '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

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

  async list() {
    if (!this.remote()) return this._local();
    const res = await fetch(SHEET_API_URL + "?action=list", { redirect: "follow" });
    const data = await res.json();
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
    const res = await fetch(SHEET_API_URL, {
      method: "POST",
      // text/plain keeps it a "simple" request → no CORS preflight
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      redirect: "follow",
      body: JSON.stringify({ action: "save", record }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.record;
  },

  async remove(quoteNo) {
    if (!this.remote()) {
      this._localWrite(this._local().filter((q) => q.quoteNo !== quoteNo));
      return;
    }
    await fetch(SHEET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      redirect: "follow",
      body: JSON.stringify({ action: "delete", quoteNo }),
    });
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
      "Drafting of a detailed consent letter: Creating a comprehensive consent letter outlining the details of the extension process to the allottees, adhering to regulatory specifications.",
      "Scrutiny Assistance: Providing support and guidance during the scrutiny process to ensure compliance and smooth execution of all regulatory obligations.",
    ],
    docs: [
      "Index II or Date of Registration of Sold Units.",
      "Project Extension Date.",
      "51% consents of the allottees for extension.",
      "Form 1 (Architect's Certificate), Form 2 (Engineer's Certificate) & Form 3 (CA's Certificate) for all the pending quarters.",
      "Form 2A (Quality Assurance Certificate by Engineer) & Form 5 (Annual Audit Report of Statutory CA) for all the pending FY.",
      "Reason for the delay in the project.",
      "Case Details of the project.",
      "RERA Carpet Area Statement.",
    ],
    amount: 80000,
  },
  correction: {
    label: "Project Correction / Change of Details",
    subs: [
      "Correction Application: Drafting the correction application with supporting justification.",
      "Portal Updation: Updating the project details on the MahaRERA portal.",
      "Follow-up: Liaison with the authority till approval of the correction.",
    ],
    docs: [
      "Details of the proposed changes.",
      "Supporting certificates for the change.",
      "Board resolution / consent letter.",
    ],
    amount: 30000,
  },
  profile_migration: {
    label: "Profile Migration",
    subs: [
      "Profile Mapping: Mapping of the existing promoter profile and registered projects.",
      "Migration Filing: Migration filing on the new MahaRERA system.",
      "Verification: Verification of the migrated data for completeness.",
    ],
    docs: [
      "Existing MahaRERA login credentials.",
      "Promoter KYC documents.",
      "List of registered projects.",
    ],
    amount: 25000,
  },
  project_closure: {
    label: "Project Closure",
    subs: [
      "Closure Application: Drafting and filing the project closure application.",
      "Occupancy Certificate: Uploading the OC and completion documents.",
      "Final Reconciliation: Final QPR reconciliation & Form 4 filing.",
    ],
    docs: [
      "Occupancy Certificate.",
      "Form 4 (Architect's Certificate).",
      "Final CA certificate.",
      "Sold / unsold inventory statement.",
    ],
    amount: 60000,
  },
  removal_of_abeyance: {
    label: "Removal of Abeyance",
    subs: [
      "Reply Drafting: Drafting the reply to the abeyance notice.",
      "Compliance Submission: Submission of all pending compliances.",
      "Follow-up: Continuous follow-up till the abeyance is lifted.",
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
    label: "MahaRERA Profile Updation",
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
      "extension", "correction", "profile_migration",
      "project_closure", "removal_of_abeyance", "pending_compliances",
      "maharera_profile_updation", "change_of_promoter", "withdrawal_of_old_correction",
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
  profile_migration: "Profile Migration",
  project_closure: "Project Closure",
  removal_of_abeyance: "Removal of Abeyance",
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
      `;
      host.appendChild(row);

      const check = row.querySelector(".svc-check");
      const amt = row.querySelector(".svc-amt");

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
function selectService(key, amount, subText, customAmt, secs, headText) {
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
    amt.value = fmt0(amount);
    addServiceCard(key, amount, subText ?? CATALOGUE[key].subs.join("\n"), customAmt);
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
  const check = panelCheck(key);
  const amt = panelAmtInput(key);
  check.checked = false;
  panelRow(key).classList.remove("on");
  amt.hidden = true;
  offeringHead(key)?.remove();
  // a sectioned offering owns several cards — remove them all
  document.querySelectorAll(`.svc-card[data-key="${key}"]`).forEach((card) => {
    document
      .querySelectorAll(`.svc-cont[data-cont-for="${card.dataset.uid}"]`)
      .forEach((c) => c.remove());
    card.remove();
  });
  rebuildDocs();
  recalc();
}

/* remove a SINGLE section of a multi-section offering; only when the
   last remaining section goes do we deselect the whole offering */
function removeSectionCard(card, key) {
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

function addServiceCard(key, amount, subText, customAmt) {
  if (serviceCard(key)) return serviceCard(key);
  const card = document.createElement("div");
  card.className = "svc-card";
  card.dataset.key = key;
  card.dataset.uid = String(++CARD_UID);
  if (customAmt) card.dataset.customAmt = "1";
  card.innerHTML = `
    <div class="card-head">
      <div class="card-title" contenteditable="true" spellcheck="false">${escapeHtml(CATALOGUE[key].label)}</div>
      <div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(amount)}"><span>/-</span></div>
      <button class="row-del no-print" title="Remove service">${ICON_X}</button>
    </div>
    <ol class="card-list" contenteditable="true" spellcheck="false" title="Scope items (click to edit)">${scopeListHtml(subText)}</ol>
  `;
  card.querySelector(".row-del").addEventListener("click", () => deselectService(key));

  // sheet amount -> panel amount (marks the amount as custom)
  const amt = card.querySelector(".i-amt");
  amt.addEventListener("input", () => {
    card.dataset.customAmt = "1";
    const panelAmt = panelAmtInput(key);
    if (panelAmt) panelAmt.value = amt.value;
    recalc();
  });
  amt.addEventListener("focus", () => (amt.value = parseAmt(amt.value) || ""));
  amt.addEventListener("blur", () => (amt.value = fmt0(parseAmt(amt.value))));

  // service cards keep catalogue order; custom cards always sit below
  const myIdx = ORDER.indexOf(key);
  let anchor = null;
  for (const el of allCards()) {
    const k = el.dataset.key;
    if (!k) { anchor = el; break; }            // first custom card
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

/* sectioned offerings (registration & retainer packages) render one
   card per section — priced sections get a fee pill, the rest read
   "INCLUDED IN OUR SCOPE" like the 5.pdf design */
function addSectionCards(key, secs) {
  if (serviceCard(key)) return;
  let prev = null;
  CATALOGUE[key].sections.forEach((sec, i) => {
    const saved = secs && secs[i];
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
    ? `<div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(amount || 0)}"><span>/-</span></div>`
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
  amt.addEventListener("focus", () => (amt.value = parseAmt(amt.value) || ""));
  amt.addEventListener("blur", () => (amt.value = fmt0(parseAmt(amt.value))));
}

function addSectionCard(key, secIdx, title, priced, amount, sub, hidePrice, afterEl) {
  const card = document.createElement("div");
  card.className = "svc-card";
  card.dataset.key = key;
  card.dataset.sec = String(secIdx);
  card.dataset.uid = String(++CARD_UID);
  card.innerHTML = `
    <div class="card-head">
      <div class="card-title" contenteditable="true" spellcheck="false">${escapeHtml(title)}</div>
      ${sectionPillHtml(priced, amount, hidePrice)}
      <button class="row-del no-print" title="Remove this section">${ICON_X}</button>
    </div>
    <ol class="card-list" contenteditable="true" spellcheck="false" title="Scope items (click to edit)">${scopeListHtml(sub)}</ol>
  `;
  card.querySelector(".row-del").addEventListener("click", () => removeSectionCard(card, key));
  bindSectionAmt(card, key);

  if (afterEl) afterEl.after(card);
  else {
    const myIdx = ORDER.indexOf(key);
    let anchor = null;
    for (const el of allCards()) {
      const k = el.dataset.key;
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

/* index: numbered list of the selected offerings with their fees */
function offeringAmount(key) {
  if (CATALOGUE[key].sections) return serviceTotal(key);
  const card = serviceCard(key);
  return card ? parseAmt(card.querySelector(".i-amt").value) : 0;
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
  document.querySelectorAll(".svc-card.custom-card").forEach((c) => {
    const desc = c.querySelector(".i-desc")?.value.trim();
    const amt = parseAmt(c.querySelector(".i-amt")?.value);
    if (desc || amt) lines.push({ name: desc || "Custom item", amt, yearly: false });
  });

  tbl.innerHTML = lines
    .map(
      (l, i) =>
        `<tr><td class="ix-no">${String(i + 1).padStart(2, "0")}</td><td>${escapeHtml(l.name)}</td><td class="ix-amt">₹ ${fmt0(l.amt)}*</td></tr>`
    )
    .join("");

  // no totals here — the grand total prints at the end of the document
  // in the Professional Fee box, with the yearly payable under it
  $("indexBlock").classList.toggle("empty", lines.length < 1);
}

/* per-offering fee strip — when more than one thing is billed, each
   offering's charge prints at the end of its own section, before the
   next offering begins (same style as the Professional Fee box) */
function rebuildOfferingFees() {
  document.querySelectorAll(".offering-fee").forEach((el) => el.remove());
  const keys = selectedKeys();
  const customCount = document.querySelectorAll(".svc-card.custom-card").length;
  if (keys.length + customCount < 2) return;
  const gst = parseFloat($("taxRate").value) || 0;
  keys.forEach((key) => {
    const cards = [...document.querySelectorAll(`.svc-card:not(.svc-cont)[data-key="${key}"]`)];
    if (!cards.length) return;
    const uids = new Set(cards.map((c) => c.dataset.uid));
    let last = cards[cards.length - 1];
    while (
      last.nextElementSibling &&
      last.nextElementSibling.classList.contains("svc-cont") &&
      uids.has(last.nextElementSibling.dataset.contFor)
    )
      last = last.nextElementSibling;
    const div = document.createElement("div");
    div.className = "offering-fee";
    const perYear = isYearly(key) ? `<div class="of-per">Payable Per Year</div>` : "";
    div.innerHTML = `
      <div class="of-left">
        <div class="of-label">Professional Fee</div>
        <div class="of-note">Exclusive of ${gst}% GST</div>
      </div>
      <div class="of-right">
        <div class="of-amt">₹${fmt0(offeringAmount(key))}/-</div>
        ${perYear}
      </div>`;
    last.after(div);
  });
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

/* free-form custom card (e.g. liaison visits, drafting extras) */
function addCustomCard(item = {}) {
  const it = { desc: "", sub: "", amt: 0, ...item };
  const card = document.createElement("div");
  card.className = "svc-card custom-card";
  card.dataset.uid = String(++CARD_UID);
  card.innerHTML = `
    <div class="card-head">
      <input type="text" class="i-desc" placeholder="ITEM / SERVICE NAME" value="${escapeAttr(it.desc)}">
      <div class="card-pill">₹<input type="text" class="i-amt" inputmode="decimal" value="${fmt0(it.amt)}"><span>/-</span></div>
      <button class="row-del no-print" title="Remove item">${ICON_X}</button>
    </div>
    <ol class="card-list" contenteditable="true" spellcheck="false" title="Details (click to edit)">${scopeListHtml(it.sub) || "<li><br></li>"}</ol>
  `;
  card.querySelector(".row-del").addEventListener("click", () => {
    document
      .querySelectorAll(`.svc-cont[data-cont-for="${card.dataset.uid}"]`)
      .forEach((c) => c.remove());
    card.remove();
    recalc();
  });
  card.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", recalc));

  const amt = card.querySelector(".i-amt");
  amt.addEventListener("focus", () => (amt.value = parseAmt(amt.value) || ""));
  amt.addEventListener("blur", () => (amt.value = fmt0(parseAmt(amt.value))));

  // custom cards go after every existing card, wherever pagination put it
  const all = [...document.querySelectorAll(".svc-card")];
  if (all.length) all[all.length - 1].after(card);
  else $("svcCards").appendChild(card);
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
          head: offeringHead(key)?.querySelector(".offering-title")?.innerText.trim(),
        });
      }
    } else {
      customItems.push({
        desc: card.querySelector(".i-desc").value,
        sub: cardSubLines(card).join("\n"),
        amt: parseAmt(card.querySelector(".i-amt").value),
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
    const inp = card.querySelector(".i-amt");   // "included" cards carry no pill
    if (!inp) return;
    const v = parseAmt(inp.value);
    if (isYearly(card.dataset.key)) yearly += v;
    else oneTime += v;
  });
  const svcCount = selectedKeys().length;

  const discountRate = parseFloat($("discountRate").value) || 0;
  const taxRate = parseFloat($("taxRate").value) || 0;
  const afterDisc = (a) => a - a * (discountRate / 100);

  const oneTimeFee = afterDisc(oneTime);      // Grand Total (one-time, excl. GST)
  const yearlyFee = afterDisc(yearly);        // Yearly Payable (excl. GST)
  const totalFee = oneTimeFee + yearlyFee;
  const tax = totalFee * (taxRate / 100);
  const grand = totalFee + tax;

  // grand total: one-time total + package total marked "per Year",
  // shown together in the fee box
  const primaryFee = oneTime > 0 ? oneTimeFee : yearlyFee;
  const feeEl = $("tFee");
  feeEl.classList.toggle("fee-combined", oneTime > 0 && yearly > 0);
  if (oneTime > 0 && yearly > 0) {
    feeEl.innerHTML =
      `<div class="fee-line"><span>Other Services</span><b>₹${fmt0(oneTimeFee)}/-</b></div>` +
      `<div class="fee-line"><span>Package (Per Year)</span><b>₹${fmt0(yearlyFee)}/-</b></div>`;
  } else {
    feeEl.textContent = "₹" + fmt0(primaryFee) + "/-";
  }
  $("feeGstPct").textContent = taxRate;
  $("feeDiscNote").textContent = discountRate > 0 ? ` · Includes ${discountRate}% discount` : "";
  $("amountWords").textContent =
    primaryFee > 0 ? "Rupees " + numberToWords(Math.round(primaryFee)) + " Only" : "-";
  if ($("feeLabel"))
    $("feeLabel").textContent = oneTime === 0 && yearly > 0 ? "Professional Fee (Yearly)" : "Professional Fee";

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
  schedulePaginate();
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
  // drop the "bearing Project Registration Number …" phrase when blank
  $("coReraPhrase").style.display = rera ? "" : "none";
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
  (record.customItems || []).forEach((it) => {
    const amount = it.amt || 0;
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
  };
}

async function saveQuotation() {
  const { services, customItems } = readItems();
  const record = {
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
    selectService(s.key, s.amt, sub, s.customAmt, s.secs, s.head);
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
  document.querySelectorAll(".svc-card, .offering-head").forEach((c) => c.remove());
  setOtherState("extension", false, 1);
  setOtherState("correction", false, 1);
  delete $("propTitle").dataset.custom;
  extraDocs = [];
  removedDocs = new Set();
  rebuildDocs();
}

async function newQuotation() {
  clearSheet();
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
const LETTERHEAD_ALLOWANCE = 130;
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

function repaginate() {
  const container = $("pagesContainer");
  const first = $("quotationSheet");
  const focusCard =
    (document.activeElement && document.activeElement.closest && document.activeElement.closest(".svc-card")) || null;

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
    // short closing blocks (fee strips, the grand-total box, the
    // sign-off) never sit alone on a fresh page — squeeze them onto
    // the current page with a bigger overflow allowance instead
    if (
      (b.classList.contains("offering-fee") ||
        b.classList.contains("fee-box") ||
        b.classList.contains("prop-signoff")) &&
      h - mb <= budget - used + 140
    ) {
      cur.push(b);
      used += h;
      continue;
    }
    // an offering's FIRST card never splits — it stays with its heading
    const offeringStart =
      b.classList.contains("svc-card") &&
      b.dataset.key &&
      (b.dataset.sec === undefined || b.dataset.sec === "0");
    if (b.classList.contains("svc-card") && !offeringStart && !focusCard && budget - used >= 240) {
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

  RATES = loadRates();
  renderServicePicker();
  renderFeeEditor();

  nextQuoteNo().then((no) => {
    $("quoteNo").value = no;
    syncMeta();
  });
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
  $("btnSave").addEventListener("click", saveQuotation);
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
  $("pagesContainer").addEventListener("focusout", schedulePaginate);
  schedulePaginate();
});
