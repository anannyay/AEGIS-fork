/* AEGIS-Care dashboard.
 * Vanilla JS, no external dependencies: the whole prototype must run offline.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (v, d = 3) => (typeof v === "number" ? v.toFixed(d) : (v ?? "—"));

const STATE = {
  role: null,
  patients: [],
  selectedPatient: null,
  patientPanel: "summary",
  patientListFilter: "attention",
  patientFlash: null,
  commandIncident: null,
  commandRecovery: null,
  system: null,
  evidence: null,
  incidents: [],
  selected: null,
  lastRecovery: null,
  quickIncident: null,
  quickRecovery: null,
  quickStartedAt: null,
};

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch (e) { /* ignore */ }
    throw new Error(detail);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/* ---------------- toasts ----------------
 * Inline notices stay authoritative for results; toasts carry the transient
 * "it worked / it failed" signal so a failure inside a collapsed view is not
 * silent.
 */
function toast(title, { detail = "", kind = "", timeout = 5200 } = {}) {
  const stack = $("toast-stack");
  if (!stack) return;
  const node = el("div", `toast ${kind}`);
  const body = el("div", "toast-body");
  body.appendChild(el("div", "toast-title", esc(title)));
  if (detail) body.appendChild(el("div", "toast-detail", esc(detail)));
  node.appendChild(body);
  const close = el("button", "toast-close", "&times;");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss notification");
  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add("leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  };
  close.addEventListener("click", dismiss);
  node.appendChild(close);
  stack.appendChild(node);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  if (timeout) window.setTimeout(dismiss, timeout);
}

/* ---------------- theme ---------------- */
const THEME_KEY = "aegis-theme";
function readStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}
function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage blocked */ }
  const btn = $("theme-toggle");
  if (btn) {
    const next = theme === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to ${next} theme`);
    btn.setAttribute("title", `Switch to ${next} theme`);
  }
  // The memory graph paints its own SVG colours, so it has to be redrawn.
  if ($("view-graph")?.classList.contains("active")) drawGraph();
}
function initTheme() {
  applyTheme(readStoredTheme() === "light" || readStoredTheme() === "dark"
    ? readStoredTheme() : currentTheme());
  $("theme-toggle")?.addEventListener("click", () =>
    applyTheme(currentTheme() === "dark" ? "light" : "dark"));
  // Follow the OS only while the user has not made an explicit choice.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!readStoredTheme()) applyTheme(e.matches ? "dark" : "light");
  });
}


/* ================= ROLES =================
 * A role is not a skin. Each role has a different question, so each gets a
 * different set of views, a different landing view, and its own vocabulary for
 * the same underlying numbers. The service enforces the real policy; this layer
 * decides what is worth showing and what to call it.
 */
const ROLES = {
  clinician: {
    label: "Nurse / Clinician",
    short: "Clinician",
    initials: "NC",
    question: "Can I trust what the assistant told me about this patient?",
    blurb: "See which of your patients have records that were corrected, withdrawn, or are waiting on a review.",
    duties: ["Check a patient's records", "See exactly what changed", "Know what to re-verify"],
    views: ["records"],
    home: "records",
    context: "Patient record assurance",
    note: "You are seeing clinical content for patients in your care only.",
    accent: "good",
  },
  safety: {
    label: "Clinical Safety Officer",
    short: "Safety",
    initials: "SO",
    question: "What is the blast radius, and is it contained?",
    blurb: "Run the containment loop end to end: find affected records, prove which were really affected, rebuild them, and keep the bad version out.",
    duties: ["Contain a reported error", "Track the blast radius", "Sign off safe resume"],
    views: ["command", "graph"],
    home: "command",
    context: "Incident containment",
    note: "You coordinate recovery and never receive clinical content.",
    accent: "accent",
  },
  compliance: {
    label: "Compliance & Review Officer",
    short: "Compliance",
    initials: "CR",
    question: "Did anything leave a runtime that shouldn't have, and what needs a human?",
    blurb: "Audit every field that crossed a boundary, run the leakage tests, and clear the queue of records the system refused to guess at.",
    duties: ["Audit the data boundary", "Decide quarantined records", "Review the audit trail"],
    views: ["assurance"],
    home: "assurance",
    context: "Assurance & review",
    note: "You see metadata and audit evidence, plus records escalated for review.",
    accent: "warn",
  },
  researcher: {
    label: "Researcher / Evaluator",
    short: "Researcher",
    initials: "RE",
    question: "Does the mechanism hold across conditions?",
    blurb: "The full experimental console: paired baselines, the provenance matrix, privacy attacks, and the hash-bound evidence package.",
    duties: ["Run the paired matrix", "Compare all nine conditions", "Verify the evidence package"],
    views: ["overview", "incident", "care", "graph", "baselines", "privacy",
            "evidence", "review", "experiment", "audit"],
    home: "overview",
    context: "Clinical memory incident recovery",
    note: "Full research console.",
    accent: "muted",
  },
};

const VIEW_LABELS = {
  records: "My Patients", command: "Incident Command", assurance: "Assurance",
  overview: "Mission", incident: "Incident Lab", care: "CARE Recovery",
  graph: "Memory Graph", baselines: "Baselines", privacy: "Privacy Audit",
  evidence: "Evidence Center", review: "Review Queue",
  experiment: "Experiments", audit: "Audit Log",
};

/* The same measurement, named for the person reading it. */
const VOCAB = {
  clinician: {
    rwh: "Patients still affected", descendant_recall: "Affected records found",
    descendant_precision: "Correctly identified", bsr: "Untouched records preserved",
    rts: "Follow-up answered correctly", uer: "Shared beyond permission",
    drr: "Withdrawn entries that returned", quarantined: "Held for a person to review",
    repaired: "Corrected", superseded: "Withdrawn", tombstoned: "Withdrawn",
    active: "In use", suspected: "Being checked",
  },
  safety: {
    rwh: "Residual harm", descendant_recall: "Coverage of affected records",
    descendant_precision: "Precision", bsr: "Clean state retained",
    rts: "Follow-up task success", uer: "Data shared beyond permission",
    drr: "Withdrawn entries that returned", quarantined: "Held for review",
    repaired: "Rebuilt", superseded: "Withdrawn", tombstoned: "Withdrawn",
    active: "In use", suspected: "Under investigation",
  },
  compliance: {
    rwh: "Residual harm", descendant_recall: "Coverage",
    descendant_precision: "Precision", bsr: "Clean state retained",
    rts: "Task success", uer: "Unauthorised exposure",
    drr: "Resurrection rate", quarantined: "Escalated to review",
    repaired: "Rebuilt", superseded: "Withdrawn", tombstoned: "Tombstoned",
    active: "Active", suspected: "Suspected",
  },
  researcher: {
    rwh: "Residual wrong-patient / unauthorized harm (RWH)",
    descendant_recall: "Descendant recall",
    descendant_precision: "Descendant precision",
    bsr: "Benign-state retention (BSR)", rts: "Repaired task success (RTS)",
    uer: "Unauthorized exposure rate (UER)", drr: "Deletion resurrection rate (DRR)",
    quarantined: "quarantined", repaired: "repaired", superseded: "superseded",
    tombstoned: "tombstoned", active: "active", suspected: "suspected",
  },
};

const ROLE_KEY = "aegis-role-session-v2";
function storedRole() {
  try { const r = sessionStorage.getItem(ROLE_KEY); return ROLES[r] ? r : null; }
  catch (e) { return null; }
}
function currentRole() { return STATE.role || "researcher"; }
function role() { return ROLES[currentRole()]; }

/* Translate a metric key into the active role's wording. */
function t(key, fallback) {
  return (VOCAB[currentRole()] || {})[key] || fallback || key;
}

/* ---------------- navigation ---------------- */
const TABS = () => Array.from(document.querySelectorAll("nav.tabs button[data-view]"));

function activateView(name, { scroll = true, focusTab = false } = {}) {
  const view = $(`view-${name}`);
  if (!view) return;
  TABS().forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
    // Roving tabindex: one stop for the tablist, arrows move between tabs.
    b.tabIndex = active ? 0 : -1;
    if (active && focusTab) b.focus();
  });
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  view.classList.add("active");
  if (history.replaceState) history.replaceState(null, "", `#${name}`);
  if (name === "graph") drawGraph();
  if (name === "audit") loadAudit();
  if (name === "review") loadReview();
  if (name === "records") loadPatients();
  if (name === "command") initCommandView();
  if (name === "assurance") initAssuranceView();
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

function buildTabs() {
  const nav = $("tabs");
  nav.innerHTML = "";
  role().views.forEach((name) => {
    const btn = el("button", null, esc(VIEW_LABELS[name] || name));
    btn.type = "button";
    btn.dataset.view = name;
    btn.setAttribute("role", "tab");
    btn.id = `tab-${name}`;
    btn.setAttribute("aria-controls", `view-${name}`);
    nav.appendChild(btn);
  });
  // A single-view role has nothing to navigate between.
  nav.hidden = role().views.length < 2;

  TABS().forEach((btn) => {
    const view = $(`view-${btn.dataset.view}`);
    if (view) {
      view.setAttribute("role", "tabpanel");
      view.setAttribute("aria-labelledby", `tab-${btn.dataset.view}`);
      view.tabIndex = 0;
    }
  });
}

function initTabs() {
  $("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (btn) activateView(btn.dataset.view);
  });

  $("tabs").addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
    if (!(e.key in keys)) return;
    const tabs = TABS();
    if (!tabs.length) return;
    const at = tabs.findIndex((b) => b.getAttribute("aria-selected") === "true");
    let next;
    if (keys[e.key] === "first") next = 0;
    else if (keys[e.key] === "last") next = tabs.length - 1;
    else next = (at + keys[e.key] + tabs.length) % tabs.length;
    e.preventDefault();
    activateView(tabs[next].dataset.view, { scroll: false, focusTab: true });
  });

  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-view-target]");
    if (target && role().views.includes(target.dataset.viewTarget)) {
      activateView(target.dataset.viewTarget);
    }
  });

  const fromHash = () => {
    const name = location.hash.replace("#", "");
    if (name && $(`view-${name}`) && role().views.includes(name)) {
      activateView(name, { scroll: false });
    }
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();
}

/* ---------------- role gate & switcher ---------------- */
let pendingRole = null;

function renderRoleGate() {
  const grid = $("role-gate-grid");
  grid.innerHTML = "";

  const choose = (id) => {
    pendingRole = id;
    const selected = ROLES[id];
    grid.querySelectorAll(".role-card").forEach((node) => {
      const active = node.dataset.role === id;
      node.setAttribute("aria-checked", active ? "true" : "false");
      node.tabIndex = active ? 0 : -1;
    });
    $("gate-confirm-copy").innerHTML =
      `<h2>${esc(selected.label)}</h2>
       <p>${esc(selected.blurb)}</p>
       <ul>${selected.duties.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
    const go = $("gate-continue");
    go.disabled = false;
    go.textContent = `Continue as ${selected.short}`;
  };

  Object.entries(ROLES).forEach(([id, r]) => {
    const card = el("button", `role-card accent-${r.accent}`);
    card.type = "button";
    card.dataset.role = id;
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", "false");
    card.tabIndex = id === "clinician" ? 0 : -1;
    card.innerHTML =
      `<span class="role-card-avatar" aria-hidden="true">${esc(r.initials)}</span>
       ${id === "clinician" ? '<span class="role-card-recommended">Care team workspace</span>' : ""}
       <span class="role-card-label">${esc(r.label)}</span>
       <span class="role-card-question">${esc(r.question)}</span>
       <span class="role-card-blurb">${esc(r.blurb)}</span>
       <span class="role-card-duties">${r.duties.map((d) =>
         `<i>${esc(d)}</i>`).join("")}</span>
       <span class="role-card-go">Select this workspace <b aria-hidden="true">→</b></span>`;
    card.addEventListener("click", () => choose(id));
    grid.appendChild(card);
  });

  grid.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const cards = Array.from(grid.querySelectorAll(".role-card"));
    const at = Math.max(0, cards.indexOf(document.activeElement));
    let next = at;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = cards.length - 1;
    else next = (at + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : -1) + cards.length) % cards.length;
    e.preventDefault();
    choose(cards[next].dataset.role);
    cards[next].focus();
  });

  $("gate-continue").addEventListener("click", () => {
    if (pendingRole) selectRole(pendingRole, { firstRun: true });
  });
}

function resetRoleGate() {
  pendingRole = null;
  $("role-gate-grid").querySelectorAll(".role-card").forEach((card, index) => {
    card.setAttribute("aria-checked", "false");
    card.tabIndex = index === 0 ? 0 : -1;
  });
  $("gate-confirm-copy").innerHTML =
    "<h2>Select a role to continue</h2><p>We will explain what you can see and what actions you can take.</p>";
  $("gate-continue").disabled = true;
  $("gate-continue").textContent = "Continue to workspace";
}

function renderRoleMenu() {
  const menu = $("role-menu");
  const current = role();
  menu.innerHTML =
    `<div class="role-menu-session">
       <span>Current protected workspace</span>
       <strong>${esc(current.label)}</strong>
       <div class="role-menu-lock">Role locked for this session</div>
     </div>
     <button class="role-menu-item role-menu-end" id="end-session-button" type="button" role="menuitem">
       <span class="role-menu-avatar" aria-hidden="true">↩</span>
       <span><strong>End session</strong><small>Return to login before choosing another role</small></span>
     </button>`;
  $("end-session-button").addEventListener("click", () => {
    closeRoleMenu();
    $("session-dialog-copy").textContent =
      `You are leaving the ${current.label} workspace. You will return to role login; patient and incident data will not be reset.`;
    $("session-dialog").showModal();
  });
}

function openRoleMenu() {
  renderRoleMenu();
  $("role-menu").hidden = false;
  $("role-switch").setAttribute("aria-expanded", "true");
}
function closeRoleMenu() {
  $("role-menu").hidden = true;
  $("role-switch").setAttribute("aria-expanded", "false");
}

function selectRole(id, { firstRun = false } = {}) {
  if (!ROLES[id]) return;
  if (STATE.role && STATE.role !== id && $("role-gate").hidden) {
    toast("Workspace is role-locked", {
      detail: "End the current session before choosing another role.", kind: "bad",
    });
    return;
  }
  STATE.role = id;
  try { sessionStorage.setItem(ROLE_KEY, id); } catch (e) { /* storage blocked */ }
  document.documentElement.dataset.role = id;

  const r = ROLES[id];
  $("role-switch-name").textContent = r.short;
  $("role-switch-avatar").textContent = r.initials;
  $("header-context").textContent = r.context;
  $("safety-role-note").textContent = r.note;
  $("role-gate").hidden = true;

  buildTabs();
  activateView(r.home, { scroll: false });
  renderRoleSurface();
  if (document.getElementById("chat-suggestions")) renderSuggestions();
  if (document.getElementById("operator-context-title")) updateOperatorContext();
  if (document.getElementById("operator-case-list")) loadOperatorCases();
  if ($("assistant-title")) {
    $("assistant-title").textContent = id === "clinician" ? "AEGIS Guide" : "AEGIS Operator";
    $("chat-toggle-label").textContent = id === "clinician" ? "Ask AEGIS" : "Operator";
  }
  if (CHAT.initialized) {
    renderAssistantWelcome();
    primeChat();
  }
  if (firstRun) {
    startTour(id);
  }
}

function endRoleSession() {
  const previous = role().label;
  if (CHAT.initialized) toggleChat(false);
  endTour();
  closeRoleMenu();
  try {
    sessionStorage.removeItem(ROLE_KEY);
    sessionStorage.removeItem("aegis-operator-session");
  } catch (e) { /* storage blocked */ }
  CHAT.sessionId = assistantSessionId();
  CHAT.history = [];
  CHAT.lastResult = null;
  STATE.role = null;
  delete document.documentElement.dataset.role;
  $("tabs").innerHTML = "";
  $("tabs").hidden = true;
  resetRoleGate();
  $("role-gate").hidden = false;
  window.setTimeout(() => $("role-gate-grid").querySelector(".role-card")?.focus(), 80);
  $("urgent-announcer").textContent = `${previous} session ended. Choose a role to begin a new protected session.`;
}

function initRoles() {
  renderRoleGate();
  $("role-switch").addEventListener("click", (e) => {
    e.stopPropagation();
    $("role-menu").hidden ? openRoleMenu() : closeRoleMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#role-menu") && !e.target.closest("#role-switch")) closeRoleMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRoleMenu(); });
  $("confirm-end-session").addEventListener("click", endRoleSession);

  const saved = storedRole();
  if (saved) {
    selectRole(saved);
  } else {
    $("role-gate").hidden = false;
    STATE.role = "researcher";       // a safe default until a choice is made
  }
}

/* Load whatever the active role's landing view needs. */
function renderRoleSurface() {
  const id = currentRole();
  if (id === "clinician") loadPatients();
  if (id === "safety") initCommandView();
  if (id === "compliance") initAssuranceView();
}

/* ---------------- accessible display preferences & persistent help ---------------- */
const DISPLAY_KEY = "aegis-display";

function readDisplayPreferences() {
  try { return JSON.parse(localStorage.getItem(DISPLAY_KEY) || "{}"); }
  catch (e) { return {}; }
}

function applyDisplayPreferences(next) {
  document.documentElement.dataset.textSize = next.textSize === "large" ? "large" : "normal";
  document.documentElement.dataset.contrast = next.contrast === "high" ? "high" : "normal";
  document.documentElement.dataset.motion = next.motion === "reduce" ? "reduce" : "normal";
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(next)); } catch (e) { /* storage blocked */ }
  $("pref-large-text").checked = next.textSize === "large";
  $("pref-high-contrast").checked = next.contrast === "high";
  $("pref-reduce-motion").checked = next.motion === "reduce";
}

function openAccessibility() {
  const dialog = $("accessibility-dialog");
  applyDisplayPreferences(readDisplayPreferences());
  if (!dialog.open) dialog.showModal();
}

function initAccessibility() {
  applyDisplayPreferences(readDisplayPreferences());
  $("accessibility-button").addEventListener("click", openAccessibility);
  $("gate-accessibility").addEventListener("click", openAccessibility);
  [["pref-large-text", "textSize", "large"],
   ["pref-high-contrast", "contrast", "high"],
   ["pref-reduce-motion", "motion", "reduce"]].forEach(([control, key, enabled]) => {
    $(control).addEventListener("change", (e) => {
      const prefs = readDisplayPreferences();
      prefs[key] = e.target.checked ? enabled : "normal";
      applyDisplayPreferences(prefs);
      $("urgent-announcer").textContent = `${e.target.closest("label").querySelector("strong").textContent} ${e.target.checked ? "on" : "off"}`;
    });
  });
  $("preferences-reset").addEventListener("click", () => {
    applyDisplayPreferences({ textSize: "normal", contrast: "normal", motion: "normal" });
    $("urgent-announcer").textContent = "Display settings reset";
  });
}

function initPersistentHelp() {
  $("help-button").addEventListener("click", () => {
    if (!$("role-gate").hidden) {
      $("role-gate-grid").querySelector(".role-card")?.focus();
      $("urgent-announcer").textContent = "Choose your role, then confirm your workspace.";
      return;
    }
    startTour(currentRole(), { force: true });
  });
  $("records-guide").addEventListener("click", () => startTour("clinician", { force: true }));
}

/* ---------------- table helper ---------------- */
function table(rows, columns, opts = {}) {
  if (!rows || !rows.length) return el("p", "muted small", "No data.");
  const wrap = el("div", "table-wrap");
  const t = el("table");
  const thead = el("thead");
  const tr = el("tr");
  columns.forEach((c) => tr.appendChild(el("th", null, esc(c.label ?? c.key))));
  thead.appendChild(tr);
  t.appendChild(thead);
  const tbody = el("tbody");
  rows.forEach((row) => {
    const r = el("tr");
    if (opts.highlight && opts.highlight(row)) r.classList.add("highlight");
    columns.forEach((c) => {
      const td = el("td", c.num ? "num" : (c.wrap ? "wrap" : null));
      td.innerHTML = c.render ? c.render(row) : esc(row[c.key] ?? "");
      r.appendChild(td);
    });
    tbody.appendChild(r);
  });
  t.appendChild(tbody);
  wrap.appendChild(t);
  return wrap;
}

function bar(value, kind = "") {
  const pct = Math.max(0, Math.min(1, Number(value) || 0)) * 100;
  return `<span class="bar ${kind}"><span style="width:${pct}%"></span></span>
          <span class="mono"> ${fmt(value)}</span>`;
}

function stateBadge(s) { return `<span class="badge ${esc(s)}">${esc(s)}</span>`; }

/* ---------------- boot ---------------- */
async function boot() {
  initTheme();
  initTabs();
  initTour();
  initAccessibility();
  initPersistentHelp();
  const health = await api("/api/health");
  $("version").textContent = `v${health.version} · ${health.model}`;
  STATE.system = await api("/api/system");
  STATE.evidence = await api("/api/evidence");
  renderOverview();
  renderEvidence();
  populateSelectors();
  initQuickLab();
  initMotion();
  initGraphViewport();
  await refreshIncidents();
  // Roles come last: the surface a role lands on needs system data to exist.
  initRoles();
  initChat();
}

function renderOverview() {
  const s = STATE.system;
  const evidence = STATE.evidence || {};
  const verified = evidence.status === "verified";
  const care = evidence.evaluation?.full_care || {};
  $("hero-verified-state").textContent = verified ? "VERIFIED" : "PENDING";
  $("hero-run-count").textContent = evidence.evaluation?.condition_runs ?? "—";
  $("hero-rwh").textContent = fmt(care.rwh ?? null);

  const stats = $("overview-stats");
  stats.innerHTML = "";
  const resourceCount = Object.values(evidence.data_source?.resources_loaded || {})
    .reduce((sum, value) => sum + Number(value || 0), 0);
  const fallbackResources = Object.values(s.stats.fhir || {})
    .reduce((sum, value) => sum + Number(value || 0), 0);
  const memoryCount = s.stats.memory
    ? Object.values(s.stats.memory).reduce((sum, role) => sum + (role.total || 0), 0)
    : 0;
  const cards = [
    [resourceCount || fallbackResources, "FHIR resources exercised",
      "external-format synthetic validation"],
    [evidence.evaluation?.condition_runs ?? "—", "Paired recovery runs",
      "same frozen trajectory per condition"],
    [s.tasks.length, "Benchmark tasks",
      "identity · laboratory · documentation"],
    [memoryCount, "Versioned memories",
      "role-separated and purpose-scoped"],
  ];
  cards.forEach(([value, label, desc]) => {
    const c = el("div", "metric");
    c.appendChild(el("div", "value", esc(value)));
    c.appendChild(el("div", "label", esc(label)));
    c.appendChild(el("div", "desc", esc(desc)));
    stats.appendChild(c);
  });

  $("roles-table").innerHTML = "";
  $("roles-table").appendChild(table(
    Object.entries(s.roles).map(([role, v]) => ({
      role, fields: v.fields.join(", ") || "none (no clinical read rights)",
      total: (v.memory && v.memory.total) || 0,
    })),
    [
      { key: "role", label: "Role", render: (r) => `<span class="badge role">${esc(r.role)}</span>` },
      { key: "fields", label: "Authorized fields", wrap: true },
      { key: "total", label: "Memories", num: true },
    ]));

  $("families-table").innerHTML = "";
  $("families-table").appendChild(table(
    Object.entries(s.families).map(([id, f]) => ({ id, ...f })),
    [
      { key: "id", label: "ID" },
      { key: "name", label: "Family" },
      { key: "propagation", label: "Propagation", wrap: true },
      { key: "failure", label: "Observable failure", wrap: true },
    ]));
}

function renderEvidence() {
  const e = STATE.evidence || {};
  const verified = e.status === "verified";
  $("external-tier-state").textContent = verified ? "VERIFIED" : "NOT RUN";
  const checked = e.integrity?.artifacts_checked ?? 0;
  const failures = e.integrity?.failures?.length ?? 0;
  $("evidence-seal").innerHTML = verified
    ? `<div class="seal is-valid">
         <div class="seal-ring" aria-hidden="true">
           <svg viewBox="0 0 24 24"><path d="M4 12.6l5.2 5.2L20 7"/></svg>
         </div>
         <div class="seal-copy">
           <strong>Hash-bound package</strong>
           <span>SHA-256 verified · ${esc(checked)} artifacts re-hashed</span>
         </div>
       </div>`
    : `<div class="seal is-broken">
         <div class="seal-ring" aria-hidden="true">
           <svg viewBox="0 0 24 24"><path d="M12 6.5v7M12 17.4v.2"/></svg>
         </div>
         <div class="seal-copy">
           <strong>${failures ? "Integrity check failed" : "Evidence run pending"}</strong>
           <span>${failures
             ? `${esc(failures)} of ${esc(checked)} artifacts do not match their digest`
             : "No external validation package found in this runtime"}</span>
         </div>
       </div>`;
  const out = $("evidence-results");
  out.innerHTML = "";
  if (!verified) {
    out.innerHTML = `<div class="notice warn">External validation has not been verified in this runtime.</div>`;
    return;
  }
  const source = e.data_source || {};
  const run = e.evaluation || {};
  const care = run.full_care || {};
  out.appendChild(table([{
    patients: source.patients_loaded,
    resources: Object.values(source.resources_loaded || {}).reduce((a, b) => a + b, 0),
    incidents: run.incidents,
    runs: run.condition_runs,
  }], [
    { key: "patients", label: "Synthea patients", num: true },
    { key: "resources", label: "FHIR resources", num: true },
    { key: "incidents", label: "Incidents", num: true },
    { key: "runs", label: "Condition runs", num: true },
  ]));
  const metrics = el("div", "grid four");
  [["Residual harm", care.rwh, "good"], ["Recall", care.descendant_recall, "good"],
   ["Precision", care.descendant_precision, "good"], ["State retained", care.bsr, "good"]]
    .forEach(([label, value, kind]) => {
      const card = el("div", `stat ${kind}`);
      card.innerHTML = `<div class="label">${esc(label)}</div><div class="value">${fmt(value)}</div>`;
      metrics.appendChild(card);
    });
  out.appendChild(el("div", "spacer"));
  out.appendChild(metrics);
  out.appendChild(el("div", "notice good",
    `Integrity PASS · ${esc(e.integrity?.artifacts_checked ?? 0)} artifacts re-hashed · ` +
    `${esc(run.verification_failures?.length ?? 0)} verification failures reported`));
  out.appendChild(el("div", "notice warn",
    "Boundary: fully synthetic external-format validation. No clinical effectiveness or patient benefit is claimed."));
}

function populateSelectors() {
  const s = STATE.system;
  const fam = $("in-family");
  const quickFam = $("quick-family");
  fam.innerHTML = "";
  quickFam.innerHTML = "";
  Object.entries(s.families).forEach(([id, f]) => {
    fam.appendChild(new Option(`${id} — ${f.name}`, id));
    quickFam.appendChild(new Option(`${id} — ${f.name}`, id));
  });
  const task = $("in-task");
  task.innerHTML = "";
  s.tasks.forEach((t) => task.appendChild(
    new Option(`${t.task_id} · ${t.label} (${t.patient_id})`, t.task_id)));
  const prov = $("in-prov");
  prov.innerHTML = "";
  s.provenance_conditions.forEach((p) => prov.appendChild(new Option(p, p)));
  prov.value = "targeted";
  const quickProv = $("quick-provenance");
  quickProv.innerHTML = "";
  s.provenance_conditions.forEach((p) => quickProv.appendChild(new Option(p, p)));
  quickProv.value = "targeted";

  const exFam = $("ex-families");
  exFam.innerHTML = "";
  Object.keys(s.families).forEach((id) => {
    const o = new Option(id, id); o.selected = true; exFam.appendChild(o);
  });
  const exProv = $("ex-prov");
  exProv.innerHTML = "";
  s.provenance_conditions.forEach((p) => {
    const o = new Option(p, p);
    o.selected = ["complete", "random40", "targeted"].includes(p);
    exProv.appendChild(o);
  });
}

/* ---------------- live trajectory lab ---------------- */
function recommendedTask(family, memoryNodes = []) {
  const taskFamily = { F1: "identity", F2: "labs", F3: "docs", F4: "docs" }[family];
  const compatible = STATE.system.tasks.filter((task) => task.family === taskFamily);
  const unused = compatible.find((task) =>
    !memoryNodes.some((node) => String(node.key || "").includes(task.task_id)));
  return unused || compatible[compatible.length - 1] || STATE.system.tasks[0];
}

function constrainQuickDepth() {
  const seedDepth = Number(STATE.system.families[$("quick-family").value]?.seed_depth || 0);
  const minimum = seedDepth + 1;
  Array.from($("quick-depth").options).forEach((option) => {
    option.disabled = Number(option.value) < minimum;
  });
  if (Number($("quick-depth").value) < minimum) $("quick-depth").value = String(minimum);
}

function timecode(offset = 0) {
  const elapsed = Math.max(0, (performance.now() - (STATE.quickStartedAt || performance.now())) + offset);
  const seconds = Math.floor(elapsed / 1000);
  const millis = Math.floor(elapsed % 1000);
  return `${String(seconds).padStart(2, "0")}:${String(millis).padStart(3, "0")}`;
}

function renderTrajectoryStage(incident, recovery = null) {
  const canvas = $("trajectory-canvas");
  const feed = $("trajectory-feed");
  const nodes = incident.trajectory || [];
  if (!nodes.length) {
    canvas.innerHTML = '<div class="trajectory-empty">No derivation nodes were returned.</div>';
    return;
  }

  const width = 900;
  const roleY = { registration: 82, nursing: 198, clinical_summary: 314 };
  const fallbackY = 198;
  const startX = 135;
  const endX = 820;
  const step = nodes.length > 1 ? (endX - startX) / (nodes.length - 1) : 0;
  const positions = nodes.map((node, index) => ({
    ...node,
    x: startX + step * index,
    y: roleY[node.role] || fallbackY,
  }));
  const repairedKeys = new Set((recovery?.repaired || []).map((item) => item.memory_key));
  const confirmedKeys = new Set(recovery?.confirmed || []);

  const lanes = Object.entries(roleY).map(([role, y]) =>
    `<line class="trajectory-lane" x1="98" y1="${y}" x2="855" y2="${y}"/>` +
    `<text class="trajectory-lane-label" x="18" y="${y + 4}">${esc(role.replace("clinical_summary", "summary"))}</text>`
  ).join("");

  const edges = positions.slice(1).map((node, index) => {
    const source = positions[index];
    const affected = source.contaminated && node.contaminated;
    const repaired = recovery && (repairedKeys.has(node.key) || confirmedKeys.has(node.key));
    const cls = repaired ? "repaired" : (affected ? "contaminated" : "");
    const mid = (source.x + node.x) / 2;
    return `<path class="trajectory-edge ${cls}" pathLength="1" style="--delay:${(index * .16 + .18).toFixed(2)}s" ` +
      `marker-end="url(#trajectory-arrow)" d="M ${source.x} ${source.y} C ${mid} ${source.y}, ${mid} ${node.y}, ${node.x} ${node.y}"/>`;
  }).join("");

  const nodeMarkup = positions.map((node, index) => {
    const repaired = recovery && (repairedKeys.has(node.key) || confirmedKeys.has(node.key));
    const classes = ["trajectory-node"];
    if (node.contaminated) classes.push("is-contaminated");
    if (node.key === incident.seed_key) classes.push("is-seed");
    if (repaired) classes.push("is-repaired");
    const type = String(node.type || "memory").replaceAll("_", " ");
    const shortType = type.length > 18 ? `${type.slice(0, 16)}…` : type;
    return `<g class="${classes.join(" ")}" style="--delay:${(index * .16 + .32).toFixed(2)}s" transform="translate(${node.x} ${node.y})">` +
      `<circle class="node-pulse" r="14"/><circle class="node-ring" r="15"/><circle class="node-core" r="4"/>` +
      `<text y="31">${esc(shortType)}</text>` +
      `<text class="node-sub" y="45">D${node.depth}${node.key === incident.seed_key ? " · SEED" : ""}</text>` +
      `<title>${esc(node.key)} · ${esc(node.state)} · patient token ${esc(node.patient || "—")}</title></g>`;
  }).join("");

  canvas.innerHTML = `<svg viewBox="0 0 ${width} 395" role="img" aria-label="${esc(incident.family_info?.name || incident.family)} dependency trajectory">` +
    `<defs><marker id="trajectory-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>` +
    lanes + edges + nodeMarkup + "</svg>";

  const masked = incident.provenance?.edges_removed ?? 0;
  const totalEdges = incident.provenance?.edges_before ?? Math.max(nodes.length - 1, 0);
  const entries = [
    ["00:000", `${incident.family} seed committed inside ${nodes[0].role} runtime`],
    ["00:184", `${nodes.length - 1} causal descendant${nodes.length === 2 ? "" : "s"} propagated across authorised roles`],
    ["00:426", `${masked}/${totalEdges} visible provenance edges removed (${incident.provenance?.condition || "unknown"})`],
    ["00:702", `${incident.true_contaminated?.length || 0} descendants retained as private scoring truth`],
  ];
  if (recovery) {
    entries.push(["01:145", `${recovery.candidates?.length || 0} candidates nominated; ${recovery.confirmed?.length || 0} causally confirmed`]);
    entries.push(["01:498", `${recovery.repaired?.length || 0} rebuilt · ${recovery.quarantined?.length || 0} quarantined · safe resume ${recovery.certificate?.safe_resume ? "approved" : "blocked"}`]);
  }
  feed.innerHTML = entries.map(([time, message]) =>
    `<div><time>${time}</time><span>${esc(message)}</span></div>`).join("");
  feed.scrollTop = feed.scrollHeight;
}

function initQuickLab() {
  constrainQuickDepth();
  $("quick-family").addEventListener("change", constrainQuickDepth);
  $("trajectory-canvas").innerHTML = '<div class="trajectory-empty">Select an incident family, then inject a synthetic failure to reveal its dependency field.</div>';

  $("btn-quick-inject").addEventListener("click", async () => {
    const btn = $("btn-quick-inject");
    btn.disabled = true;
    $("btn-quick-recover").disabled = true;
    STATE.quickStartedAt = performance.now();
    STATE.quickRecovery = null;
    $("quick-summary").innerHTML = '<span class="summary-dot"></span>Injecting synthetic memory seed and propagating dependencies…';
    $("trajectory-canvas").innerHTML = '<div class="trajectory-empty"><span class="spinner"></span>Building role-separated trajectory…</div>';
    try {
      const family = $("quick-family").value;
      const memoryGraph = await api("/api/memory/none/graph");
      const task = recommendedTask(family, memoryGraph.nodes || []);
      const created = await api("/api/incidents", {
        method: "POST",
        body: JSON.stringify({
          family,
          task_id: task.task_id,
          depth: Number($("quick-depth").value),
          provenance: $("quick-provenance").value,
          n_controls: 1,
        }),
      });
      const detail = await api(`/api/incidents/${encodeURIComponent(created.incident_id)}`);
      STATE.quickIncident = detail;
      renderTrajectoryStage(detail);
      $("quick-summary").innerHTML = `<span class="summary-dot"></span><b>${esc(detail.family_info?.name || detail.family)}</b> injected. ` +
        `${detail.true_contaminated.length} descendants are contaminated; ${detail.provenance?.edges_removed || 0} visible edges are now missing.`;
      $("btn-quick-recover").disabled = false;
      toast("Trajectory injected", {
        detail: `${detail.incident_id} · ${detail.true_contaminated.length} contaminated descendants.`,
      });
      await refreshIncidents();
      ["care-incident", "bl-incident", "pv-incident"].forEach((id) => { $(id).value = created.incident_id; });
    } catch (error) {
      $("quick-summary").innerHTML = `<span class="summary-dot"></span><b>Injection failed:</b> ${esc(error.message)}`;
      $("trajectory-canvas").innerHTML = `<div class="trajectory-empty">${esc(error.message)}</div>`;
      toast("Injection failed", { detail: error.message, kind: "bad" });
    } finally {
      btn.disabled = false;
    }
  });

  $("btn-quick-recover").addEventListener("click", async () => {
    if (!STATE.quickIncident) return;
    const btn = $("btn-quick-recover");
    btn.disabled = true;
    $("quick-summary").innerHTML = '<span class="summary-dot"></span>Running candidate discovery, local attribution, recompilation, and enforcement…';
    try {
      const recovery = await api("/api/recover", {
        method: "POST",
        body: JSON.stringify({ incident_id: STATE.quickIncident.incident_id }),
      });
      STATE.quickRecovery = recovery;
      STATE.lastRecovery = recovery;
      renderTrajectoryStage(STATE.quickIncident, recovery);
      const metrics = recovery.metrics || {};
      $("quick-summary").innerHTML = `<span class="summary-dot"></span><b>${recovery.certificate?.safe_resume ? "Safe resume approved." : "Review required."}</b> ` +
        `${recovery.repaired.length} affected artifacts rebuilt; residual harm ${fmt(metrics.rwh)}; benign state retained ${fmt(metrics.bsr)}.`;
      toast(recovery.certificate?.safe_resume ? "Safe resume approved" : "Review required", {
        detail: `${recovery.repaired.length} rebuilt · RWH ${fmt(metrics.rwh)} · BSR ${fmt(metrics.bsr)}.`,
        kind: recovery.certificate?.safe_resume ? "good" : "warn",
      });
      await refreshIncidents();
    } catch (error) {
      $("quick-summary").innerHTML = `<span class="summary-dot"></span><b>Recovery failed:</b> ${esc(error.message)}`;
      toast("Recovery failed", { detail: error.message, kind: "bad" });
    } finally {
      btn.disabled = false;
    }
  });

  $("btn-hero-inject").addEventListener("click", () => {
    $("trajectory-theater").scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => $("btn-quick-inject").click(), 450);
  });

  window.setInterval(() => {
    if (!STATE.quickStartedAt) return;
    $("trajectory-clock").textContent = timecode();
  }, 47);
}

function initMotion() {
  const targets = document.querySelectorAll(".proof-bars");
  if (!("IntersectionObserver" in window)) {
    targets.forEach((target) => target.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: .28 });
  targets.forEach((target) => observer.observe(target));
}

/* ---------------- incidents ---------------- */
async function refreshIncidents() {
  const data = await api("/api/incidents");
  STATE.incidents = data.incidents;
  ["care-incident", "bl-incident", "pv-incident", "as-incident"].forEach((id) => {
    const sel = $(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = "";
    STATE.incidents.forEach((i) => sel.appendChild(
      new Option(`${i.incident_id} (${i.family}, d${i.depth}, ${i.provenance?.condition ?? "?"})`,
        i.incident_id)));
    if (prev) sel.value = prev;
  });

  $("incident-list").innerHTML = "";
  $("incident-list").appendChild(table(STATE.incidents, [
    { key: "incident_id", label: "Incident" },
    { key: "family", label: "Family" },
    { key: "depth", label: "Depth", num: true },
    { key: "prov", label: "Provenance", render: (r) => esc(r.provenance?.condition ?? "—") },
    {
      key: "loss", label: "Edges masked", num: true,
      render: (r) => r.provenance
        ? `${r.provenance.edges_removed}/${r.provenance.edges_before}` : "—",
    },
    {
      key: "true_contaminated", label: "Contaminated", num: true,
      render: (r) => r.true_contaminated.length,
    },
    {
      key: "recovered", label: "Recovered",
      render: (r) => r.recovered ? '<span class="badge repaired">yes</span>'
        : '<span class="badge suspected">no</span>',
    },
  ]));
  STATE.system = await api("/api/system");
  renderOverview();
  if (currentRole() === "clinician") loadPatients();
  // Incident and recovery actions can start from either the dashboard or the
  // Operator. Keep the shared case inbox coherent no matter which surface was
  // used, instead of only refreshing it after a chat response.
  if (currentRole()) await loadOperatorCases();
}

$("btn-create").addEventListener("click", async () => {
  const btn = $("btn-create");
  btn.disabled = true;
  const out = $("incident-result");
  out.innerHTML = '<div class="notice info"><span class="spinner"></span>Building incident…</div>';
  try {
    const body = {
      family: $("in-family").value,
      task_id: $("in-task").value,
      depth: Number($("in-depth").value),
      provenance: $("in-prov").value,
      n_controls: Number($("in-controls").value),
    };
    const inc = await api("/api/incidents", { method: "POST", body: JSON.stringify(body) });
    const detail = await api(`/api/incidents/${encodeURIComponent(inc.incident_id)}`);
    renderIncident(detail, out);
    await refreshIncidents();
    $("care-incident").value = inc.incident_id;
    $("bl-incident").value = inc.incident_id;
    $("pv-incident").value = inc.incident_id;
    toast("Incident created", { detail: inc.incident_id });
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    toast("Incident creation failed", { detail: e.message, kind: "bad" });
  } finally { btn.disabled = false; }
});

$("btn-reset").addEventListener("click", async () => {
  const btn = $("btn-reset");
  btn.disabled = true;
  try {
    await api("/api/system/reset", { method: "POST" });
    $("incident-result").innerHTML = '<div class="notice info">System reset.</div>';
    STATE.quickIncident = null;
    STATE.quickRecovery = null;
    STATE.lastRecovery = null;
    $("btn-quick-recover").disabled = true;
    await refreshIncidents();
    resetOperatorConversation("Workspace reset. Previous answers no longer describe the live sandbox.");
    if (currentRole() === "clinician") await loadPatients(null);
    toast("System reset", { detail: "Environment rebuilt; all incidents cleared." });
  } catch (e) {
    toast("Reset failed", { detail: e.message, kind: "bad" });
  } finally { btn.disabled = false; }
});

function renderChain(nodes, seedKey) {
  const chain = el("div", "chain");
  nodes.forEach((n, i) => {
    if (i) chain.appendChild(el("div", "chain-arrow", "→"));
    const cls = ["chain-node"];
    if (n.contaminated) cls.push("contaminated");
    if (n.state === "repaired") cls.push("repaired");
    if (n.key === seedKey) cls.push("seed");
    const node = el("div", cls.join(" "));
    node.style.setProperty("--delay", `${i * .08}s`);
    node.innerHTML =
      `<div class="depth">depth ${n.depth}${n.key === seedKey ? " · SEED" : ""}</div>
       <div class="type">${esc(n.type)}</div>
       <div class="role">${esc(n.role)}</div>
       <div class="pt">patient ${esc(n.patient ?? "—")}</div>
       <div>${stateBadge(n.state)}</div>`;
    chain.appendChild(node);
  });
  return chain;
}

function renderIncident(inc, out) {
  out.innerHTML = "";
  const info = inc.family_info || {};
  out.appendChild(el("div", "notice info",
    `<b>${esc(inc.incident_id)}</b> — ${esc(info.name ?? inc.family)}.
     Seed: <span class="mono">${esc(info.seed ?? "")}</span><br>
     Propagation: ${esc(info.propagation ?? "")}<br>
     Observable failure: ${esc(info.failure ?? "")}`));

  const p = inc.provenance;
  if (p) {
    out.appendChild(el("div", "notice warn",
      `Provenance condition <b>${esc(p.condition)}</b> — ${esc(p.description)}
       Removed <b>${p.edges_removed}</b> of ${p.edges_before} observable edges
       (${(p.loss_fraction * 100).toFixed(0)}% loss).`));
  }

  out.appendChild(el("h3", null, "Contaminated trajectory"));
  out.appendChild(renderChain(inc.trajectory, inc.seed_key));

  const wrong = inc.wrong_patient
    ? `Intended patient <span class="mono">${esc(inc.intended_patient)}</span>,
       seed points at <span class="mono">${esc(inc.wrong_patient)}</span>.`
    : `Intended patient <span class="mono">${esc(inc.intended_patient)}</span>.`;
  out.appendChild(el("p", "small muted", wrong +
    ` Ground truth marks <b>${inc.true_contaminated.length}</b> contaminated descendant(s).`));

  if (inc.controls && inc.controls.length) {
    out.appendChild(el("h3", null, "Matched clean control (hard negative)"));
    inc.controls.forEach((c) => {
      out.appendChild(renderChain(
        c.nodes.map((n, i) => ({ ...n, depth: i, role: "—", contaminated: false })), null));
    });
    out.appendChild(el("p", "small muted",
      "Surface-similar but causally independent. Recovery must leave these intact — " +
      "that is what separates causal inheritance from semantic similarity."));
  }
}

/* ---------------- CARE ---------------- */
$("btn-recover").addEventListener("click", async () => {
  const incident_id = $("care-incident").value;
  if (!incident_id) return;
  const btn = $("btn-recover");
  btn.disabled = true;
  const out = $("care-result");
  out.innerHTML = '<div class="notice info"><span class="spinner"></span>Running CARE loop…</div>';
  try {
    const body = {
      incident_id,
      use_sketch: $("opt-sketch").checked,
      use_explicit_lineage: $("opt-lineage").checked,
      use_counterfactual: $("opt-counterfactual").checked,
      use_recompilation: $("opt-recompile").checked,
      use_enforcement: $("opt-enforce").checked,
      use_scoping: $("opt-scope").checked,
    };
    const r = await api("/api/recover", { method: "POST", body: JSON.stringify(body) });
    STATE.lastRecovery = r;
    renderRecovery(r, out);
    toast(r.certificate?.safe_resume ? "Safe resume approved" : "Safe resume blocked", {
      detail: `Closure in ${r.rounds} round(s) · ${r.repaired.length} rebuilt · ${r.quarantined.length} quarantined.`,
      kind: r.certificate?.safe_resume ? "good" : "warn",
    });
    await refreshIncidents();
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    toast("Recovery failed", { detail: e.message, kind: "bad" });
  } finally { btn.disabled = false; }
});

document.querySelectorAll("#care-toggles input").forEach((cb) => {
  cb.addEventListener("change", () => {
    cb.closest(".toggle").classList.toggle("off", !cb.checked);
  });
});

function renderRecovery(r, out) {
  out.innerHTML = "";
  const m = r.metrics || {};
  const cert = r.certificate || {};

  const banner = cert.safe_resume
    ? el("div", "notice good",
      `<b>SAFE RESUME APPROVED</b> — closure reached in ${r.rounds} round(s), ` +
      `${r.repaired.length} artifact(s) rebuilt from trusted FHIR sources, ` +
      `${r.resurrection_probe.blocked}/${r.resurrection_probe.attempts} resurrection probes blocked.`)
    : el("div", "notice warn",
      `<b>SAFE RESUME BLOCKED</b> — review required. ` +
      `${(cert.unresolved_risk || []).length} unresolved risk item(s).`);
  out.appendChild(banner);

  // CARE stages
  const stages = el("div", "stages");
  const stageData = [
    ["C", "Candidate discovery", r.candidates.length, "candidates ranked"],
    ["A", "Attribution", `${r.confirmed.length} / ${r.cleared.length}`, "confirmed / cleared by replay"],
    ["R", "Recompilation", `${r.repaired.length} / ${r.quarantined.length}`, "repaired / quarantined"],
    ["E", "Enforcement", r.enforcement.tombstones, "tombstones committed"],
  ];
  stageData.forEach(([letter, name, metric, desc]) => {
    const s = el("div", "stage");
    s.innerHTML = `<div class="letter">${letter}</div><div class="name">${esc(name)}</div>
                   <div class="metric">${esc(metric)}</div><div class="desc">${esc(desc)}</div>`;
    stages.appendChild(s);
  });
  out.appendChild(stages);

  // metrics
  out.appendChild(el("h3", null, "Outcome metrics"));
  const metricRows = [
    ["Residual wrong-patient / unauthorized harm (RWH)", m.rwh, "bad", true],
    ["Descendant recall", m.descendant_recall, "good", false],
    ["Descendant precision", m.descendant_precision, "good", false],
    ["Benign-state retention (BSR)", m.bsr, "good", false],
    ["Repaired task success (RTS)", m.rts, "good", false],
    ["False repair rate", m.false_repair_rate, "bad", true],
    ["Unauthorized exposure rate (UER)", m.uer, "bad", true],
    ["Deletion resurrection rate (DRR)", m.drr, "bad", true],
  ].map(([label, value, kind, lower]) => ({ label, value, kind, lower }));
  out.appendChild(table(metricRows, [
    { key: "label", label: "Metric", wrap: true },
    { key: "value", label: "Value", num: true,
      render: (r2) => bar(r2.value, r2.kind === "bad"
        ? (r2.value > 0 ? "bad" : "good") : (r2.value >= 0.999 ? "good" : "warn")) },
    { key: "dir", label: "Direction", render: (r2) => r2.lower ? "lower better" : "higher better" },
  ]));

  // candidates
  if (r.candidates.length) {
    const det = el("details");
    det.appendChild(el("summary", null, `Candidate set (${r.candidates.length})`));
    det.appendChild(table(r.candidates, [
      { key: "memory_key", label: "Memory" },
      { key: "runtime", label: "Runtime" },
      { key: "score", label: "Score", num: true, render: (c) => fmt(c.score) },
      { key: "explicit", label: "Via", render: (c) => c.explicit
        ? '<span class="badge active">exact lineage</span>'
        : '<span class="badge suspected">latent sketch</span>' },
    ]));
    out.appendChild(det);
  }

  // verdicts
  if (r.verdicts.length) {
    const det = el("details");
    det.appendChild(el("summary", null,
      `Signed verdicts returned to coordinator (${r.verdicts.length}) — note the absence of clinical text`));
    det.appendChild(table(r.verdicts, [
      { key: "runtime", label: "Runtime" },
      { key: "influence_band", label: "Band",
        render: (v) => `<span class="badge ${v.influence_band === "high" ? "contaminated" : "suspected"}">${esc(v.influence_band)}</span>` },
      { key: "influence_score", label: "I(s→v)", num: true, render: (v) => fmt(v.influence_score) },
      { key: "predicate_changed", label: "Predicate changed",
        render: (v) => v.predicate_changed ? "yes" : "no" },
      { key: "disposition", label: "Disposition" },
      { key: "memory_commitment", label: "Commitment",
        render: (v) => `<span class="mono">${esc(String(v.memory_commitment).slice(0, 16))}…</span>` },
    ]));
    out.appendChild(det);
  }

  // repairs
  if (r.repaired.length) {
    const det = el("details");
    det.appendChild(el("summary", null, `Clean-room repairs (${r.repaired.length})`));
    det.appendChild(table(r.repaired, [
      { key: "memory_key", label: "Original" },
      { key: "new_key", label: "Repaired version" },
      { key: "confidence", label: "Confidence", num: true },
      { key: "reason", label: "Basis", wrap: true },
    ]));
    out.appendChild(det);
  }
  if (r.quarantined.length) {
    const det = el("details");
    det.appendChild(el("summary", null, `Quarantined for review (${r.quarantined.length})`));
    det.appendChild(table(r.quarantined, [
      { key: "memory_key", label: "Memory" },
      { key: "reason", label: "Reason", wrap: true },
    ]));
    out.appendChild(det);
  }

  // capsules
  if (r.capsules.length) {
    const det = el("details");
    det.appendChild(el("summary", null,
      "Recovery capsules — every field that left a runtime"));
    det.appendChild(table(r.capsules, [
      { key: "recipient", label: "Recipient" },
      { key: "patient_token", label: "Patient token",
        render: (c) => `<span class="mono">${esc(String(c.patient_token).slice(0, 18))}…</span>` },
      { key: "artifact_type_band", label: "Type band" },
      { key: "time_band", label: "Time band" },
      { key: "sketch_dim", label: "Sketch dim", num: true },
      { key: "size_bytes", label: "Bytes", num: true },
    ]));
    det.appendChild(el("p", "small muted",
      "No patient name, MRN, note, laboratory value, hidden state, or KV cache appears " +
      "in this table because the capsule schema has no field for them."));
    out.appendChild(det);
  }

  // certificate
  out.appendChild(el("h3", null, "Recovery certificate"));
  out.appendChild(el("pre", "cert", esc(r.certificate_text)));
}

/* ---------------- baselines ---------------- */
$("btn-baselines").addEventListener("click", async () => {
  const incident_id = $("bl-incident").value;
  if (!incident_id) return;
  const btn = $("btn-baselines"); btn.disabled = true;
  const out = $("baseline-result");
  out.innerHTML = '<div class="notice info"><span class="spinner"></span>Running all nine conditions…</div>';
  try {
    const r = await api("/api/baselines",
      { method: "POST", body: JSON.stringify({ incident_id }) });
    out.innerHTML = "";
    out.appendChild(el("div", "notice info",
      `Provenance condition: <b>${esc(r.provenance)}</b>. All conditions ran against the
       same frozen snapshot and the same follow-up tasks.`));
    out.appendChild(table(r.results.filter((x) => !x.error), [
      { key: "condition", label: "ID" },
      { key: "name", label: "Condition", wrap: true },
      { key: "rwh", label: "RWH ↓", num: true, render: (x) => bar(x.rwh, x.rwh > 0 ? "bad" : "good") },
      { key: "descendant_recall", label: "Recall ↑", num: true,
        render: (x) => bar(x.descendant_recall, x.descendant_recall >= 0.999 ? "good" : "warn") },
      { key: "descendant_precision", label: "Precision ↑", num: true,
        render: (x) => bar(x.descendant_precision, x.descendant_precision >= 0.999 ? "good" : "warn") },
      { key: "bsr", label: "BSR ↑", num: true,
        render: (x) => bar(x.bsr, x.bsr >= 0.999 ? "good" : "bad") },
      { key: "rts", label: "RTS ↑", num: true, render: (x) => fmt(x.rts) },
      { key: "uer", label: "UER ↓", num: true,
        render: (x) => bar(x.uer, x.uer > 0 ? "bad" : "good") },
      { key: "drr", label: "DRR ↓", num: true,
        render: (x) => bar(x.drr, x.drr > 0 ? "bad" : "good") },
    ], { highlight: (x) => x.condition === "I" }));
    out.appendChild(el("p", "small muted",
      "Row I is AEGIS-Care. Compare against D/E (explicit lineage only), F (similarity " +
      "treated as causality), C (full reset), G (raw-content oracle, note its UER), and " +
      "H (complete private oracle graph)."));
    const errs = r.results.filter((x) => x.error);
    if (errs.length) {
      out.appendChild(el("div", "notice bad",
        "Failed conditions: " + errs.map((x) => `${x.condition} (${esc(x.error)})`).join(", ")));
    }
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; }
});

/* ---------------- privacy ---------------- */
$("btn-privacy").addEventListener("click", async () => {
  const incident_id = $("pv-incident").value;
  if (!incident_id) return;
  const btn = $("btn-privacy"); btn.disabled = true;
  const out = $("privacy-result");
  out.innerHTML = '<div class="notice info"><span class="spinner"></span>Attacking the recovery interface…</div>';
  try {
    const r = await api(`/api/privacy/${encodeURIComponent(incident_id)}`);
    out.innerHTML = "";
    const attacks = ["attribute_gender", "attribute_restricted", "membership", "linkability"]
      .map((k) => r[k]).filter(Boolean);
    out.appendChild(table(attacks, [
      { key: "name", label: "Attack", wrap: true },
      { key: "n", label: "n", num: true },
      { key: "accuracy", label: "Accuracy", num: true, render: (a) => fmt(a.accuracy) },
      { key: "baseline", label: "Baseline", num: true, render: (a) => fmt(a.baseline) },
      { key: "advantage", label: "Advantage", num: true,
        render: (a) => `<span style="color:${a.advantage > 0.05 ? "var(--bad)" : "var(--good)"}">${fmt(a.advantage)}</span>` },
    ]));

    const link = r.linkability || {};
    const ablation = link.detail && link.detail.unscoped_ablation_accuracy;
    if (ablation !== undefined) {
      out.appendChild(el("div", "notice good",
        `<b>Receiver scoping is load-bearing.</b> With scoping, cross-recipient linkage runs at
         chance (${fmt(link.accuracy)} vs ${fmt(link.baseline)} baseline). Remove scoping and
         linkage accuracy rises to <b>${fmt(ablation)}</b> — an honest-but-curious coordinator
         could join every recovery event back to the same patient.`));
    }

    const mem = r.membership || {};
    if (mem.advantage > 0.05) {
      out.appendChild(el("div", "notice warn",
        `<b>Residual leak reported, not hidden.</b> Membership inference achieves
         ${fmt(mem.accuracy)} against a ${fmt(mem.baseline)} baseline
         (advantage ${fmt(mem.advantage)}). The sketch is a candidate-discovery signal, and
         it does carry information. The proposal makes no confidentiality claim for it.`));
    }

    const rf = r.released_fields || {};
    out.appendChild(el("h3", null, "Released-field audit"));
    out.appendChild(el("div", rf.raw_content_exported ? "notice bad" : "notice good",
      `Raw clinical content exported through the recovery interface:
       <b>${rf.raw_content_exported ? "YES" : "NONE"}</b>.
       ${rf.capsules} capsule(s), ${rf.total_bytes} bytes total.`));
    out.appendChild(el("p", "small mono", esc((rf.fields_released || []).join(" · "))));
    if ((rf.undeclared_fields || []).length) {
      out.appendChild(el("div", "notice bad",
        "Undeclared fields present: " + esc(rf.undeclared_fields.join(", "))));
    }
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; }
});

/* ---------------- review ---------------- */
async function loadReview() {
  const out = $("review-result");
  try {
    const r = await api("/api/review/queue");
    out.innerHTML = "";
    if (!r.count) {
      out.appendChild(el("div", "notice good",
        "Queue empty — no artifact required human escalation."));
      return;
    }
    r.items.forEach((item) => {
      const p = el("div", "panel");
      p.style.marginTop = "12px";
      p.innerHTML =
        `<h3>${esc(item.memory_id)} <span class="mono muted">v${item.version}</span>
           ${stateBadge(item.state)}</h3>
         <p class="small muted">${esc(item.quarantine_reason || "")}</p>
         <pre class="cert">${esc(item.content)}</pre>`;
      const row = el("div", "controls");
      ["approve", "reject", "keep_quarantined"].forEach((decision) => {
        const b = el("button", `btn small ${decision === "reject" ? "danger" : "ghost"}`,
          decision.replace("_", " "));
        b.addEventListener("click", async () => {
          try {
            await api("/api/review", {
              method: "POST",
              body: JSON.stringify({ memory_key: `${item.memory_id}@v${item.version}`, decision }),
            });
            toast(`Recorded: ${decision.replace("_", " ")}`, { detail: item.memory_id, kind: "good" });
          } catch (err) {
            toast("Review decision failed", { detail: err.message, kind: "bad" });
          }
          loadReview();
        });
        row.appendChild(b);
      });
      p.appendChild(row);
      out.appendChild(p);
    });
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
}
$("btn-review-refresh").addEventListener("click", loadReview);

/* ---------------- graph ---------------- */
async function drawGraph() {
  const svg = $("graph-svg");
  svg.innerHTML = "";
  GRAPH_VIEW.base = null;   // nothing to pan or zoom until a graph is drawn
  let data;
  try { data = await api("/api/memory/none/graph"); }
  catch (e) {
    svg.innerHTML = `<text x="20" y="34" fill="#8ba09a" font-size="13">${esc(e.message)}</text>`;
    return;
  }

  const nodes = data.nodes;
  if (!nodes.length) {
    svg.innerHTML = `<text x="20" y="30" fill="#8b97a8" font-size="13">
      No memory yet — create an incident first.</text>`;
    return;
  }

  const roleOrder = ["registration", "nursing", "clinical_summary"];
  const layers = {};
  nodes.forEach((n) => (layers[n.owner] = layers[n.owner] || []).push(n));
  const maxLayerSize = Math.max(...roleOrder.map((role) => (layers[role] || []).length), 1);
  const W = Math.max(960, svg.parentElement?.clientWidth || 1100, maxLayerSize * 102 + 170);
  const H = 560;
  svg.style.width = `${W}px`;
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  resetGraphView(W, H);
  const laneH = H / roleOrder.length;
  const pos = {};
  roleOrder.forEach((role, li) => {
    const list = (layers[role] || []).sort((a, b) => a.key.localeCompare(b.key));
    list.forEach((n, i) => {
      pos[n.key] = {
        x: 125 + (i + 0.5) * ((W - 170) / Math.max(1, list.length)),
        y: laneH * li + laneH / 2,
        node: n,
      };
    });
  });

  const ns = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  };

  const defs = mk("defs", {});
  const gradient = mk("linearGradient", { id: "graph-flow", x1: "0", x2: "1" });
  gradient.appendChild(mk("stop", { offset: "0", "stop-color": "#51706f" }));
  gradient.appendChild(mk("stop", { offset: ".5", "stop-color": "#72e4df" }));
  gradient.appendChild(mk("stop", { offset: "1", "stop-color": "#51706f" }));
  defs.appendChild(gradient);
  const marker = mk("marker", {
    id: "graph-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5",
    markerWidth: "5", markerHeight: "5", orient: "auto-start-reverse",
  });
  marker.appendChild(mk("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#72e4df" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  roleOrder.forEach((role, li) => {
    svg.appendChild(mk("line", {
      x1: 105, y1: laneH * (li + 1), x2: W, y2: laneH * (li + 1),
      stroke: "rgba(255,255,255,.09)", "stroke-width": 1, "stroke-dasharray": "2 8",
    }));
    const t = mk("text", { x: 18, y: laneH * li + 28, fill: "#78908a", "font-size": 10 });
    t.textContent = role.replace("clinical_summary", "SUMMARY").toUpperCase();
    svg.appendChild(t);
  });

  data.edges.forEach((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return;
    const midY = (a.y + b.y) / 2;
    const line = mk("path", {
      d: `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`,
      class: `graph-edge ${e.observed ? "observed" : "masked"}`,
      "marker-end": e.observed ? "url(#graph-arrow)" : "",
    });
    const title = mk("title", {});
    title.textContent = e.observed ? "Observed provenance edge" : "Masked edge visible only in scoring truth";
    line.appendChild(title);
    svg.appendChild(line);
  });

  Object.values(pos).forEach(({ x, y, node }) => {
    const group = mk("g", { class: `graph-node state-${node.state || "active"}`, transform: `translate(${x} ${y})` });
    if (node.focus || node.state === "suspected" || node.state === "repaired") {
      group.appendChild(mk("circle", { class: "graph-pulse", r: node.focus ? 18 : 15 }));
    }
    group.appendChild(mk("circle", { r: node.focus ? 14 : 11 }));
    group.appendChild(mk("circle", { r: 3, fill: "currentColor", stroke: "none" }));
    const label = mk("text", {
      x: 0, y: 31,
    });
    label.textContent = node.type.replace(/_/g, " ");
    group.appendChild(label);
    const pt = mk("text", {
      class: "graph-sub", x: 0, y: -23,
    });
    pt.textContent = node.patient ? `TOKEN ${node.patient}` : "UNSCOPED";
    group.appendChild(pt);
    const title = mk("title", {});
    title.textContent = `${node.key}\nstate: ${node.state}\npatient: ${node.patient}`;
    group.appendChild(title);
    svg.appendChild(group);
  });
}
$("btn-graph-refresh").addEventListener("click", drawGraph);

/* ---------------- graph viewport (pan / zoom) ----------------
 * The derivation graph outgrows its frame as soon as a few incidents exist.
 * Zoom is applied to the SVG viewBox rather than a CSS transform so strokes
 * and text stay crisp at every scale.
 */
const GRAPH_VIEW = { scale: 1, x: 0, y: 0, base: null };

function applyGraphView() {
  const svg = $("graph-svg");
  if (!svg || !GRAPH_VIEW.base) return;
  const [bw, bh] = GRAPH_VIEW.base;
  const w = bw / GRAPH_VIEW.scale;
  const h = bh / GRAPH_VIEW.scale;
  svg.setAttribute("viewBox", `${GRAPH_VIEW.x} ${GRAPH_VIEW.y} ${w} ${h}`);
  const readout = $("graph-zoom");
  if (readout) readout.textContent = `${Math.round(GRAPH_VIEW.scale * 100)}%`;
}

function resetGraphView(width, height) {
  GRAPH_VIEW.base = [width, height];
  GRAPH_VIEW.scale = 1;
  GRAPH_VIEW.x = 0;
  GRAPH_VIEW.y = 0;
  applyGraphView();
}

function zoomGraph(factor, origin) {
  if (!GRAPH_VIEW.base) return;
  const next = Math.min(4, Math.max(0.4, GRAPH_VIEW.scale * factor));
  if (next === GRAPH_VIEW.scale) return;
  const [bw, bh] = GRAPH_VIEW.base;
  // Keep the point under the cursor fixed while the scale changes.
  const fx = origin ? origin.fx : 0.5;
  const fy = origin ? origin.fy : 0.5;
  const px = GRAPH_VIEW.x + (bw / GRAPH_VIEW.scale) * fx;
  const py = GRAPH_VIEW.y + (bh / GRAPH_VIEW.scale) * fy;
  GRAPH_VIEW.scale = next;
  GRAPH_VIEW.x = px - (bw / next) * fx;
  GRAPH_VIEW.y = py - (bh / next) * fy;
  applyGraphView();
}

function initGraphViewport() {
  const host = $("graph-scroll");
  if (!host) return;

  host.addEventListener("wheel", (e) => {
    if (!GRAPH_VIEW.base) return;
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    zoomGraph(e.deltaY < 0 ? 1.12 : 1 / 1.12, {
      fx: (e.clientX - rect.left) / rect.width,
      fy: (e.clientY - rect.top) / rect.height,
    });
  }, { passive: false });

  let dragging = null;
  host.addEventListener("pointerdown", (e) => {
    if (!GRAPH_VIEW.base || e.button !== 0) return;
    dragging = { px: e.clientX, py: e.clientY, ox: GRAPH_VIEW.x, oy: GRAPH_VIEW.y,
                 rect: host.getBoundingClientRect() };
    host.setPointerCapture(e.pointerId);
    host.classList.add("is-panning");
  });
  host.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const [bw, bh] = GRAPH_VIEW.base;
    GRAPH_VIEW.x = dragging.ox - (e.clientX - dragging.px) * (bw / GRAPH_VIEW.scale) / dragging.rect.width;
    GRAPH_VIEW.y = dragging.oy - (e.clientY - dragging.py) * (bh / GRAPH_VIEW.scale) / dragging.rect.height;
    applyGraphView();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = null;
    host.classList.remove("is-panning");
    try { host.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  };
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);

  $("btn-graph-zoom-in")?.addEventListener("click", () => zoomGraph(1.25));
  $("btn-graph-zoom-out")?.addEventListener("click", () => zoomGraph(1 / 1.25));
  $("btn-graph-fit")?.addEventListener("click", () => {
    if (GRAPH_VIEW.base) resetGraphView(...GRAPH_VIEW.base);
  });
}

/* ---------------- experiment ---------------- */
/* The matrix takes tens of seconds. /api/experiment/status publishes a
 * determinate completed/total plus the runner's own log, so the button does
 * not have to sit behind an unmoving spinner. */
function experimentProgressCard(out) {
  out.innerHTML = "";
  const card = el("div", "progress-card");
  card.innerHTML =
    `<div class="progress-head">
       <strong>Running the paired matrix</strong>
       <span class="mono" id="ex-progress-count">preparing…</span>
     </div>
     <div class="progress-track indeterminate" id="ex-progress-track"
          role="progressbar" aria-label="Experiment progress"
          aria-valuemin="0" aria-valuemax="100">
       <div class="progress-fill" id="ex-progress-fill" style="width:0%"></div>
     </div>
     <div class="progress-log" id="ex-progress-log"></div>`;
  out.appendChild(card);
  return card;
}

function startExperimentPolling() {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const s = await api("/api/experiment/status");
      const track = $("ex-progress-track");
      const fill = $("ex-progress-fill");
      const count = $("ex-progress-count");
      if (track && fill && count) {
        if (s.total_cells > 0) {
          const pct = Math.round(s.fraction * 100);
          track.classList.remove("indeterminate");
          fill.style.width = `${pct}%`;
          track.setAttribute("aria-valuenow", String(pct));
          count.textContent =
            `${s.completed_cells}/${s.total_cells} cells · ${pct}% · ${s.elapsed_seconds}s`;
        } else {
          count.textContent = `${s.elapsed_seconds}s elapsed`;
        }
      }
      const log = $("ex-progress-log");
      if (log && s.log?.length) {
        log.innerHTML = s.log.slice(-14).map((line) => `<div>${esc(line)}</div>`).join("");
        log.scrollTop = log.scrollHeight;
      }
    } catch (e) { /* a dropped poll must never abort the run itself */ }
    if (!stopped) window.setTimeout(tick, 700);
  };
  tick();
  return () => { stopped = true; };
}

$("btn-experiment").addEventListener("click", async () => {
  const btn = $("btn-experiment"); btn.disabled = true;
  const out = $("experiment-result");
  experimentProgressCard(out);
  const stopPolling = startExperimentPolling();
  const sel = (id) => Array.from($(id).selectedOptions).map((o) => o.value);
  try {
    const body = {
      families: sel("ex-families"),
      depths: sel("ex-depths").map(Number),
      provenance_conditions: sel("ex-prov"),
      tasks_per_family: Number($("ex-tasks").value),
    };
    const r = await api("/api/experiment", { method: "POST", body: JSON.stringify(body) });
    stopPolling();
    out.innerHTML = "";
    out.appendChild(el("div", "notice good",
      `Complete in ${r.wall_seconds}s — ${r.incidents} incidents, ${r.runs} condition runs.
       Tables, figures, and report written to <span class="mono">results/</span>.`));
    toast("Experiment complete", {
      detail: `${r.runs} condition runs over ${r.incidents} incidents in ${r.wall_seconds}s.`,
      kind: "good",
    });

    out.appendChild(el("h3", null, "Aggregate by condition"));
    out.appendChild(table(r.by_condition, [
      { key: "condition", label: "ID" },
      { key: "n", label: "n", num: true },
      { key: "rwh", label: "RWH ↓", num: true, render: (x) => bar(x.rwh, x.rwh > 0 ? "bad" : "good") },
      { key: "descendant_recall", label: "Recall ↑", num: true,
        render: (x) => bar(x.descendant_recall, "good") },
      { key: "descendant_precision", label: "Precision ↑", num: true,
        render: (x) => bar(x.descendant_precision, "good") },
      { key: "bsr", label: "BSR ↑", num: true, render: (x) => bar(x.bsr, "good") },
      { key: "uer", label: "UER ↓", num: true, render: (x) => bar(x.uer, x.uer > 0 ? "bad" : "good") },
      { key: "drr", label: "DRR ↓", num: true, render: (x) => fmt(x.drr) },
    ], { highlight: (x) => x.condition === "I" }));

    out.appendChild(el("h3", null, "RQ1 — recovery under provenance loss"));
    out.appendChild(table(r.by_condition_provenance, [
      { key: "condition", label: "ID" },
      { key: "provenance", label: "Provenance" },
      { key: "descendant_recall", label: "Recall ↑", num: true,
        render: (x) => bar(x.descendant_recall, "good") },
      { key: "descendant_precision", label: "Precision ↑", num: true,
        render: (x) => fmt(x.descendant_precision) },
      { key: "bsr", label: "BSR ↑", num: true, render: (x) => fmt(x.bsr) },
      { key: "rwh", label: "RWH ↓", num: true, render: (x) => fmt(x.rwh) },
    ], { highlight: (x) => x.condition === "I" }));

    out.appendChild(el("h3", null, "Oracle regret vs condition H"));
    out.appendChild(table(
      Object.entries(r.oracle_regret).map(([condition, regret]) => ({ condition, regret })),
      [{ key: "condition", label: "Condition" },
       { key: "regret", label: "Regret", num: true, render: (x) => fmt(x.regret, 4) }],
      { highlight: (x) => x.condition === "I" }));

    if (r.verification_failures && r.verification_failures.length) {
      out.appendChild(el("h3", null, "Verification failures (reported, not discarded)"));
      out.appendChild(table(r.verification_failures, [
        { key: "incident", label: "Incident", wrap: true },
        { key: "condition", label: "Condition" },
        { key: "reason", label: "Reason", wrap: true,
          render: (x) => esc(x.reason || x.error || "") },
      ]));
    }

    const link = el("p", "small muted");
    link.innerHTML = 'Full markdown report: <a href="/api/experiment/report" ' +
      'target="_blank" style="color:var(--accent)">/api/experiment/report</a>';
    out.appendChild(link);
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    toast("Experiment failed", { detail: e.message, kind: "bad", timeout: 9000 });
  } finally { stopPolling(); btn.disabled = false; }
});

/* ---------------- audit ---------------- */
async function loadAudit() {
  const log = $("audit-log");
  try {
    const r = await api("/api/events?limit=300");
    log.innerHTML = "";
    r.events.forEach((e) => {
      const row = el("div", "row");
      row.innerHTML =
        `<span class="muted">${esc(String(e.at).slice(11, 23))}</span>
         <span class="actor">${esc(e.actor)}</span>
         <span class="kind">${esc(e.kind)}</span>
         <span class="subject">${esc(e.subject ?? "")}</span>`;
      log.appendChild(row);
    });
    if (!r.events.length) log.innerHTML = '<span class="muted">No events yet.</span>';
  } catch (e) {
    log.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}
$("btn-audit-refresh").addEventListener("click", loadAudit);

/* ---------------- go ---------------- */
boot().catch((e) => {
  // Keep the shell (header, tabs, theme) so the failure is readable in context
  // rather than replacing the entire console with one line of red text.
  const view = document.querySelector(".view.active") || document.querySelector("main");
  view.innerHTML =
    `<div class="notice bad"><b>Failed to start.</b> ${esc(e.message)}<br>
     <span class="small">The API did not answer. Confirm the server is running, then reload.</span></div>`;
  toast("Dashboard failed to start", { detail: e.message, kind: "bad", timeout: 0 });
});

/* ================= CLINICIAN · MY PATIENTS =================
 * A clinician's question is about a patient, not a memory graph. This view is
 * record-shaped: who is affected, what changed, and what to re-verify.
 */
const STATUS_COPY = {
  attention: { label: "Needs attention", icon: "!", tone: "bad" },
  checking: { label: "Being checked", icon: "…", tone: "warn" },
  corrected: { label: "Corrected", icon: "✓", tone: "good" },
  withdrawn: { label: "Entries removed", icon: "✖", tone: "warn" },
  clear: { label: "No issues", icon: "✓", tone: "muted" },
};

let patientLoadSequence = 0;
let patientSearchReady = false;

async function loadPatients(preferredToken = STATE.selectedPatient) {
  const requestSequence = ++patientLoadSequence;
  const list = $("records-list");
  list.innerHTML = '<div class="loading-row"><span class="spinner"></span>Loading patients…</div>';
  try {
    const data = await api("/api/patients?only_with_memory=false");
    // Role changes and assistant navigation can start overlapping refreshes.
    // Only the newest response may paint the clinician console.
    if (requestSequence !== patientLoadSequence) return;
    STATE.patients = data.patients;
    if (!patientSearchReady) {
      $("records-search").addEventListener("input", renderPatientList);
      $("records-search").addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        const first = $("records-list").querySelector(".patient-row");
        if (first) { event.preventDefault(); first.click(); }
      });
      $("records-filter-attention").addEventListener("click", () => setPatientFilter("attention"));
      $("records-filter-all").addEventListener("click", () => setPatientFilter("all"));
      patientSearchReady = true;
    }
    renderPatientRollup();
    const requestedRow = STATE.patients.find((p) => p.token === preferredToken);
    if (requestedRow && requestedRow.status !== "attention" &&
        STATE.patientListFilter === "attention" && !$("records-search").value.trim()) {
      STATE.patientListFilter = "all";
      $("records-filter-attention").setAttribute("aria-pressed", "false");
      $("records-filter-all").setAttribute("aria-pressed", "true");
    }
    renderPatientList();
    const requestedExists = preferredToken
      && STATE.patients.some((p) => p.token === preferredToken);
    if (preferredToken && !requestedExists) {
      STATE.selectedPatient = null;
      $("records-detail").innerHTML =
        '<div class="notice warn"><b>That patient is not in the current workspace.</b> ' +
        'The list was refreshed and no different patient was opened.</div>';
      return;
    }
    const firstAttention = STATE.patients.find((p) => p.status === "attention");
    await selectPatient(requestedExists
      ? preferredToken : (firstAttention?.token ?? STATE.patients[0]?.token ?? null));
  } catch (e) {
    if (requestSequence !== patientLoadSequence) return;
    list.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
}

function setPatientFilter(filter) {
  STATE.patientListFilter = filter;
  $("records-search").value = "";
  $("records-filter-attention").setAttribute("aria-pressed", filter === "attention" ? "true" : "false");
  $("records-filter-all").setAttribute("aria-pressed", filter === "all" ? "true" : "false");
  renderPatientList();
  const visible = $("records-list").querySelector(`.patient-row[data-token="${STATE.selectedPatient}"]`);
  if (!visible) $("records-list").querySelector(".patient-row")?.click();
}

function renderPatientRollup() {
  const counts = { attention: 0, checking: 0, corrected: 0, withdrawn: 0, clear: 0 };
  STATE.patients.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
  const needsYou = counts.attention;
  const sourceTotal = STATE.patients.reduce((sum, p) => sum + (p.source_records || 0), 0);
  $("records-rollup").innerHTML =
    `<div class="rollup ${needsYou ? "is-alert" : "is-calm"}">
       <div class="rollup-figure">${needsYou}</div>
       <div class="rollup-copy">
         <strong>${needsYou ? `${needsYou} patient${needsYou === 1 ? "" : "s"} need a record check` : "No detected record mismatch"}</strong>
         <span>${STATE.patients.length} synthetic patients · ${sourceTotal} source records · ${counts.corrected} with corrected assistant memory</span>
       </div>
     </div>`;
}

function renderPatientList() {
  const list = $("records-list");
  list.innerHTML = "";
  if (!STATE.patients.length) {
    list.innerHTML =
      `<div class="empty-teach">
         <strong>No patients are available.</strong>
         <span>Refresh the workspace or ask an administrator to check the synthetic registry.</span>
       </div>`;
    $("records-detail").innerHTML = "";
    return;
  }
  const query = $("records-search").value.trim().toLowerCase();
  const matching = STATE.patients.filter((p) =>
    query ? [p.patient.name, p.patient.id, p.patient.mrn].some((v) =>
      String(v || "").toLowerCase().includes(query)) :
      STATE.patientListFilter === "all" || p.status === "attention");
  $("records-match-count").textContent = query
    ? `${matching.length} matching patients`
    : `${matching.length} ${STATE.patientListFilter === "attention" ? "need review" : "patients"}`;
  if (!matching.length) {
    list.innerHTML = query
      ? '<div class="empty-teach"><strong>No matching patient.</strong><span>Try a name, synthetic ID, or MRN.</span></div>'
      : '<div class="empty-teach"><strong>No one needs review.</strong><span>Choose All patients to browse the registry.</span></div>';
    return;
  }
  matching.forEach((p) => {
    const s = STATUS_COPY[p.status];
    const row = el("button", `patient-row tone-${s.tone}`);
    row.type = "button";
    row.dataset.token = p.token;
    row.setAttribute("aria-label", `${p.patient.name}, MRN ${p.patient.mrn ?? "unknown"}, ${p.headline}, ${p.source_records} source records, ${p.records} assistant memory entries`);
    row.setAttribute("aria-pressed", p.token === STATE.selectedPatient ? "true" : "false");
    row.innerHTML =
      `<span class="patient-flag" aria-hidden="true">${esc(s.icon)}</span>
       <span class="patient-main">
         <strong>${esc(p.patient.name)}</strong>
         <small>MRN ${esc(p.patient.mrn ?? "—")}</small>
       </span>
       <span class="patient-state">
         <span class="patient-headline">${esc(p.headline)}</span>
         <small>${p.source_records} source · ${p.records} assistant notes</small>
       </span>`;
    row.addEventListener("click", () => selectPatient(p.token, { reveal: true }));
    list.appendChild(row);
  });
}

async function selectPatient(token, { reveal = false } = {}) {
  if (token !== STATE.selectedPatient) {
    STATE.patientPanel = "summary";
    STATE.patientFlash = null;
  }
  STATE.selectedPatient = token;
  document.querySelectorAll(".patient-row").forEach((r) => {
    const selected = r.dataset.token === token;
    r.classList.toggle("is-selected", selected);
    r.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  const out = $("records-detail");
  if (!token) { out.innerHTML = ""; return; }
  out.innerHTML = '<div class="loading-row"><span class="spinner"></span>Opening record…</div>';
  try {
    const data = await api(`/api/patients/${encodeURIComponent(token)}/record`);
    renderPatientRecord(data, out);
    if (reveal && window.matchMedia("(max-width: 1050px)").matches) {
      out.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    }
    $("urgent-announcer").textContent = `${data.patient.name} record opened. ${
      (data.summary.held + data.source_summary.source_held) ?
      `${data.summary.held + data.source_summary.source_held} item${
        data.summary.held + data.source_summary.source_held === 1 ? "" : "s"} need${
        data.summary.held + data.source_summary.source_held === 1 ? "s" : ""} review.` :
      "Read the safety status and next action."}`;
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
}

function renderPatientRecord(data, out) {
  const p = data.patient;
  const s = data.summary;
  const ss = data.source_summary;
  out.innerHTML = "";

  // A plain-language verdict first. Everything else is supporting detail.
  let verdict, tone, advice;
  const live = s.in_use;
  if (s.held || ss.source_held || ss.held_transfers || ss.open_reports) {
    const heldCount = s.held + ss.source_held;
    verdict = heldCount
      ? `${heldCount} record${heldCount === 1 ? "" : "s"} held for review`
      : "A handover or reported concern needs review";
    tone = "bad";
    const pending = [];
    if (ss.held_transfers) pending.push(`${ss.held_transfers} handover${ss.held_transfers === 1 ? "" : "s"} blocked`);
    if (ss.open_reports) pending.push(`${ss.open_reports} reported concern${ss.open_reports === 1 ? "" : "s"} open`);
    advice = heldCount
      ? "Keep held information out of handovers until a reviewer checks the source chart."
      : "A handover or reported concern is awaiting review.";
    if (pending.length) advice += ` ${pending.join(" · ")}.`;
  } else if (s.corrected) {
    verdict = `${s.corrected} record${s.corrected === 1 ? " was" : "s were"} corrected`;
    tone = "good";
    advice = "The corrected versions are safe to use. Review what changed below.";
  } else if (ss.source_corrected) {
    verdict = `${ss.source_corrected} chart association${ss.source_corrected === 1 ? " was" : "s were"} corrected`;
    tone = "good";
    advice = "The misfiled source record was moved to the chart identified by its FHIR patient reference. Review the correction history below.";
  } else if (s.withdrawn && !live) {
    verdict = `${s.withdrawn} entr${s.withdrawn === 1 ? "y was" : "ies were"} removed from this record`;
    tone = "warn";
    advice = "These entries were filed against this patient in error and have been "
      + "withdrawn. Nothing here is in active use. If you acted on them earlier, "
      + "re-check against the source record.";
  } else {
    verdict = "No record mismatch detected";
    tone = "muted";
    advice = "The automatic check covers patient identity and source status. It does not judge symptoms or clinical meaning.";
  }

  const head = el("div", "record-head");
  head.innerHTML =
    `<div class="record-identity">
       <div class="record-avatar" aria-hidden="true">${esc((p.name || "?").slice(0, 1))}</div>
       <div>
         <h3>${esc(p.name)}</h3>
         <div class="record-meta">MRN ${esc(p.mrn ?? "—")}${
           p.birth_date ? ` · born ${esc(p.birth_date)}` : ""}</div>
       </div>
     </div>
     <div class="record-verdict tone-${tone}">
       <strong>${esc(verdict)}</strong>
       <span>${esc(advice)}</span>
     </div>
     <button class="back-to-patients" type="button">← Back to patient list</button>`;
  out.appendChild(head);
  head.querySelector(".back-to-patients").addEventListener("click", () => {
    $("records-search").scrollIntoView({ block: "start" });
    $("records-search").focus({ preventScroll: true });
  });

  const needsReview = s.held || ss.source_held || ss.held_transfers || ss.open_reports;
  const tabNames = [
    ["summary", "Summary"], ["records", `Records (${ss.source_records})`],
    ["handover", "Handover"], ["report", "Report a concern"],
  ];
  const tabs = el("div", "patient-task-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", `${p.name} actions`);
  const panels = {};
  tabNames.forEach(([id, title]) => {
    const button = el("button", "patient-task-tab", esc(title));
    button.type = "button";
    button.id = `patient-tab-${id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `patient-panel-${id}`);
    button.dataset.patientPanel = id;
    tabs.appendChild(button);
    const panel = el("section", "patient-task-panel");
    panel.id = `patient-panel-${id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panel.tabIndex = -1;
    panels[id] = panel;
  });
  out.appendChild(tabs);
  Object.values(panels).forEach((panel) => out.appendChild(panel));
  const showPanel = (name, focus = false) => {
    STATE.patientPanel = name;
    tabs.querySelectorAll("button").forEach((button) => {
      const active = button.dataset.patientPanel === name;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
    Object.entries(panels).forEach(([id, panel]) => { panel.hidden = id !== name; });
    if (focus) panels[name].focus();
  };
  tabs.querySelectorAll("button").forEach((button) => button.addEventListener("click", () =>
    showPanel(button.dataset.patientPanel, true)));
  tabs.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...tabs.querySelectorAll("button")];
    const index = buttons.findIndex((button) => button.getAttribute("aria-selected") === "true");
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    showPanel(buttons[next].dataset.patientPanel);
    buttons[next].focus();
  });

  const next = el("section", `record-next-step ${needsReview ? "is-alert" : "is-safe"}`);
  next.innerHTML = `<div class="record-next-copy">
      <strong>${needsReview ? "What to do now" : "Ready for the next task"}</strong>
      <span>${needsReview
        ? "Open Records to see the flagged items. Keep held information out of use and ask a reviewer to verify the source chart. Nurses cannot approve quarantined records."
        : "The identity and source-status checks found no mismatch. You can review records, prepare a handover, or raise a concern."}</span>
    </div><div class="patient-primary-actions">
      <button class="btn" type="button" data-go="records">${needsReview ? "Review flagged records" : "View records"}</button>
      <button class="btn outline" type="button" data-go="handover">Start a handover</button>
      <button class="btn ghost" type="button" data-go="report">Report a concern</button>
    </div>`;
  next.querySelectorAll("button[data-go]").forEach((button) => button.addEventListener("click", () =>
    showPanel(button.dataset.go, true)));
  panels.summary.appendChild(next);

  const sourceStats = el("div", "record-stats");
  [[ss.source_records, "source records"], [ss.source_held, "source records held"],
   [ss.completed_transfers, "handovers completed"], [ss.held_transfers, "handovers blocked"]]
    .forEach(([value, label]) => sourceStats.appendChild(el("div", "record-stat",
      `<b>${esc(value)}</b><span>${esc(label)}</span>`)));
  panels.summary.appendChild(sourceStats);

  const flagged = data.source_records.filter((r) => r.status === "held");
  if (flagged.length || ss.open_reports || ss.held_transfers) {
    panels.summary.appendChild(el("h4", "record-section", "Why this needs attention"));
    const issues = el("div", "patient-issue-list");
    flagged.slice(0, 4).forEach((r) => issues.appendChild(el("div", "patient-issue",
      `<b>${esc(r.label)}</b><span>${esc(r.issues.join(" "))}</span>`)));
    if (ss.open_reports) issues.appendChild(el("div", "patient-issue",
      `<b>${ss.open_reports} open manual concern${ss.open_reports === 1 ? "" : "s"}</b><span>A person noticed something the automated check cannot judge.</span>`));
    if (ss.held_transfers) issues.appendChild(el("div", "patient-issue",
      `<b>${ss.held_transfers} blocked handover${ss.held_transfers === 1 ? "" : "s"}</b><span>No mismatched record was moved to another chart.</span>`));
    panels.summary.appendChild(issues);
  }
  panels.summary.appendChild(el("p", "patient-scope-note",
    "AEGIS checks identity and source status. It cannot decide whether a symptom or diagnosis is clinically correct."));
  const summaryTools = el("div", "patient-summary-tools");
  summaryTools.innerHTML = '<button class="btn ghost small" type="button" data-tool="ask">Ask AEGIS to explain</button><button class="btn ghost small" type="button" data-tool="print">Print summary</button>';
  summaryTools.querySelector('[data-tool="ask"]').addEventListener("click", () => {
    toggleChat(true);
    sendChat(`What should I do next for patient ${p.id}?`);
  });
  summaryTools.querySelector('[data-tool="print"]').addEventListener("click", () => window.print());
  panels.summary.appendChild(summaryTools);

  panels.records.appendChild(el("h4", "record-section", "Source records"));
  panels.records.appendChild(el("p", "hint", "Held records appear first. Select a record to prepare a handover or report a concern."));
  const sourceWrap = el("div", "source-record-list");
  [...data.source_records].sort((a, b) =>
    (a.status === "held" ? 0 : 1) - (b.status === "held" ? 0 : 1))
    .forEach((r) => {
    const card = el("div", `source-record ${r.status === "held" ? "is-held" : ""}`);
    const value = r.restricted ? "Restricted value" :
      r.value == null ? "" : `${r.value} ${r.unit || ""}`;
    card.innerHTML = `<div><strong>${esc(r.label)}</strong><small>${esc(r.resource_type)} · ${esc(r.record_key)}</small><small>Recorded: ${esc(r.observed_at || "Date not recorded")}</small></div>
      <div class="source-record-state"><b>${r.status === "held" ? "Held" : "Available"}</b><span>${esc(value)}</span></div>
      ${r.issues.length ? `<p>${r.issues.map(esc).join(" ")}</p>` : ""}`;
    const actions = el("div", "source-record-actions");
    const handover = el("button", "btn ghost small", "Prepare handover");
    handover.type = "button";
    handover.addEventListener("click", () => {
      transferForm.elements.record_key.value = r.record_key;
      showPanel("handover", true);
    });
    const report = el("button", "btn ghost small", "Report concern");
    report.type = "button";
    report.addEventListener("click", () => {
      reportForm.elements.record_key.value = r.record_key;
      showPanel("report", true);
    });
    actions.append(handover, report);
    card.appendChild(actions);
    sourceWrap.appendChild(card);
  });
  panels.records.appendChild(sourceWrap);

  panels.handover.appendChild(el("div", "patient-panel-intro",
    "<h4>Prepare a handover</h4><p>Choose a source record and a destination. AEGIS checks the patient link before recording the transfer.</p>"));
  const transferForm = el("form", "registry-form patient-form");
  transferForm.id = "transfer-form";
  transferForm.innerHTML = `<label>Record to hand over<select name="record_key" required></select></label>
    <div class="receiving-chart"><span>Receiving chart</span><strong>${esc(p.name)}</strong><small>MRN ${esc(p.mrn)} · ${esc(p.id)}</small></div>
    <label>Destination<select name="destination" required></select></label>
    <details class="demo-mismatch"><summary>Demo: choose a different patient chart</summary>
      <p>This intentionally tests a wrong-patient transfer. AEGIS should hold it.</p>
      <label>Other patient<select name="alternate_patient"></select></label>
    </details>
    <button class="btn" type="submit">Check and hand over</button>
    <div class="form-result" aria-live="polite"></div>`;
  panels.handover.appendChild(transferForm);

  panels.report.appendChild(el("div", "patient-panel-intro",
    "<h4>Report what you noticed</h4><p>Use this when identity checks cannot determine whether a record is correct. Your concern holds the selected record for review.</p>"));
  const reportForm = el("form", "registry-form patient-form");
  reportForm.id = "manual-report-form";
  reportForm.innerHTML = `<label>Record<select name="record_key"><option value="">General patient concern</option></select></label>
    <label>What concerns you?<textarea name="description" required minlength="10" maxlength="1000" placeholder="For example: the symptom was reported for another visit"></textarea></label>
    <button class="btn outline" type="submit">Send for review</button>
    <div class="form-result" aria-live="polite"></div>`;
  panels.report.appendChild(reportForm);
  const recordOptions = data.source_records.map((r) =>
    new Option(`${r.label} · ${r.record_key}${r.status === "held" ? " · held" : ""}`, r.record_key));
  recordOptions.forEach((o) => transferForm.elements.record_key.add(o));
  const firstSafe = data.source_records.find((r) => r.status === "available" && !r.restricted);
  if (firstSafe) transferForm.elements.record_key.value = firstSafe.record_key;
  data.source_records.forEach((r) => reportForm.elements.record_key.add(
    new Option(`${r.label} · ${r.record_key}`, r.record_key)));
  STATE.patients.filter((row) => row.patient.id !== p.id).forEach((row) =>
    transferForm.elements.alternate_patient.add(
      new Option(`${row.patient.name} · ${row.patient.id}`, row.patient.id)));
  data.transfer_destinations.forEach((d) => transferForm.elements.destination.add(new Option(d, d)));
  transferForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = transferForm.querySelector(".form-result");
    result.textContent = "Checking transfer…";
    try {
      const body = {
        record_key: transferForm.elements.record_key.value,
        target_patient_id: transferForm.querySelector(".demo-mismatch").open
          ? transferForm.elements.alternate_patient.value : p.id,
        destination: transferForm.elements.destination.value,
      };
      const response = await api("/api/registry/transfers", { method: "POST", body: JSON.stringify(body) });
      const message = response.status === "held"
        ? `Transfer held: ${response.explanation}` : "Handover completed and recorded.";
      STATE.patientPanel = "handover";
      STATE.patientFlash = { panel: "handover", patient: p.id, message,
        tone: response.status === "held" ? "warn" : "good" };
      $("urgent-announcer").textContent = message;
      await loadPatients(p.id);
    } catch (error) { result.textContent = error.message; }
  });
  reportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = reportForm.querySelector(".form-result");
    result.textContent = "Submitting concern…";
    try {
      const body = { ...Object.fromEntries(new FormData(reportForm)), patient_id: p.id };
      if (!body.record_key) body.record_key = null;
      await api("/api/registry/reports", { method: "POST", body: JSON.stringify(body) });
      const message = "Concern recorded. A reviewer can now see it in the queue.";
      STATE.patientPanel = "report";
      STATE.patientFlash = { panel: "report", patient: p.id, message, tone: "warn" };
      $("urgent-announcer").textContent = message;
      await loadPatients(p.id);
    } catch (error) { result.textContent = error.message; }
  });

  if (data.transfers.length) {
    panels.handover.appendChild(el("h4", "record-section", "Recent handovers"));
    const history = el("div", "registry-history");
    data.transfers.slice(0, 8).forEach((t) => history.appendChild(el("p", null,
      `<b>${esc(t.status === "held" ? "Held" : "Completed")}</b> · ${esc(t.record_key)} → ${esc(t.destination)} / ${esc(t.target_patient_id)}<br><small>${esc(t.explanation)}</small>`)));
    panels.handover.appendChild(history);
  }
  if (data.manual_reports.length) {
    panels.report.appendChild(el("h4", "record-section", "Your recent concerns"));
    const history = el("div", "registry-history");
    data.manual_reports.slice(0, 8).forEach((r) => history.appendChild(el("p", null,
      `<b>${esc(r.status === "open" ? "Awaiting review" : r.status === "resolved" ? "Addressed" : "Dismissed")}</b> · ${esc(r.description)}${r.resolution_note ? `<br><small>Review note: ${esc(r.resolution_note)}</small>` : ""}`)));
    panels.report.appendChild(history);
  }
  if (data.source_corrections?.length) {
    panels.records.appendChild(el("h4", "record-section", "Source chart correction history"));
    const history = el("div", "registry-history");
    data.source_corrections.forEach((c) => history.appendChild(el("p", null,
      `<b>${esc(c.record_key)}</b> · ${esc(c.from_patient_id)} → ${esc(c.to_patient_id)}<br><small>${esc(c.note)} · ${esc(c.created_at)}</small>`)));
    panels.records.appendChild(history);
  }

  panels.records.appendChild(el("h4", "record-section", "Assistant memory (separate from source records)"));

  const stats = el("div", "record-stats");
  [[s.total, "total records"], [s.in_use, "in use now"],
   [s.corrected, "corrected"], [s.withdrawn, "withdrawn"]]
    .forEach(([value, label]) => {
      stats.appendChild(el("div", "record-stat",
        `<b>${esc(value)}</b><span>${esc(label)}</span>`));
    });
  panels.records.appendChild(stats);

  if (data.changes.length) {
    panels.records.appendChild(el("h4", "record-section", "What changed"));
    data.changes.forEach((c) => panels.records.appendChild(renderChange(c)));
  }

  if (data.held_for_review.length) {
    panels.records.appendChild(el("h4", "record-section", "Held for review"));
    data.held_for_review.forEach((h) => {
      panels.records.appendChild(el("div", "held-card",
        `<strong>${esc(String(h.artifact_type).replace(/_/g, " "))}</strong>
         <p>${esc(h.quarantine_reason || "Could not be rebuilt safely.")}</p>
         <small>Do not rely on this item until a reviewer clears it.</small>`));
    });
  }

  const det = el("details", "record-all");
  det.appendChild(el("summary", null, `Complete memory history (${data.records.length})`));
  det.appendChild(table(data.records, [
    { key: "artifact_type", label: "Record",
      render: (r) => esc(String(r.artifact_type).replace(/_/g, " ")) },
    { key: "state", label: "Status",
      render: (r) => `<span class="badge ${esc(r.state)}">${esc(t(r.state, r.state))}</span>` },
    { key: "servable", label: "In use", render: (r) => r.servable ? "yes" : "no" },
    { key: "version", label: "Version", num: true, render: (r) => `v${r.version}` },
  ]));
  panels.records.appendChild(det);

  if (STATE.patientFlash?.patient === p.id) {
    const flash = STATE.patientFlash;
    panels[flash.panel].prepend(el("div", `notice ${flash.tone}`, esc(flash.message)));
    STATE.patientFlash = null;
  }
  showPanel(panels[STATE.patientPanel] ? STATE.patientPanel : "summary");
}

/* A real before/after, with the re-filing called out - that is the fact a
 * clinician needs, not the derivation mechanics. */
function renderChange(c) {
  const card = el("div", "change-card");
  card.innerHTML =
    `<div class="change-head">
       <strong>${esc(String(c.artifact_type).replace(/_/g, " "))}</strong>
       <span class="change-tag">v${esc(c.from_version)} → v${esc(c.to_version)}</span>
     </div>
     ${c.refiled ? `<div class="change-refiled">
        <span aria-hidden="true">⚠</span> This record was previously filed under a
        different patient (${esc(c.previously_filed_under)}).</div>` : ""}
     <div class="diff">
       <div class="diff-side was">
         <div class="diff-label">Was — do not use</div>
         <p>${esc(c.before)}</p>
       </div>
       <div class="diff-side now">
         <div class="diff-label">Now — rebuilt from source records</div>
         <p>${esc(c.after)}</p>
       </div>
     </div>`;
  return card;
}

/* ================= SAFETY OFFICER - INCIDENT COMMAND =================
 * The safety officer's object is an incident, and the question is containment.
 * The blast radius replaces the derivation graph: rings are hops from the
 * original error, colour is the current state. Containment is legible at a
 * glance instead of requiring the reader to trace edges.
 */
const CMD_STEPS = [
  ["Find", "Search lineage and similarity for records that may have inherited the error"],
  ["Prove", "Rebuild each candidate without the suspect entry to see if it actually mattered"],
  ["Rebuild", "Recreate confirmed records from trusted source data, or hold them for review"],
  ["Hold the line", "Withdraw the bad versions and block them from coming back"],
];

const PROV_COPY = {
  complete: "Complete - every link recorded",
  random20: "Patchy - about 20% of links lost",
  random40: "Degraded - about 40% of links lost",
  random60: "Severe - about 60% of links lost",
  targeted: "Worst case - the links that matter most are missing",
};

function initCommandView() {
  if (STATE.commandReady) { renderCommandStatus(); return; }
  STATE.commandReady = true;

  const fam = $("cmd-family");
  fam.innerHTML = "";
  Object.entries(STATE.system.families).forEach(([id, f]) =>
    fam.appendChild(new Option(f.name, id)));

  const prov = $("cmd-prov");
  prov.innerHTML = "";
  STATE.system.provenance_conditions.forEach((c) =>
    prov.appendChild(new Option(PROV_COPY[c] || c, c)));
  prov.value = "targeted";

  renderCommandSteps(-1);
  renderCommandStatus();
  renderBlastRadius(null, null);

  $("btn-cmd-inject").addEventListener("click", commandInject);
  $("btn-cmd-recover").addEventListener("click", commandRecover);
}

function renderCommandSteps(activeIndex, done = -1) {
  $("command-steps").innerHTML = CMD_STEPS.map(([name, desc], i) =>
    `<div class="cmd-step${i === activeIndex ? " is-active" : ""}${i <= done ? " is-done" : ""}">
       <span class="cmd-step-dot" aria-hidden="true">${i <= done ? "✓" : i + 1}</span>
       <span><strong>${esc(name)}</strong><small>${esc(desc)}</small></span>
     </div>`).join("");
}

function renderCommandStatus() {
  const inc = STATE.commandIncident;
  const rec = STATE.commandRecovery;
  let tone = "idle", head = "No active incident", sub = "Report an error to begin.";
  if (inc && !rec) {
    tone = "alert";
    head = "Containment required";
    sub = `${inc.true_contaminated.length} record${
      inc.true_contaminated.length === 1 ? "" : "s"} affected · ${
      inc.provenance?.edges_removed ?? 0} of ${
      inc.provenance?.edges_before ?? 0} links missing`;
  } else if (rec) {
    const safe = rec.certificate?.safe_resume;
    tone = safe ? "clear" : "alert";
    head = safe ? "Contained" : "Review required";
    sub = safe
      ? `${rec.repaired.length} rebuilt · ${rec.enforcement.tombstones} withdrawn · ${
          rec.resurrection_probe.blocked}/${rec.resurrection_probe.attempts} return attempts blocked`
      : `${(rec.certificate?.unresolved_risk || []).length} item(s) unresolved`;
  }
  $("command-status").innerHTML =
    `<div class="cmd-status is-${tone}">
       <span class="cmd-status-dot" aria-hidden="true"></span>
       <div><strong>${esc(head)}</strong><span>${esc(sub)}</span></div>
     </div>`;
}

async function commandInject() {
  const btn = $("btn-cmd-inject");
  btn.disabled = true;
  $("btn-cmd-recover").disabled = true;
  STATE.commandRecovery = null;
  $("command-outcome").innerHTML = "";
  renderCommandSteps(0);
  try {
    const family = $("cmd-family").value;
    const graph = await api("/api/memory/none/graph");
    const task = recommendedTask(family, graph.nodes || []);
    const created = await api("/api/incidents", {
      method: "POST",
      body: JSON.stringify({ family, task_id: task.task_id, depth: 4,
                             provenance: $("cmd-prov").value, n_controls: 1 }),
    });
    const detail = await api(`/api/incidents/${encodeURIComponent(created.incident_id)}`);
    STATE.commandIncident = detail;
    renderBlastRadius(detail, null);
    renderCommandStatus();
    renderCommandSteps(-1);
    $("btn-cmd-recover").disabled = false;
    toast("Error reported", {
      detail: `${detail.true_contaminated.length} records affected.`, kind: "warn" });
    await refreshIncidents();
  } catch (e) {
    toast("Could not report the error", { detail: e.message, kind: "bad" });
    renderCommandSteps(-1);
  } finally { btn.disabled = false; }
}

async function commandRecover() {
  if (!STATE.commandIncident) return;
  const btn = $("btn-cmd-recover");
  btn.disabled = true;
  // Walk the four stages while the request is in flight so the operator sees
  // what the system is doing, not just a spinner.
  let step = 0;
  renderCommandSteps(0);
  const ticker = window.setInterval(() => {
    step = Math.min(step + 1, CMD_STEPS.length - 1);
    renderCommandSteps(step, step - 1);
  }, 520);
  try {
    const rec = await api("/api/recover", {
      method: "POST",
      body: JSON.stringify({ incident_id: STATE.commandIncident.incident_id }),
    });
    window.clearInterval(ticker);
    renderCommandSteps(-1, CMD_STEPS.length - 1);
    STATE.commandRecovery = rec;
    STATE.lastRecovery = rec;
    renderBlastRadius(STATE.commandIncident, rec);
    renderCommandStatus();
    renderCommandOutcome(rec);
    toast(rec.certificate?.safe_resume ? "Incident contained" : "Review required", {
      detail: `${rec.repaired.length} rebuilt · ${rec.quarantined.length} held.`,
      kind: rec.certificate?.safe_resume ? "good" : "warn" });
    await refreshIncidents();
  } catch (e) {
    window.clearInterval(ticker);
    renderCommandSteps(-1);
    toast("Recovery failed", { detail: e.message, kind: "bad" });
  } finally { btn.disabled = false; }
}

function renderCommandOutcome(rec) {
  const out = $("command-outcome");
  out.innerHTML = "";
  const m = rec.metrics || {};
  const safe = rec.certificate?.safe_resume;

  out.appendChild(el("div", `verdict-banner ${safe ? "is-good" : "is-warn"}`,
    `<div class="verdict-mark" aria-hidden="true">${safe ? "✓" : "!"}</div>
     <div><strong>${safe ? "Safe to resume" : "Hold - review required"}</strong>
       <span>${safe
         ? `Closure reached in ${rec.rounds} round(s). Every affected record was rebuilt from trusted source data, and the withdrawn versions are blocked from returning.`
         : `${(rec.certificate?.unresolved_risk || []).length} item(s) could not be resolved automatically and were escalated.`}</span>
     </div>`));

  const cards = el("div", "outcome-cards");
  [[t("rwh"), m.rwh, true], [t("descendant_recall"), m.descendant_recall, false],
   [t("bsr"), m.bsr, false], [t("drr"), m.drr, true]]
    .forEach(([label, value, lowerBetter]) => {
      const ok = lowerBetter ? (value === 0) : (value >= 0.999);
      cards.appendChild(el("div", `outcome-card ${ok ? "is-good" : "is-warn"}`,
        `<span class="outcome-label">${esc(label)}</span>
         <b>${fmt(value)}</b>
         <small>${lowerBetter ? "lower is better" : "higher is better"}</small>`));
    });
  out.appendChild(cards);

  const det = el("details", "record-all");
  det.appendChild(el("summary", null, "Full recovery certificate"));
  det.appendChild(el("pre", "cert", esc(rec.certificate_text)));
  out.appendChild(det);
}

/* Concentric rings = hops from the seed. One glance tells you how far it went
 * and how much is repaired. */
function renderBlastRadius(incident, recovery) {
  const host = $("blast-radius");
  if (!incident) {
    host.innerHTML =
      `<div class="empty-teach centered">
         <strong>No incident yet.</strong>
         <span>Report an error and the affected records will appear here as rings
           spreading out from the original mistake.</span>
       </div>`;
    $("blast-legend").innerHTML = "";
    return;
  }

  const nodes = incident.trajectory || [];
  const repaired = new Set((recovery?.repaired || []).map((r) => r.memory_key));
  const quarantined = new Set((recovery?.quarantined || []).map((r) => r.memory_key));
  const maxDepth = Math.max(...nodes.map((n) => n.depth), 1);

  const size = 500, cx = size / 2, cy = size / 2;
  // The first ring clears the centre node's own label, so the seed never
  // collides with its immediate descendants.
  const innerR = 74;
  const outerR = size / 2 - 62;
  const ringGap = (outerR - innerR) / Math.max(maxDepth - 1, 1);
  const radiusFor = (depth) => (depth === 0 ? 0 : innerR + ringGap * (depth - 1));

  const rings = Array.from({ length: maxDepth }, (_, i) =>
    `<circle class="blast-ring" cx="${cx}" cy="${cy}" r="${radiusFor(i + 1)}"/>`
  ).join("");

  // Nodes are placed by depth ring. Rings are rotated by the golden angle so a
  // chain with one node per depth spirals outward instead of stacking in a
  // single vertical line, and labels never sit on top of each other.
  const GOLDEN = 2.399963;
  const byDepth = {};
  nodes.forEach((n) => (byDepth[n.depth] = byDepth[n.depth] || []).push(n));
  const marks = nodes.map((n) => {
    const peers = byDepth[n.depth];
    const idx = peers.indexOf(n);
    const r = radiusFor(n.depth);
    const angle = (-Math.PI / 2) + (idx / peers.length) * Math.PI * 2 + n.depth * GOLDEN;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    let cls = "is-clean";
    if (quarantined.has(n.key)) cls = "is-held";
    else if (repaired.has(n.key)) cls = "is-repaired";
    else if (n.contaminated) cls = "is-affected";
    const seed = n.key === incident.seed_key ? " is-seed" : "";
    const label = String(n.type || "").replace(/_/g, " ");
    // Keep the label inside the frame for nodes near the right or left edge.
    const anchor = x > size - 78 ? "end" : (x < 78 ? "start" : "middle");
    const dx = anchor === "end" ? 14 : (anchor === "start" ? -14 : 0);
    return `<g class="blast-node ${cls}${seed}" transform="translate(${x} ${y})">
        <circle class="blast-halo" r="21"/>
        <circle class="blast-core" r="11"/>
        <text y="30" dx="${dx}" text-anchor="${anchor}">${
          esc(label.length > 17 ? label.slice(0, 16) + "…" : label)}</text>
        <title>${esc(n.key)} · ${esc(t(n.state, n.state))}</title>
      </g>`;
  }).join("");

  host.innerHTML =
    `<svg viewBox="0 0 ${size} ${size}" role="img"
          aria-label="Blast radius: ${nodes.length} records across ${maxDepth} hops">
       ${rings}${marks}
     </svg>`;

  const counts = {
    affected: nodes.filter((n) => n.contaminated && !repaired.has(n.key)).length,
    repaired: nodes.filter((n) => repaired.has(n.key)).length,
    held: nodes.filter((n) => quarantined.has(n.key)).length,
  };
  $("blast-legend").innerHTML =
    `<span class="blast-hint">Each ring is one step further from the original error</span>
     <span class="blast-key is-seed"><i></i>Original error</span>
     <span class="blast-key is-affected"><i></i>Affected (${counts.affected})</span>
     <span class="blast-key is-repaired"><i></i>Rebuilt (${counts.repaired})</span>
     <span class="blast-key is-held"><i></i>Held (${counts.held})</span>`;
}

/* ================= COMPLIANCE & REVIEW =================
 * Two duties, one desk: prove nothing clinical crossed a boundary it should
 * not have, and decide the records the system refused to guess at. The data
 * boundary is drawn as a literal wall so the claim is checkable by eye.
 */
function initAssuranceView() {
  if (!STATE.assuranceReady) {
    STATE.assuranceReady = true;
    $("assurance-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-panel]");
      if (btn) showAssurancePanel(btn.dataset.panel);
    });
    $("btn-assurance-queue-refresh").addEventListener("click", loadAssuranceQueue);
    $("btn-assurance-trail-refresh").addEventListener("click", loadAssuranceTrail);
    $("btn-assurance-privacy").addEventListener("click", runAssurancePrivacy);
  }
  renderBoundary();
  loadAssuranceQueue();
  renderAssuranceRollup();
}

function showAssurancePanel(name) {
  document.querySelectorAll("#assurance-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.panel === name));
  document.querySelectorAll(".assurance-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `assurance-${name}`));
  if (name === "trail") loadAssuranceTrail();
  if (name === "queue") loadAssuranceQueue();
}

async function renderAssuranceRollup() {
  try {
    const q = await api("/api/review/queue");
    const total = q.total_count ?? q.count;
    const rec = STATE.lastRecovery;
    const exported = rec ? "none" : "—";
    $("assurance-rollup").innerHTML =
      `<div class="rollup ${total ? "is-alert" : "is-calm"}">
         <div class="rollup-figure">${total}</div>
         <div class="rollup-copy">
           <strong>${total === 1 ? "item needs review" : "items need review"}</strong>
           <span>Clinical content exported: ${esc(exported)}</span>
         </div>
       </div>`;
  } catch (e) { $("assurance-rollup").innerHTML = ""; }
}

/* The wall: what stays inside a runtime vs the fields that cross. */
const NEVER_LEAVES = [
  "Patient name", "MRN", "Date of birth", "Clinical notes",
  "Laboratory values", "Diagnoses", "Model hidden state", "KV cache",
];

/* The capsule schema, as the released-field audit reports it. The dashboard's
 * /api/recover projection deliberately reports sketch_dim and
 * support_token_count instead of the sketch and tokens themselves, so it must
 * NOT be used to describe the boundary - that would overstate what crosses and
 * disagree with the recovery certificate. */
const RELEASED_FIELDS = [
  "artifact_type_band", "capsule_id", "expires_at", "incident_id", "issued_at",
  "issuer", "nonce", "patient_token", "purpose", "recipient",
  "seed_commitment", "sketch", "support_tokens", "time_band",
];

function renderBoundary() {
  const rec = STATE.lastRecovery;

  $("boundary-diagram").innerHTML =
    `<div class="boundary">
       <div class="boundary-side inside">
         <div class="boundary-head">
           <span class="boundary-tag good">Stays inside the runtime</span>
           <strong>${NEVER_LEAVES.length} kinds of clinical content</strong>
         </div>
         <ul>${NEVER_LEAVES.map((f) =>
           `<li><span aria-hidden="true">■</span>${esc(f)}</li>`).join("")}</ul>
       </div>
       <div class="boundary-wall" aria-hidden="true">
         <span class="boundary-wall-label">POLICY BOUNDARY</span>
       </div>
       <div class="boundary-side outside">
         <div class="boundary-head">
           <span class="boundary-tag accent">Crosses to the coordinator</span>
           <strong>${RELEASED_FIELDS.length} metadata fields</strong>
         </div>
         <ul>${RELEASED_FIELDS.map((f) =>
           `<li><span aria-hidden="true">□</span>${esc(f.replace(/_/g, " "))}</li>`).join("")}</ul>
       </div>
     </div>`;

  const out = $("boundary-detail");
  out.innerHTML = "";
  out.appendChild(el("div", "notice good",
    `<b>No clinical content has a field to travel in.</b> The capsule schema defines
     ${RELEASED_FIELDS.length} fields; none of them carries a name, an identifier, a
     note, or a measured value. Each capsule additionally carries a signature that
     binds these fields, and nothing else.`));

  if (!rec) {
    out.appendChild(el("p", "small muted",
      "Showing the declared schema. Run a recovery from Incident Command to audit " +
      "the capsules actually issued in this session."));
    return;
  }

  const bytes = rec.capsules.reduce((sum, c) => sum + (c.size_bytes || 0), 0);
  out.appendChild(el("div", "notice info",
    `<b>${esc(rec.capsules.length)} capsule(s) issued in this session</b>,
     ${esc(bytes)} bytes of metadata in total. The recovery certificate lists the
     same ${RELEASED_FIELDS.length} fields.`));
  out.appendChild(el("h4", "record-section", "Capsules issued this session"));
  out.appendChild(table(rec.capsules.slice(0, 12), [
    { key: "recipient", label: "Sent to" },
    { key: "purpose", label: "Purpose" },
    { key: "patient_token", label: "Patient token",
      render: (c) => `<span class="mono">${esc(String(c.patient_token).slice(0, 16))}…</span>` },
    { key: "artifact_type_band", label: "Type band" },
    { key: "size_bytes", label: "Bytes", num: true },
  ]));
  out.appendChild(el("p", "small muted",
    "The sketch and support tokens are counted, never displayed — the dashboard " +
    "sees a dimension and a count, not the values."));
}

async function loadAssuranceQueue() {
  const out = $("assurance-queue-result");
  out.innerHTML = '<div class="loading-row"><span class="spinner"></span>Loading queue…</div>';
  try {
    const r = await api("/api/review/queue");
    out.innerHTML = "";
    if (!(r.total_count ?? r.count)) {
      out.appendChild(el("div", "empty-teach",
        `<strong>Nothing is waiting on you.</strong>
         <span>The system only escalates a record when it cannot rebuild it safely.
           An empty queue means every affected record was either rebuilt from source
           data or confirmed unaffected.</span>`));
      renderAssuranceRollup();
      return;
    }
    (r.registry_items || []).forEach((item) => {
      const card = el("div", "queue-card");
      card.innerHTML = `<div class="queue-head"><strong>${item.kind === "automatic" ? "Automatic identity check" : "Manual concern"}</strong><span class="mono muted">${esc(item.patient_id)}</span></div>
        <div class="queue-reason"><span aria-hidden="true">!</span><span>${esc(item.description)}</span></div>
        <div class="queue-actions"><span class="mono small muted">${esc(item.record_key || "Patient-wide concern")}</span><span class="small muted">Observation recorded: ${esc(item.observed_at || "Date not recorded")}</span></div>`;
      if (item.kind === "manual") {
        const form = el("form", "queue-actions registry-review-form");
        form.innerHTML = `<label>Review note<textarea required minlength="10" maxlength="1000" placeholder="What source did you check, and what did you find?"></textarea></label><button class="btn small" type="submit" value="resolve">Mark addressed</button><button class="btn small ghost" type="submit" value="dismiss">Dismiss as unfounded</button><span class="form-result" aria-live="polite"></span>`;
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const result = form.querySelector(".form-result");
          try {
            const decision = event.submitter?.value === "dismiss" ? "dismiss" : "resolve";
            await api(`/api/registry/reports/${item.report_id}/${decision}`, {
              method: "POST", body: JSON.stringify({ note: form.querySelector("textarea").value }),
            });
            toast(decision === "resolve" ? "Concern marked addressed" : "Concern dismissed", { kind: "good" });
            await loadAssuranceQueue();
          } catch (error) { result.textContent = error.message; }
        });
        card.appendChild(form);
      } else {
        card.appendChild(el("p", "small muted queue-guidance",
          `Current chart: ${esc(item.patient_id)} · Verified FHIR source chart: ${esc(item.source_patient_id)}. This only corrects the synthetic chart association; it does not assess clinical accuracy or close any nurse concern.`));
        const form = el("form", "queue-actions registry-review-form");
        form.innerHTML = `<label>Source verification note<textarea required minlength="10" maxlength="1000" placeholder="Describe how you verified the FHIR patient reference"></textarea></label><button class="btn small" type="submit">Correct chart association</button><span class="form-result" aria-live="polite"></span>`;
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const result = form.querySelector(".form-result");
          try {
            const correction = await api("/api/registry/corrections", {
              method: "POST", body: JSON.stringify({ record_key: item.record_key, note: form.querySelector("textarea").value }),
            });
            toast("Chart association corrected", { detail: `${correction.from_patient_id} → ${correction.to_patient_id}. Review the nurse concern separately.`, kind: "good" });
            await loadAssuranceQueue();
          } catch (error) { result.textContent = error.message; }
        });
        card.appendChild(form);
      }
      out.appendChild(card);
    });
    r.items.forEach((item) => {
      const card = el("div", "queue-card");
      card.innerHTML =
        `<div class="queue-head">
           <div>
             <strong>${esc(String(item.memory_id))}</strong>
             <span class="mono muted">v${esc(item.version)}</span>
           </div>
           <span class="badge quarantined">${esc(t("quarantined", "held"))}</span>
         </div>
         <div class="queue-reason">
           <span aria-hidden="true">!</span>
           ${esc(item.quarantine_reason || "Could not be rebuilt safely.")}
         </div>
         <details><summary>Show the record content</summary>
           <pre class="cert">${esc(item.content)}</pre></details>`;
      const row = el("div", "queue-actions");
      [["approve", "Approve", "good"], ["reject", "Reject", "danger"],
       ["keep_quarantined", "Keep held", "ghost"]].forEach(([decision, label, kind]) => {
        const b = el("button", `btn small ${kind === "danger" ? "danger" : "ghost"}`, esc(label));
        b.addEventListener("click", async () => {
          try {
            await api("/api/review", {
              method: "POST",
              body: JSON.stringify({
                memory_key: `${item.memory_id}@v${item.version}`, decision }),
            });
            toast(`Recorded: ${label.toLowerCase()}`, { detail: item.memory_id, kind: "good" });
          } catch (err) {
            toast("Decision failed", { detail: err.message, kind: "bad" });
          }
          loadAssuranceQueue();
        });
        row.appendChild(b);
      });
      card.appendChild(row);
      out.appendChild(card);
    });
    renderAssuranceRollup();
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  }
}

async function runAssurancePrivacy() {
  const sel = $("as-incident");
  const incident_id = sel.value;
  const out = $("assurance-privacy-result");
  if (!incident_id) {
    out.innerHTML = `<div class="empty-teach"><strong>No incident to test.</strong>
      <span>A safety officer must run a recovery before the interface can be attacked.</span></div>`;
    return;
  }
  const btn = $("btn-assurance-privacy");
  btn.disabled = true;
  out.innerHTML = '<div class="loading-row"><span class="spinner"></span>Attacking our own interface…</div>';
  try {
    const r = await api(`/api/privacy/${encodeURIComponent(incident_id)}`);
    out.innerHTML = "";
    const attacks = ["attribute_gender", "attribute_restricted", "membership", "linkability"]
      .map((k) => r[k]).filter(Boolean);
    out.appendChild(table(attacks, [
      { key: "name", label: "Test", wrap: true },
      { key: "accuracy", label: "Attack result", num: true, render: (a) => fmt(a.accuracy) },
      { key: "baseline", label: "Guessing", num: true, render: (a) => fmt(a.baseline) },
      { key: "verdict", label: "Verdict",
        render: (a) => a.advantage > 0.05
          ? `<span class="badge suspected">learns something</span>`
          : `<span class="badge active">no better than chance</span>` },
    ]));
    const mem = r.membership || {};
    if (mem.advantage > 0.05) {
      out.appendChild(el("div", "notice warn",
        `<b>One test does learn something, and we report it.</b> An attacker holding a
         capsule can tell better than chance whether a record was in the candidate set
         (${fmt(mem.accuracy)} against ${fmt(mem.baseline)} guessing). The claim this
         system makes is narrower: raw clinical content is never exported. The field
         audit on the Data boundary tab is the evidence for that claim.`));
    }
    const rf = r.released_fields || {};
    out.appendChild(el("div", rf.raw_content_exported ? "notice bad" : "notice good",
      `Clinical content exported through the recovery interface:
       <b>${rf.raw_content_exported ? "YES" : "NONE"}</b>
       (${esc(rf.capsules)} capsules, ${esc(rf.total_bytes)} bytes of metadata).`));
  } catch (e) {
    out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; }
}

async function loadAssuranceTrail() {
  const log = $("assurance-log");
  try {
    const r = await api("/api/events?limit=300");
    log.innerHTML = "";
    if (!r.events.length) {
      log.innerHTML = '<span class="muted">No events recorded yet.</span>';
      return;
    }
    r.events.forEach((e) => {
      log.appendChild(el("div", "row",
        `<span class="muted">${esc(String(e.at).slice(11, 23))}</span>
         <span class="actor">${esc(e.actor)}</span>
         <span class="kind">${esc(e.kind)}</span>
         <span class="subject">${esc(e.subject ?? "")}</span>`));
    });
  } catch (e) {
    log.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}

/* ================= GUIDED TOUR =================
 * Coach marks on the real interface, not a separate slideshow, and only on a
 * role's first visit. Replayable from the header, dismissible at any point.
 */
const TOURS = {
  clinician: [
    ["#records-rollup", "Start with the review count",
     "This count tells you how many synthetic patient charts have a detected issue or a concern waiting for review."],
    ["#records-search", "Find the right patient",
     "Search by name, synthetic patient ID, or MRN. The Needs review filter keeps urgent charts at the top."],
    ["#records-detail", "Read the status, then choose a task",
     "Start with the short summary. Records, Handover, and Report a concern each have their own view."],
    ["#chat-toggle", "Ask AEGIS when you are unsure",
     "Ask for an explanation or the safest next step. AEGIS can guide you, but it cannot approve a held record for you."],
  ],
  safety: [
    ["#command-status", "Containment status",
     "One line telling you whether an incident is open and whether it has been contained."],
    [".command-setup", "Report and respond",
     "In production this is triggered by a reported error. Report one here, then start recovery to watch the four stages run."],
    ["#blast-radius", "The blast radius",
     "Each ring is one hop away from the original mistake. Red is still affected, teal has been rebuilt, amber is held for a human."],
  ],
  compliance: [
    ["#assurance-tabs", "Two duties, one desk",
     "Audit what crossed the boundary, clear the review queue, run the leakage tests, and read the audit trail."],
    ["#boundary-diagram", "The boundary",
     "Left of the wall never leaves the runtime. Right of the wall is everything the coordinator received - metadata only."],
    ["#assurance-rollup", "What needs you",
     "The count is records the system refused to guess at. Those are the ones that need a human decision."],
  ],
  researcher: [
    ["#tabs", "The full console",
     "Every research surface: paired baselines, the provenance matrix, privacy attacks, and the hash-bound evidence package."],
  ],
};

const TOUR_KEY = "aegis-tours-seen";
function seenTours() {
  try { return JSON.parse(localStorage.getItem(TOUR_KEY) || "[]"); }
  catch (e) { return []; }
}
function markTourSeen(id) {
  try {
    const seen = new Set(seenTours());
    seen.add(id);
    localStorage.setItem(TOUR_KEY, JSON.stringify([...seen]));
  } catch (e) { /* storage blocked */ }
}

const TOUR = { steps: [], at: 0, id: null };

function startTour(id, { force = false } = {}) {
  const steps = TOURS[id];
  if (!steps || (!force && seenTours().includes(id))) return;
  TOUR.steps = steps;
  TOUR.at = 0;
  TOUR.id = id;
  // Let the role's views paint before anchoring to them.
  window.setTimeout(() => showTourStep(), 650);
}

function showTourStep() {
  const step = TOUR.steps[TOUR.at];
  if (!step) return endTour();
  const [selector, title, body] = step;
  const target = document.querySelector(selector);
  if (!target) { TOUR.at += 1; return showTourStep(); }

  document.querySelectorAll(".coach-target").forEach((n) =>
    n.classList.remove("coach-target"));
  target.classList.add("coach-target");
  target.scrollIntoView({ behavior: "smooth", block: "center" });

  $("coach-step").textContent = `${TOUR.at + 1} of ${TOUR.steps.length}`;
  $("coach-title").textContent = title;
  $("coach-body").textContent = body;
  $("coach-next").textContent =
    TOUR.at === TOUR.steps.length - 1 ? "Got it" : "Next";
  $("coach").hidden = false;

  // Park the card near the target without covering it.
  window.setTimeout(() => {
    const card = $("coach-card");
    const box = target.getBoundingClientRect();
    const below = box.bottom + 18;
    const fits = below + card.offsetHeight < window.innerHeight - 12;
    card.style.top = `${fits ? below : Math.max(12, box.top - card.offsetHeight - 18)}px`;
    card.style.left = `${Math.min(
      Math.max(16, box.left),
      window.innerWidth - card.offsetWidth - 16)}px`;
  }, 320);
}

function endTour() {
  $("coach").hidden = true;
  document.querySelectorAll(".coach-target").forEach((n) =>
    n.classList.remove("coach-target"));
  if (TOUR.id) markTourSeen(TOUR.id);
}

function initTour() {
  $("coach-next").addEventListener("click", () => { TOUR.at += 1; showTourStep(); });
  $("coach-skip").addEventListener("click", endTour);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("coach").hidden) endTour();
  });
}

/* ================= ASSISTANT =================
 * A chat surface that drives the console. The reply text and every number in
 * it come from the server, which computed them from the real environment; the
 * language model only ever chose which action to take. That is why nothing
 * here can show a hallucinated clinical value.
 */
function assistantSessionId() {
  const key = "aegis-operator-session";
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() :
        `operator-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch (e) {
    return `operator-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

const CHAT = {
  open: false,
  busy: false,
  initialized: false,
  history: [],
  sessionId: assistantSessionId(),
  lastResult: null,
};

function renderAssistantWelcome() {
  const clinician = currentRole() === "clinician";
  $("chat-log").innerHTML =
    `<div class="chat-msg is-bot"><div class="chat-bubble">${clinician
      ? "Ask me to explain a patient status, show who needs attention, or tell you the safest next step. I cannot diagnose or approve a held record."
      : "Tell me the situation or the outcome you need. I will inspect live state, propose the safest next action, and verify what changed."}</div>` +
    `<div class="chat-meta">${clinician
      ? "plain-language guide · grounded in current synthetic records"
      : "deterministic tools · explicit approval · grounded results"}</div></div>`;
  CHAT.history = [];
  CHAT.lastResult = null;
}

function resetOperatorConversation(reason) {
  const log = $("chat-log");
  if (!log) return;
  // Patient and incident answers are snapshots of mutable state. Keeping them
  // visually active after a reset makes an old answer look current, so replace
  // the transcript with an explicit boundary and immediately re-prime it.
  log.innerHTML =
    `<div class="chat-msg is-bot"><div class="chat-bubble">${esc(reason)}</div>` +
    '<div class="chat-meta">new workspace state · previous clinical answers cleared</div></div>';
  CHAT.lastResult = null;
  CHAT.history = [];
  renderSuggestions();
  loadOperatorCases();
}

const CHAT_SUGGESTIONS = {
  clinician: ["Show the case inbox", "Which patients need attention?",
              "What does 'corrected' mean?"],
  safety: ["Show the case inbox", "We registered the wrong patient",
           "How far did it spread?"],
  compliance: ["Show the case inbox", "What's waiting for me?",
               "Run the leakage tests"],
  researcher: ["Show the case inbox", "We registered the wrong patient",
               "What is benign-state retention?"],
};

function initChat() {
  CHAT.initialized = true;
  $("chat-toggle").addEventListener("click", toggleChat);
  $("chat-close").addEventListener("click", () => toggleChat(false));
  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendChat($("chat-input").value);
  });
  $("chat-suggestions").addEventListener("click", (e) => {
    const chip = e.target.closest("button[data-say]");
    if (chip) sendChat(chip.dataset.say);
  });
  $("operator-inbox-toggle").addEventListener("click", () => {
    const inbox = $("operator-inbox");
    inbox.hidden = !inbox.hidden;
    $("operator-inbox-toggle").setAttribute("aria-expanded", inbox.hidden ? "false" : "true");
    if (!inbox.hidden) loadOperatorCases();
  });
  $("operator-inbox-refresh").addEventListener("click", loadOperatorCases);
  $("operator-case-list").addEventListener("click", (e) => {
    const card = e.target.closest("button[data-case-id]");
    if (card) sendChat(`open case ${card.dataset.caseId}`);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && CHAT.open) toggleChat(false);
  });
  renderAssistantWelcome();
  renderSuggestions();
  refreshChatBudget();
  if ($("role-gate").hidden) primeChat();
  loadOperatorCases();
  updateOperatorContext();
}

/* Open with what is actually true, not a generic greeting. The assistant should
 * already know whether anything needs the user before they ask. */
async function primeChat() {
  try {
    const r = await api("/api/assistant", {
      method: "POST",
      body: JSON.stringify({ message: "what is going on", role: currentRole(),
                             session_id: CHAT.sessionId }),
    });
    if (r.reply) {
      chatBubble(r.reply, "bot", "current state");
      renderChatNext(r.suggestions || []);
    }
    CHAT.lastResult = r;
    updateOperatorContext(r);
    if (r.budget) renderChatBudget(r.budget);
  } catch (e) { /* the static opener already covers this */ }
}

function toggleChat(force) {
  CHAT.open = force === undefined ? !CHAT.open : force;
  $("chat-panel").hidden = !CHAT.open;
  $("chat-toggle").setAttribute("aria-expanded", CHAT.open ? "true" : "false");
  document.body.classList.toggle("operator-open", CHAT.open);
  if (CHAT.open) {
    window.setTimeout(() => $("chat-input").focus(), 80);
  }
}

function renderSuggestions() {
  const list = CHAT_SUGGESTIONS[currentRole()] || CHAT_SUGGESTIONS.researcher;
  $("chat-suggestions").innerHTML = list.map((s) =>
    `<button type="button" data-say="${esc(s)}">${esc(s)}</button>`).join("");
}

function chatBubble(text, who, meta) {
  const row = el("div", `chat-msg is-${who}`);
  row.innerHTML = `<div class="chat-bubble">${esc(text)}</div>` +
    (meta ? `<div class="chat-meta">${esc(meta)}</div>` : "");
  $("chat-log").appendChild(row);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return row;
}

/* What the assistant actually did, in order. */
function renderChatSteps(row, steps) {
  const list = el("ol", "chat-steps");
  steps.forEach((step) => list.appendChild(el("li", null, esc(step))));
  row.querySelector(".chat-bubble").appendChild(list);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

/* Next steps the server says make sense from here. Replaces the static
 * suggestion chips once a conversation has started, so the assistant leads. */
function renderChatNext(suggestions) {
  const host = $("chat-suggestions");
  if (!suggestions.length) { renderSuggestions(); return; }
  host.innerHTML = suggestions.map((s) =>
    `<button type="button" data-say="${esc(s.message)}" ${
      s.message === "yes" ? 'data-intent="approve"' :
      s.message === "no" ? 'data-intent="cancel"' : ""}>${esc(s.label)}</button>`).join("");
}

function renderChatPlan(plan) {
  const card = el("article", `operator-plan${
    plan.risk === "destructive" ? " is-destructive" : ""}`);
  card.setAttribute("aria-label", `Proposed plan: ${plan.title}`);
  card.innerHTML =
    `<div class="operator-plan-head">
       <div><div class="operator-plan-kicker">Proposed execution plan</div>
         <h4>${esc(plan.title)}</h4></div>
       <span class="operator-risk">${esc(plan.risk)}</span>
     </div>
     <p class="operator-plan-summary">${esc(plan.summary)}</p>
     <div class="operator-plan-scope"><span>Scope</span>${esc(plan.scope)}</div>
     <ol>${(plan.steps || []).map((step) => `<li>${esc(step)}</li>`).join("")}</ol>`;
  $("chat-log").appendChild(card);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

function renderCaseBrief(caseData) {
  const card = el("article", "operator-case-brief");
  card.innerHTML =
    `<div class="operator-plan-kicker">Case timeline</div>
     <div class="operator-case-brief-head"><div><strong>${esc(caseData.title)}</strong>
       <span>${esc(caseData.case_id)}</span></div>
       <b class="operator-case-status">${esc(caseData.status.replace(/_/g, " "))}</b></div>
     <p>${esc(caseData.next_action)}</p>
     <ol>${(caseData.timeline || []).map((event) =>
       `<li><i class="is-${esc(event.stage)}"></i><span><b>${esc(event.label)}</b>` +
       `<small>${esc(event.actor)} · ${esc(String(event.at || "").slice(11, 19))}</small></span></li>`
     ).join("")}</ol>`;
  $("chat-log").appendChild(card);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

async function loadOperatorCases() {
  const host = $("operator-case-list");
  if (!host) return;
  try {
    const data = await api(`/api/cases?role=${encodeURIComponent(currentRole())}`);
    $("operator-inbox-count").textContent = data.attention || data.count || 0;
    if (!data.cases.length) {
      host.innerHTML = '<div class="operator-case-empty">No cases are open. The workspace is clear.</div>';
      return;
    }
    host.innerHTML = data.cases.map((item) =>
      `<button class="operator-case is-${esc(item.status)}" type="button" data-case-id="${esc(item.case_id)}">
         <span><strong>${esc(item.title)}</strong><span class="operator-case-id">${esc(item.case_id)} · owner ${esc(item.owner)}</span></span>
         <b class="operator-case-status">${esc(item.status.replace(/_/g, " "))}</b>
         <span class="operator-case-next">${esc(item.next_action)}</span>
       </button>`).join("");
  } catch (e) {
    host.innerHTML = `<div class="operator-case-empty">Case inbox unavailable: ${esc(e.message)}</div>`;
  }
}

function settlePendingPlan(label, kind) {
  const cards = $("chat-log").querySelectorAll(".operator-plan:not(.is-settled)");
  const card = cards[cards.length - 1];
  if (!card) return;
  card.classList.add("is-settled", `is-${kind}`);
  card.appendChild(el("div", "operator-plan-result", esc(label)));
}

function updateOperatorContext(result) {
  const title = $("operator-context-title");
  const detail = $("operator-context-state");
  if (!title || !detail) return;
  title.textContent = role().context;
  if (result?.requires_confirmation) {
    detail.textContent = "Plan ready · waiting for explicit approval";
  } else if (result?.ui?.recovered) {
    detail.textContent = "Recovery executed · verification complete";
  } else if (result?.state?.open_incidents) {
    detail.textContent = `${result.state.open_incidents} open incident(s) · containment required`;
  } else if (result?.state?.queue) {
    detail.textContent = `${result.state.queue} decision(s) waiting for a person`;
  } else if (CHAT.busy) {
    detail.textContent = "Inspecting state and selecting an authorised action…";
  } else {
    detail.textContent = "Standing by · grounded in current workspace state";
  }
}

async function sendChat(message) {
  message = String(message || "").trim();
  if (!message || CHAT.busy) return;
  CHAT.busy = true;
  updateOperatorContext();
  $("chat-input").value = "";
  chatBubble(message, "user");

  const thinking = el("div", "chat-msg is-bot");
  thinking.innerHTML = '<div class="chat-bubble"><span class="chat-dots"><i></i><i></i><i></i></span></div>';
  $("chat-log").appendChild(thinking);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;

  try {
    const r = await api("/api/assistant", {
      method: "POST",
      body: JSON.stringify({ message, role: currentRole(),
                             session_id: CHAT.sessionId }),
    });
    CHAT.lastResult = r;
    thinking.remove();
    if (String(r.source || "").includes("confirmed")) {
      settlePendingPlan("Approved · execution completed", "approved");
    } else if (/^(no|nope|cancel|stop)$/i.test(message) && r.action === "none") {
      settlePendingPlan("Cancelled · no changes made", "cancelled");
    }
    // "local" and "glossary" cost nothing; only "model" spends a token.
    const badge = r.source.startsWith("model") ? "interpreted by Gemini" : "answered locally";
    const blockedRoleChange = r.ui?.role && r.ui.role !== currentRole();
    const reply = blockedRoleChange
      ? `This session is locked to ${role().label}. I cannot move you into another role. End this session from the workspace menu, then choose the correct role at login.`
      : (r.reply || "Done.");
    const bubble = chatBubble(reply, "bot", blockedRoleChange ? "role boundary enforced" : badge);
    if (r.plan && !blockedRoleChange) renderChatPlan(r.plan);
    if (r.case && !blockedRoleChange) renderCaseBrief(r.case);
    // A multi-step action shows its working, so the user sees what was done on
    // their behalf rather than being told it happened.
    if (r.steps?.length && !blockedRoleChange) renderChatSteps(bubble, r.steps);
    await applyChatUi(r.ui || {});
    renderChatNext(blockedRoleChange ? [] : (r.suggestions || []));
    updateOperatorContext(r);
    if (r.budget) renderChatBudget(r.budget);
    loadOperatorCases();
  } catch (e) {
    thinking.remove();
    chatBubble(`Something went wrong: ${e.message}`, "bot", "error");
  } finally {
    CHAT.busy = false;
    updateOperatorContext(CHAT.lastResult);
    $("chat-input").focus();
  }
}

/* The server tells us where to go; the views then load their own real data. */
async function applyChatUi(ui) {
  if (ui.role && ui.role !== currentRole()) {
    $("urgent-announcer").textContent =
      `Role change blocked. This session remains in the ${role().label} workspace.`;
    return;
  }
  if (ui.reset) {
    STATE.commandIncident = null;
    STATE.commandRecovery = null;
    STATE.lastRecovery = null;
    STATE.selectedPatient = null;
    resetOperatorConversation(
      "Workspace reset. Previous answers no longer describe the live sandbox.");
  }
  if (ui.incident_id) {
    try {
      STATE.commandIncident = await api(
        `/api/incidents/${encodeURIComponent(ui.incident_id)}`);
      if (ui.recovered) {
        // The assistant ran the recovery server-side, so it hands back the same
        // payload the button would have produced. Without this the field stays
        // red while the reply says it is contained.
        STATE.commandRecovery = ui.recovery || STATE.lastRecovery;
        STATE.lastRecovery = STATE.commandRecovery;
      } else {
        STATE.commandRecovery = null;
      }
      if (STATE.commandReady) {
        renderBlastRadius(STATE.commandIncident, STATE.commandRecovery);
        renderCommandStatus();
        if (STATE.commandRecovery) renderCommandOutcome(STATE.commandRecovery);
        $("btn-cmd-recover").disabled = !!STATE.commandRecovery;
      }
    } catch (e) { /* the view will reload it */ }
  }
  if (ui.view && role().views.includes(ui.view)) {
    activateView(ui.view, { scroll: false });
  } else if (ui.view) {
    $("urgent-announcer").textContent = "That view is not available in this role.";
  }
  if (ui.panel && currentRole() === "compliance") showAssurancePanel(ui.panel);
  if (ui.patient && currentRole() === "clinician") {
    STATE.selectedPatient = ui.patient;
    if ($("view-records").classList.contains("active")) await loadPatients(ui.patient);
  }
  if (ui.run && currentRole() === "compliance" && $("btn-assurance-privacy")) {
    if (ui.incident_id) $("as-incident").value = ui.incident_id;
    runAssurancePrivacy();
  }
  if (ui.refresh) await refreshIncidents();
}

async function refreshChatBudget() {
  try { renderChatBudget(await api(
    `/api/assistant/status?session_id=${encodeURIComponent(CHAT.sessionId)}`)); }
  catch (e) { /* status is optional */ }
}

function renderChatBudget(b) {
  const total = b.model_calls + b.local_hits;
  const pct = total ? Math.round(b.free_share * 100) : 100;
  $("chat-budget").innerHTML = b.configured
    ? `${pct}% answered locally · ${b.model_calls}/${b.max_calls} model calls used`
    : `Answering locally · set GEMINI_API_KEY for free-form phrasing`;
}
