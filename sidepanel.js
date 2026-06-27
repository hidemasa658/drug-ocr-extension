const API_BASE = "https://okusuri.duckdns.org";
const MAX_LOGS = 100;

const $ = (id) => document.getElementById(id);

let logs = [];
let debugMode = false;
let apiToken = ""; // 起動時に chrome.storage.local から復元

// ---- API fetch (x-extension-token ヘッダ自動付与 + 403 ハンドリング) ----
async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (apiToken) headers["x-extension-token"] = apiToken;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 403) {
    if (!apiToken) {
      log("warn", "api-403", `${url}\nAPIトークン未設定。設定パネルで貼り付けてください`);
    } else {
      log("warn", "api-403", `${url}\nトークンが無効。管理者に新トークンを依頼してください`);
    }
  }
  return res;
}

async function loadApiToken() {
  try {
    const s = await chrome.storage.local.get(["apiToken"]);
    apiToken = (s.apiToken || "").trim();
  } catch (e) {
    apiToken = "";
  }
  renderTokenStatus();
}

async function saveApiToken(t) {
  apiToken = (t || "").trim();
  try { await chrome.storage.local.set({ apiToken }); } catch {}
  renderTokenStatus();
}

function renderTokenStatus() {
  const el = $("apiTokenStatus");
  const input = $("apiTokenInput");
  if (!el || !input) return;
  // 入力欄は今のtokenの長さだけマスク表示
  if (apiToken) {
    input.value = "•".repeat(Math.min(apiToken.length, 32));
    el.textContent = `保存済 (長さ ${apiToken.length})`;
    el.style.color = "#2e7d32";
  } else {
    input.value = "";
    el.textContent = "未設定（店舗Wi-Fi等のIP許可リスト外PCでは必須）";
    el.style.color = "#666";
  }
}

// ---- Logging ----
function log(level, message, data) {
  const entry = {
    ts: Date.now(),
    level,
    message,
    data: data != null ? String(data).slice(0, 500) : null,
  };
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  chrome.storage.local.set({ logs }).catch(() => {});
  if (debugMode || level !== "info") {
    const fn = level === "err" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[drug-ocr] ${message}`, data ?? "");
  }
  renderLogs();
}

function renderLogs() {
  const list = $("logList");
  const count = $("logCount");
  if (!list || !count) return;
  count.textContent = String(logs.length);
  list.innerHTML = "";
  for (const l of logs) {
    const li = document.createElement("li");
    if (l.level === "err") li.classList.add("err");
    if (l.level === "warn") li.classList.add("warn");
    const t = document.createElement("span");
    t.className = "log-list__time";
    t.textContent = new Date(l.ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    li.appendChild(t);
    li.appendChild(document.createTextNode(l.message + (l.data ? " | " + l.data : "")));
    list.appendChild(li);
  }
}

// ---- Toast ----
function showToast(msg, err) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  setTimeout(() => { t.className = "toast" + (err ? " err" : ""); }, 1500);
}

// ---- Fetch ----
async function fetchRecords() {
  try {
    const res = await apiFetch(`${API_BASE}/records`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderHistory(data.records || []);
    $("error").classList.add("hidden");
    if (debugMode) log("info", "fetched", `count=${(data.records || []).length}`);
  } catch (e) {
    $("error").classList.remove("hidden");
    $("error").textContent = `データ取得失敗: ${e.message}  (okusuri.duckdns.org にアクセスできるネットワークか確認してください)`;
    log("err", "fetchRecords", e.message);
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return "たった今";
  if (diffMin < 60) return `${diffMin}分前`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---- Paste to active tab (injected into target page) ----
function injectPaste(text) {
  try {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, reason: "フォーカス中の入力欄なし" };
    const tag = el.tagName;
    const isInput = tag === "INPUT" || tag === "TEXTAREA";
    const isCE = el.isContentEditable;
    if (!isInput && !isCE) return { ok: false, reason: `対象が入力欄ではない(${tag})` };

    if (isCE) {
      document.execCommand("insertText", false, text);
    } else {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const newVal = el.value.slice(0, start) + text + el.value.slice(end);
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, newVal);
      } else {
        el.value = newVal;
      }
      try {
        el.selectionStart = el.selectionEnd = start + text.length;
      } catch (_) {}
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "例外:" + String(e).slice(0, 100) };
  }
}

async function pasteToActiveTab(text) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("アクティブなタブがありません");

  const url = tab.url || "";
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension):/i.test(url)) {
    throw new Error(`このページには書き込めません(${url.split(":")[0]}:)`);
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: injectPaste,
      args: [text],
    });
  } catch (e) {
    throw new Error(`スクリプト注入失敗: ${e.message}`);
  }

  const success = results.find((r) => r.result && r.result.ok);
  if (success) {
    if (debugMode) log("info", "pasted", `text="${text.slice(0, 30)}" tab=${tab.id}`);
    return;
  }
  const reasons = results.map((r) => r.result?.reason).filter(Boolean);
  throw new Error(reasons[0] || "貼付できませんでした");
}

// ---- Rendering ----
function renderHistory(records) {
  const container = $("history");
  container.innerHTML = "";
  if (records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "まだ送信がありません";
    container.appendChild(empty);
    return;
  }
  for (const r of records) {
    container.appendChild(makeHistoryCard(r));
  }
}

function makeHistoryCard(r) {
  const card = document.createElement("div");
  card.className = "history-card open"; // 初期は開いた状態で表示（拡張はコンパクトなので）

  const toggle = document.createElement("button");
  toggle.className = "history-card__toggle";
  toggle.type = "button";

  const time = document.createElement("span");
  time.className = "history-card__time";
  time.textContent = formatTime(r.created_at);
  toggle.appendChild(time);

  if (r.sender_label || r.sender_ip) {
    const sender = document.createElement("span");
    sender.className = "history-card__sender";
    sender.textContent = r.sender_label || r.sender_ip;
    toggle.appendChild(sender);
  }

  const summary = document.createElement("span");
  summary.className = "history-card__summary";
  summary.textContent = `${r.drugs.length}件`;
  toggle.appendChild(summary);

  const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chev.setAttribute("class", "history-card__chevron");
  chev.setAttribute("viewBox", "0 0 16 16");
  chev.setAttribute("fill", "none");
  chev.innerHTML = '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  toggle.appendChild(chev);

  toggle.addEventListener("click", () => card.classList.toggle("open"));
  card.appendChild(toggle);

  const body = document.createElement("div");
  body.className = "history-card__body";
  const inner = document.createElement("div");
  inner.className = "history-card__inner";
  const ul = document.createElement("ul");
  ul.className = "drug-list";
  for (const d of r.drugs) {
    ul.appendChild(makeDrugItem(d));
  }
  inner.appendChild(ul);
  body.appendChild(inner);
  card.appendChild(body);

  return card;
}

function makeDrugItem(drug) {
  const li = document.createElement("li");
  li.className = "drug-item";

  const name = document.createElement("span");
  name.className = "drug-item__name";
  name.textContent = drug;
  li.appendChild(name);

  const btns = document.createElement("span");
  btns.className = "drug-item__btns";

  const copyBtn = document.createElement("button");
  copyBtn.className = "drug-btn";
  copyBtn.type = "button";
  copyBtn.textContent = "コピー";
  copyBtn.title = "クリップボードにコピー";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(drug);
      showToast("コピーしました");
      copyBtn.textContent = "✓";
      copyBtn.classList.add("copied");
      setTimeout(() => { copyBtn.textContent = "コピー"; copyBtn.classList.remove("copied"); }, 900);
    } catch (e) {
      showToast("コピー失敗", true);
      log("err", "clipboard", e.message);
    }
  });
  btns.appendChild(copyBtn);

  const pasteBtn = document.createElement("button");
  pasteBtn.className = "drug-btn drug-btn--paste";
  pasteBtn.type = "button";
  pasteBtn.textContent = "＋";
  pasteBtn.title = "直前のタブのフォーカス中入力欄に貼付";
  pasteBtn.addEventListener("click", async () => {
    try {
      await pasteToActiveTab(drug);
      showToast("貼り付けました");
      pasteBtn.textContent = "✓";
      setTimeout(() => { pasteBtn.textContent = "＋"; }, 900);
    } catch (e) {
      showToast(e.message, true);
      log("err", "paste", e.message);
    }
  });
  btns.appendChild(pasteBtn);

  li.appendChild(btns);
  return li;
}

// ---- Settings panel ----
$("settingsBtn").addEventListener("click", () => $("settingsPanel").classList.remove("hidden"));
$("settingsClose").addEventListener("click", () => $("settingsPanel").classList.add("hidden"));
$("logClear").addEventListener("click", async () => {
  logs = [];
  await chrome.storage.local.set({ logs });
  renderLogs();
});
$("debugToggle").addEventListener("change", async (e) => {
  debugMode = e.target.checked;
  await chrome.storage.local.set({ debugMode });
  log("info", "debugMode", debugMode ? "ON" : "OFF");
});
$("refreshBtn").addEventListener("click", () => {
  fetchRecords();
  if (currentTab === "questionnaire") fetchQuestionnaires();
});

// ---- Tabs ----
let currentTab = "questionnaire";
let questionnaireLoaded = false;

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    const name = t.dataset.tab;
    currentTab = name;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    if (name === "questionnaire" && !questionnaireLoaded) {
      fetchQuestionnaires();
      questionnaireLoaded = true;
    }
  });
});

// ---- 多店舗テナント（PC毎固定、一度選択したら変更不可） ----
let currentTenant = null;        // 未選択は null
let tenantList = [];             // [{key, store_name}]

function compactStoreName(fullName) {
  return (fullName || "").replace(/^ぞうさん薬局/, "");
}

async function loadTenants() {
  try {
    const res = await apiFetch(`${API_BASE}/api/tenants`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tenantList = data.tenants || [];
  } catch (e) {
    log("err", "loadTenants", e.message);
    tenantList = [];
  }
}

function showStorePicker() {
  const overlay = $("storePickerOverlay");
  const list = $("storePickerList");
  list.innerHTML = "";
  for (const t of tenantList) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "store-picker-btn";
    btn.textContent = compactStoreName(t.store_name);
    btn.addEventListener("click", () => pickStore(t.key));
    list.appendChild(btn);
  }
  overlay.classList.remove("hidden");
}

function hideStorePicker() {
  $("storePickerOverlay").classList.add("hidden");
}

async function pickStore(key) {
  currentTenant = key;
  try { await chrome.storage.local.set({ currentTenant: key }); } catch {}
  updateStoreLabel();
  hideStorePicker();
  fetchQuestionnaires();
}

function updateStoreLabel() {
  const el = $("storeLabel");
  if (!el) return;
  if (!currentTenant) { el.textContent = ""; return; }
  const t = tenantList.find((x) => x.key === currentTenant);
  el.textContent = t ? compactStoreName(t.store_name) : currentTenant;
}

// ---- 転写時に固定で押すボタン (ドメインパターン -> XPath配列) ----
// 患者基礎情報モーダルのうち、アンケートに項目が無く既定値で良いラジオボタンを
// 毎回必ず押す。固定文字列なので外字エスケープ等の心配なし。
const FORCE_CLICK_BY_DOMAIN_PATTERN = [
  {
    pattern: /\.solamichi\.jp$/i,
    xpaths: [
      "/body[1]/div[2]/div[1]/div[2]/table[1]/tbody[1]/tr[1]/td[3]/span[1]/label[1]",
      "/body[1]/div[2]/div[1]/div[2]/table[2]/tbody[1]/tr[1]/td[3]/span[1]/label[1]",
      "//*[@id=\"medicine-take-state-button-good\"]",
      "//*[@id=\"remain-medicine-button-unknown\"]",
      "//*[@id=\"physical-condition-button-change\"]",
    ],
  },
];

function forceClickXpathsFor(domain) {
  for (const cfg of FORCE_CLICK_BY_DOMAIN_PATTERN) {
    if (cfg.pattern.test(domain)) return cfg.xpaths;
  }
  return [];
}

// ---- DOM mapping cache (per tenant + domain) ----
const domMappingsCache = new Map(); // "tenant|domain" -> {mappings, fields}

async function fetchDomMappings(domain) {
  if (!domain) return { mappings: [], fields: [] };
  const cacheKey = `${currentTenant}|${domain}`;
  if (domMappingsCache.has(cacheKey)) return domMappingsCache.get(cacheKey);
  try {
    const res = await apiFetch(`${API_BASE}/api/${encodeURIComponent(currentTenant)}/dom-mappings?domain=${encodeURIComponent(domain)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const result = { mappings: data.mappings || [], fields: data.fields || [] };
    domMappingsCache.set(cacheKey, result);
    return result;
  } catch (e) {
    log("err", "fetchDomMappings", e.message);
    return { mappings: [], fields: [] };
  }
}

// 対象タブで items を実行する（タブ内で実行される関数）
// items: [{ field, xpath, text? }]
//   - 対象が INPUT / TEXTAREA で text が指定されている → fill (同じxpathに複数回くるとカンマ連結)
//   - SELECT で text が指定されている → option 一致を value/label で探して set
//   - それ以外 → click
function injectByItems(items) {
  const results = [];
  const fillBuffer = new Map(); // xpath -> { el, texts: [], fields: [] }
  for (const it of items) {
    try {
      const xr = document.evaluate(it.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const el = xr.singleNodeValue;
      if (!el) { results.push({ field: it.field, ok: false, reason: "要素未発見" }); continue; }
      const tag = el.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA";
      const isSelect = tag === "SELECT";
      const isCE = el.isContentEditable;
      const text = it.text != null ? String(it.text) : "";

      if ((isInput || isCE) && text !== "") {
        const cur = fillBuffer.get(it.xpath) || { el, texts: [], fields: [] };
        cur.texts.push(text);
        cur.fields.push(it.field);
        fillBuffer.set(it.xpath, cur);
      } else if (isSelect && text !== "") {
        let matched = false;
        for (const opt of el.options) {
          if (opt.value === text || opt.textContent.trim() === text) {
            el.value = opt.value; matched = true; break;
          }
        }
        if (!matched) {
          results.push({ field: it.field, ok: false, reason: `select候補に '${text}' なし` });
        } else {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          results.push({ field: it.field, ok: true });
        }
      } else {
        el.click();
        results.push({ field: it.field, ok: true });
      }
    } catch (e) {
      results.push({ field: it.field, ok: false, reason: String(e).slice(0, 100) });
    }
  }
  // fill をマージして一気に流し込む (同じxpath複数回の場合)
  for (const [_xp, buf] of fillBuffer) {
    try {
      const el = buf.el;
      const merged = buf.texts.join(", ");
      if (el.isContentEditable) {
        el.focus();
        document.execCommand("insertText", false, merged);
      } else {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, merged);
        else el.value = merged;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      for (const f of buf.fields) results.push({ field: f, ok: true });
    } catch (e) {
      for (const f of buf.fields) results.push({ field: f, ok: false, reason: String(e).slice(0, 100) });
    }
  }
  return results;
}

// 対象タブで XPath に値を書き込む（タブ内で実行される関数）
function injectFillByXPaths(items) {
  const results = [];
  for (const it of items) {
    try {
      const xr = document.evaluate(it.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const el = xr.singleNodeValue;
      if (!el) { results.push({ field: it.field, ok: false, reason: "要素未発見" }); continue; }
      const tag = el.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA";
      const isSelect = tag === "SELECT";
      const isCE = el.isContentEditable;

      if (isCE) {
        el.focus();
        document.execCommand("insertText", false, it.value);
      } else if (isSelect) {
        // value 一致 or label 一致を試す
        let matched = false;
        for (const opt of el.options) {
          if (opt.value === it.value || opt.textContent.trim() === it.value) {
            el.value = opt.value; matched = true; break;
          }
        }
        if (!matched) { results.push({ field: it.field, ok: false, reason: `select候補に '${it.value}' なし` }); continue; }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (isInput) {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, it.value);
        else el.value = it.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        // 通常要素: textContent
        el.textContent = it.value;
      }
      results.push({ field: it.field, ok: true });
    } catch (e) {
      results.push({ field: it.field, ok: false, reason: String(e).slice(0, 100) });
    }
  }
  return results;
}

async function transferToActiveTab(record) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("アクティブなタブがありません");
  const url = tab.url || "";
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension):/i.test(url)) {
    throw new Error(`このページには書き込めません(${url.split(":")[0]}:)`);
  }
  let domain = "";
  try { domain = new URL(url).hostname; } catch (e) {}
  if (!domain) throw new Error("ドメイン取得失敗");

  const { mappings } = await fetchDomMappings(domain);
  if (!mappings || mappings.length === 0) {
    throw new Error(`${domain} のマッピング未登録（/admin/dom-mapping で設定）`);
  }

  const { items } = buildPerValueTasks(mappings, record);

  // 固定クリック (ドメイン共通既定値) も同じパイプラインで投入
  for (const xp of forceClickXpathsFor(domain)) {
    items.push({ field: `__force_click__:${xp}`, xpath: xp, text: "" });
  }

  if (items.length === 0) {
    throw new Error("転写対象の値が空");
  }

  const merged = new Map();
  const mergeResults = (arr) => {
    for (const r of arr) {
      if (!merged.has(r.field) || (!merged.get(r.field).ok && r.ok)) merged.set(r.field, r);
    }
  };

  // --- Pass 1: メインフレーム ---
  try {
    const out1 = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: injectByItems, args: [items],
    });
    for (const frame of out1) mergeResults(frame.result || []);
  } catch (e) {
    throw new Error(`スクリプト注入失敗: ${e.message}`);
  }

  // --- Pass 2: 未解決を全 iframe で再試行 ---
  const remaining = items.filter((it) => !(merged.get(it.field) || {}).ok);
  if (remaining.length > 0) {
    try {
      const out2 = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, func: injectByItems, args: [remaining],
      });
      for (const frame of out2) {
        if (frame.frameId === 0) continue;
        mergeResults(frame.result || []);
      }
    } catch (e2) {
      if (debugMode) log("warn", "iframe-inject", e2.message);
    }
  }

  const results = Array.from(merged.values());
  const okCount = results.filter((r) => r.ok).length;
  const ngList = results.filter((r) => !r.ok);
  if (debugMode) log("info", "transfer", `domain=${domain} ok=${okCount}/${results.length}`);
  if (ngList.length > 0) {
    log("warn", "transfer-partial", ngList.map((r) => `${r.field}:${r.reason}`).join(", "));
  }

  // サーバー側ログ送信 (失敗してもUIには影響させない)
  postTransferLog(record, domain, results).catch(() => {});

  return { ok: okCount, total: results.length, ngList };
}

async function postTransferLog(record, domain, results) {
  if (!currentTenant) return;
  const ok_fields = results.filter((r) => r.ok).map((r) => r.field);
  const ng_fields = results
    .filter((r) => !r.ok)
    .map((r) => ({ field: r.field, reason: r.reason || "" }));
  let pc_name = "";
  try {
    const s = await chrome.storage.local.get(["pcName"]);
    pc_name = (s.pcName || "").trim();
  } catch {}
  try {
    await apiFetch(`${API_BASE}/api/${encodeURIComponent(currentTenant)}/transfer-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        record_id: record && (record.id || null),
        domain,
        ok_fields,
        ng_fields,
        pc_name,
      }),
    });
  } catch (e) {
    if (debugMode) log("warn", "transfer-log", e.message);
  }
}

// ---- マッピングとアンケート回答からクリック/フィルのタスクを作成 ----
const NONE_VALUE_PATTERNS = /^(特になし|該当なし|摂取なし|なし|未回答|無し)$/;
function isNoneValue(v) { return NONE_VALUE_PATTERNS.test((v || "").trim()); }
function parseAnswer(rawValue) {
  if (rawValue == null) return [];
  const s = String(rawValue).trim();
  if (!s) return [];
  return s.split(/[,、]/).map((x) => x.trim()).filter(Boolean);
}

// "xp1;xp2;xp3" を ["xp1","xp2","xp3"] に展開。1値に対し複数要素クリックを許容するため。
function expandXpaths(xp) {
  if (!xp) return [];
  return String(xp).split(";").map((s) => s.trim()).filter(Boolean);
}

function buildPerValueTasks(mappings, record) {
  // 統合 items: クリック/フィルを 1リスト に。要素タイプは inject側で判定。
  const items = [];

  // questionnaire_field 単位でグルーピング
  const byField = new Map();
  for (const m of mappings) {
    if (m.is_active === 0) continue;
    const arr = byField.get(m.questionnaire_field) || [];
    arr.push(m);
    byField.set(m.questionnaire_field, arr);
  }

  const pushItems = (fieldKey, xpaths, text) => {
    xpaths.forEach((xp, i) => {
      const key = xpaths.length > 1 ? `${fieldKey}#${i + 1}` : fieldKey;
      items.push({ field: key, xpath: xp, text: text || "" });
    });
  };

  for (const [field, rows] of byField) {
    const defaultRow = rows.find((r) => !r.value);
    const valueRows = rows.filter((r) => r.value);
    const parts = parseAnswer(record[field]);
    const noneXpaths = expandXpaths(defaultRow && defaultRow.radio_no_xpath);

    // 空回答: radio_no_xpath を押す (text は不要なので click)
    if (parts.length === 0) {
      if (noneXpaths.length > 0) pushItems(`${field}:__none__`, noneXpaths, "");
      continue;
    }

    const unmatched = [];
    let pushedNone = false;
    for (const p of parts) {
      if (isNoneValue(p)) {
        if (!pushedNone && noneXpaths.length > 0) {
          pushItems(`${field}:__none__`, noneXpaths, "");
          pushedNone = true;
        }
        continue;
      }
      const vRow = valueRows.find((r) => r.value === p);
      if (vRow) {
        // 値を text として渡す: 要素が text input なら fill、checkboxなら click
        pushItems(`${field}:${p}`, expandXpaths(vRow.xpath), p);
      } else {
        unmatched.push(p);
      }
    }

    // 未対応の値はデフォルト行のテキスト入力に流す
    if (unmatched.length > 0 && defaultRow && defaultRow.xpath) {
      for (const xp of expandXpaths(defaultRow.xpath)) {
        items.push({ field: `${field}:__unmatched__`, xpath: xp, text: unmatched.join(", ") });
      }
    }
  }

  return { items };
}

// ---- Questionnaire ----
async function fetchQuestionnaires() {
  const errEl = $("questionnaireError");
  if (!currentTenant) {
    errEl.classList.remove("hidden");
    errEl.textContent = "店舗が選択されていません";
    return;
  }
  try {
    const res = await apiFetch(`${API_BASE}/api/${encodeURIComponent(currentTenant)}/list?limit=30`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderQuestionnaires(data.records || []);
    errEl.classList.add("hidden");
    if (debugMode) log("info", "fetchQuestionnaires", `tenant=${currentTenant} count=${(data.records || []).length}`);
  } catch (e) {
    errEl.classList.remove("hidden");
    errEl.textContent = `アンケート取得失敗: ${e.message}`;
    log("err", "fetchQuestionnaires", e.message);
  }
}

function groupQuestionnaires(rows) {
  const seen = new Set();
  const items = [];
  for (const r of rows) {
    const fg = r.family_group_id;
    if (fg) {
      if (seen.has(fg)) continue;
      seen.add(fg);
      const members = rows
        .filter((x) => x.family_group_id === fg)
        .sort((a, b) => {
          if (a.family_role === "self" && b.family_role !== "self") return -1;
          if (b.family_role === "self" && a.family_role !== "self") return 1;
          return a.id - b.id;
        });
      items.push({ isGroup: true, rows: members });
    } else {
      items.push({ isGroup: false, rows: [r] });
    }
  }
  return items;
}

function renderQuestionnaires(rows) {
  const container = $("questionnaireList");
  container.innerHTML = "";
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "まだ回答がありません";
    container.appendChild(empty);
    return;
  }
  const items = groupQuestionnaires(rows);
  for (const it of items) {
    if (it.isGroup) {
      const wrap = document.createElement("div");
      wrap.className = "q-group";
      const header = document.createElement("div");
      header.className = "q-group__header";
      header.textContent = `家族グループ (${it.rows.length}名)`;
      wrap.appendChild(header);
      let familyIdx = 0;
      for (const r of it.rows) {
        let label;
        if (r.family_role === "self") {
          label = "本人";
        } else {
          familyIdx++;
          label = `ご家族 ${familyIdx}人目`;
        }
        wrap.appendChild(makeQuestionnaireCard(r, label));
      }
      container.appendChild(wrap);
    } else {
      container.appendChild(makeQuestionnaireCard(it.rows[0]));
    }
  }
}

function field(label, value) {
  if (!value) return null;
  const row = document.createElement("div");
  row.className = "q-field";
  const l = document.createElement("span");
  l.className = "q-field__label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "q-field__value";
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function makeQuestionnaireCard(r, roleLabel) {
  const card = document.createElement("div");
  card.className = "q-card";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "q-card__head";

  const id = document.createElement("span");
  id.className = "q-card__id";
  id.textContent = "#" + r.id;
  head.appendChild(id);

  const name = document.createElement("span");
  name.className = "q-card__name";
  name.textContent = r.user_name || "(無記名)";
  head.appendChild(name);

  if (roleLabel) {
    const badge = document.createElement("span");
    badge.className = "q-badge" + (r.family_role === "self" ? " q-badge--self" : "");
    badge.textContent = roleLabel;
    head.appendChild(badge);
  }

  const transferBtn = document.createElement("button");
  transferBtn.type = "button";
  transferBtn.className = "q-transfer-btn";
  transferBtn.textContent = "転写";
  transferBtn.title = "アクティブタブのフォームに転写";
  transferBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    transferBtn.disabled = true;
    transferBtn.textContent = "...";
    try {
      const result = await transferToActiveTab(r);
      if (result.ngList.length === 0) {
        showToast(`転写: ${result.ok}/${result.total} 件`);
      } else {
        showToast(`一部失敗: ${result.ok}/${result.total} 件 (詳細はログ)`, true);
      }
      transferBtn.textContent = "✓";
      setTimeout(() => { transferBtn.textContent = "転写"; transferBtn.disabled = false; }, 1500);
    } catch (err) {
      showToast(err.message, true);
      log("err", "transfer", err.message);
      transferBtn.textContent = "転写";
      transferBtn.disabled = false;
    }
  });
  head.appendChild(transferBtn);

  const date = document.createElement("span");
  date.className = "q-card__date";
  date.textContent = (r.created_at || "").slice(5, 16); // MM-DD HH:MM
  head.appendChild(date);

  const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chev.setAttribute("class", "q-card__chevron");
  chev.setAttribute("viewBox", "0 0 16 16");
  chev.setAttribute("fill", "none");
  chev.innerHTML = '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  head.appendChild(chev);

  head.addEventListener("click", () => card.classList.toggle("open"));
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "q-card__body";
  const fields = [
    ["電話", r.phone],
    ["郵便番号", r.zipcode],
    ["住所", r.address],
    ["体重", r.weight],
    ["疾患", r.disease],
    ["お薬", r.medicine],
    ["食物アレルギー", r.allergy],
    ["副作用経験", r.sideeffects],
    ["習慣的摂取", r.habit],
    ["生活", r.lifestyle],
    ["その他相談", r.consultation],
    ["妊娠・授乳", r.female],
    ["かかりつけ", r.kakaritsuke],
  ];
  for (const [k, v] of fields) {
    const row = field(k, v);
    if (row) body.appendChild(row);
  }
  card.appendChild(body);

  return card;
}

// グローバルエラーを拾ってログに流す
window.addEventListener("error", (e) => {
  log("err", "window.error", `${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  log("err", "unhandledrejection", String(e.reason));
});

// ---- Init ----
async function init() {
  try {
    const stored = await chrome.storage.local.get(["logs", "debugMode", "currentTenant"]);
    logs = stored.logs || [];
    debugMode = !!stored.debugMode;
    $("debugToggle").checked = debugMode;
    if (stored.currentTenant) currentTenant = stored.currentTenant;
    renderLogs();
  } catch (e) {
    log("err", "init storage", e.message);
  }

  // APIトークンを復元 + 保存ボタン配線
  await loadApiToken();
  const tokenInput = $("apiTokenInput");
  const tokenSave = $("apiTokenSave");
  if (tokenSave && tokenInput) {
    tokenInput.addEventListener("focus", () => {
      // マスク表示中なら入力時にクリアして実値入力可能に
      if (tokenInput.value && /^•+$/.test(tokenInput.value)) tokenInput.value = "";
    });
    tokenSave.addEventListener("click", async () => {
      const v = tokenInput.value.trim();
      if (!v) {
        await saveApiToken("");
        showToast("APIトークンをクリアしました");
        return;
      }
      if (/^•+$/.test(v)) { showToast("変更なし"); return; }
      await saveApiToken(v);
      showToast(`APIトークン保存 (長さ ${apiToken.length})`);
      await loadTenants();  // 403で空だった場合は再取得
      if (!currentTenant && tenantList.length > 0) showStorePicker();
    });
  }

  // PC名 (転写ログ用) を復元 + 保存ボタン配線
  try {
    const s = await chrome.storage.local.get(["pcName"]);
    const pcName = (s.pcName || "").trim();
    const pcInput = $("pcNameInput");
    const pcStatus = $("pcNameStatus");
    if (pcInput) pcInput.value = pcName;
    if (pcStatus) pcStatus.textContent = pcName ? `保存済: ${pcName}` : "未設定 (転写ログにこの名前が記録されます)";
  } catch {}
  const pcSave = $("pcNameSave");
  const pcInput = $("pcNameInput");
  if (pcSave && pcInput) {
    pcSave.addEventListener("click", async () => {
      const v = pcInput.value.trim();
      try { await chrome.storage.local.set({ pcName: v }); } catch {}
      const pcStatus = $("pcNameStatus");
      if (pcStatus) pcStatus.textContent = v ? `保存済: ${v}` : "クリア済";
      showToast(v ? `PC名保存: ${v}` : "PC名クリア");
    });
  }

  // テナント一覧を取得
  await loadTenants();

  // 保存済みテナントの整合性チェック + 未選択ならモーダル強制表示
  if (currentTenant && !tenantList.find((t) => t.key === currentTenant)) {
    currentTenant = null;
    try { await chrome.storage.local.remove("currentTenant"); } catch {}
  }
  if (!currentTenant) {
    showStorePicker();
  } else {
    updateStoreLabel();
  }

  await fetchRecords();
  if (currentTenant) {
    fetchQuestionnaires();
    questionnaireLoaded = true;
  }
  // 15秒ごとに自動更新（アクティブタブのみ取得）
  setInterval(() => {
    if (currentTab === "ocr") fetchRecords();
    else if (currentTab === "questionnaire" && currentTenant) fetchQuestionnaires();
  }, 15000);
}

init();
