const SITE_ROOT = new URL("./", import.meta.url);
const SITE_BASE_PATH = SITE_ROOT.pathname.replace(/\/$/, "");
const routes = new Set(["overview", "weekly", "daily", "fundamentals", "methodology"]);
const assets = {
  gold: {
    id: "gold",
    code: "GOLD",
    name: "黄金",
    shortName: "黄金",
    eyebrow: "GOLD · DAILY OBSERVATORY",
  },
  btc: {
    id: "btc",
    code: "BTC",
    name: "比特币",
    shortName: "比特币",
    eyebrow: "BTC · DIGITAL ASSET OBSERVATORY",
  },
};
const WATCHLIST_KEY = "lz-assetscope-watchlist-v1";
const DEFAULT_WATCHLIST = ["gold", "btc"];
const state = {
  assetId: "gold",
  current: null,
  daily: null,
  weekly: null,
  fundamentals: null,
  charts: new Map(),
  routeLoads: new Map(),
  loadToken: 0,
};
let chartLibraryPromise;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[char]));
const fmt = (value, digits = 2) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "—";
const fmtDate = (value) => value ? String(value).slice(0, 10) : "—";
const shiftIsoMonths = (value, months) => {
  const date = new Date(`${fmtDate(value)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};
const impactLabel = { support: "支持", pressure: "压力", neutral: "中性" };
const directionLabel = { up: "上升", down: "下降", flat: "持平" };
const stagePresentation = {
  1: { code: "S1", title: "低位整理", phase: "底部阶段", arrow: "◆", color: "#3f7fd2" },
  2: { code: "S2", title: "上升趋势", phase: "上升阶段", arrow: "▲", color: "#329b57" },
  3: { code: "S3", title: "高位整理", phase: "顶部阶段", arrow: "◆", color: "#d68428" },
  4: { code: "S4", title: "下降趋势", phase: "下降阶段", arrow: "▼", color: "#d0444e" },
};

function dataRoot(assetId = state.assetId) {
  return new URL(`data/assets/${assetId}/`, SITE_ROOT);
}

function routePath(route, assetId = state.assetId) {
  return `${SITE_BASE_PATH}/${assetId}/${route}`;
}

function locationContext() {
  const forwardedPath = new URLSearchParams(location.search).get("route");
  const candidatePath = forwardedPath || location.pathname.slice(SITE_BASE_PATH.length);
  const parts = candidatePath.split("/").filter(Boolean);
  const assetId = assets[parts[0]] ? parts[0] : "gold";
  const pathRoute = parts[1];
  const legacyRoute = location.hash.split("/").filter(Boolean).at(-1);
  const route = pathRoute || legacyRoute || "overview";
  return { assetId, route: routes.has(route) ? route : "overview" };
}

function routeFromLocation() {
  return locationContext().route;
}

function normalizeRoute() {
  const { assetId, route } = locationContext();
  state.assetId = assetId;
  const target = routePath(route, assetId);
  if (location.pathname !== target || location.search || location.hash) {
    history.replaceState({ assetId, route }, "", target);
  }
  updateRouteLinks();
  return route;
}

function updateRouteLinks() {
  $$('[data-route]').forEach((link) => { link.href = routePath(link.dataset.route); });
}

function lockMobilePageZoom() {
  if (!navigator.maxTouchPoints) return;
  const preventZoom = (event) => event.preventDefault();
  ["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
    document.addEventListener(eventName, preventZoom, { passive: false });
  });
  document.addEventListener("touchmove", (event) => {
    if (event.touches.length > 1) preventZoom(event);
  }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (event) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) preventZoom(event);
    lastTouchEnd = now;
  }, { passive: false });
}

function readWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
    const normalized = saved.filter((assetId) => assets[assetId]);
    return normalized.length ? [...new Set(normalized)] : [...DEFAULT_WATCHLIST];
  } catch {
    return [...DEFAULT_WATCHLIST];
  }
}

function writeWatchlist(items) {
  const normalized = [...new Set(items.filter((assetId) => assets[assetId]))];
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(normalized.length ? normalized : DEFAULT_WATCHLIST));
}

function ensureActiveAssetInWatchlist() {
  const current = readWatchlist();
  if (!current.includes(state.assetId)) writeWatchlist([...current, state.assetId]);
}

function renderWatchlist() {
  ensureActiveAssetInWatchlist();
  const watchlist = readWatchlist();
  $("#asset-watchlist").innerHTML = watchlist.map((assetId) => {
    const asset = assets[assetId];
    return `
      <button class="watchlist-asset ${assetId === state.assetId ? "active" : ""}" type="button" data-asset="${esc(assetId)}" aria-pressed="${assetId === state.assetId}">
        <span class="watchlist-asset-icon">${esc(asset.code)}</span>
        <span class="watchlist-asset-copy"><strong>${esc(asset.shortName)}</strong><small>${esc(asset.code)} / USD</small></span>
      </button>
    `;
  }).join("");
  const available = Object.keys(assets).filter((assetId) => !watchlist.includes(assetId));
  $("#asset-catalog").innerHTML = available.length ? available.map((assetId) => {
    const asset = assets[assetId];
    return `
      <button class="catalog-asset" type="button" data-add-asset="${esc(assetId)}">
        <span><strong>${esc(asset.name)}</strong>${esc(asset.code)} / USD</span><em>添加</em>
      </button>
    `;
  }).join("") : '<p class="catalog-empty">当前支持的资产已经全部加入自选。</p>';
}

function setAssetPicker(open) {
  $("#asset-picker").hidden = !open;
  document.body.classList.toggle("picker-open", open);
  if (open) $("#asset-picker-title").focus?.();
}

function clearCharts() {
  state.charts.forEach(({ chart, observer }) => {
    observer?.disconnect();
    chart?.remove?.();
  });
  state.charts.clear();
  for (const id of ["weekly-chart", "daily-chart"]) {
    const container = document.getElementById(id);
    if (container) container.replaceChildren();
  }
}

function activateRoute() {
  const route = routeFromLocation();
  $$('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== route; });
  $$('[data-route]').forEach((link) => link.classList.toggle("active", link.dataset.route === route));
  updateRouteLinks();
  renderWatchlist();
  if (state.current) void ensureRouteData(route);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function loadJson(path, { attempts = 2, timeoutMs = 8000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(350 * attempt);
    } finally {
      window.clearTimeout(timeout);
    }
  }
  if (lastError?.name === "AbortError") throw new Error("数据请求超时，请检查网络后重试。");
  throw lastError;
}

function loadChartLibrary() {
  if (window.LightweightCharts) return Promise.resolve();
  if (chartLibraryPromise) return chartLibraryPromise;
  chartLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("vendor-lightweight-charts.js?v=0.6.0", SITE_ROOT);
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      chartLibraryPromise = null;
      reject(new Error("图表组件加载失败，请重试。"));
    };
    document.head.append(script);
  });
  return chartLibraryPromise;
}

function setRouteState(route, status, message = "") {
  const node = $(`[data-route-state="${route}"]`);
  if (!node) return;
  node.hidden = status === "ready";
  node.classList.toggle("error", status === "error");
  if (status === "loading") node.textContent = "正在加载本页详细数据…";
  if (status === "error") {
    node.innerHTML = `${esc(message || "本页详细数据暂时不可用。")}<button type="button" data-retry-route="${esc(route)}">重试</button>`;
  }
}

async function ensureRouteData(route, { force = false } = {}) {
  if (["overview", "methodology"].includes(route)) return;
  const assetId = state.assetId;
  const root = dataRoot(assetId);
  if (force) state.routeLoads.delete(route);
  if (state.routeLoads.has(route)) return state.routeLoads.get(route);
  const load = (async () => {
    setRouteState(route, "loading");
    if (route === "weekly") {
      state.weekly = force || !state.weekly
        ? await loadJson(new URL("weekly-series.json", root))
        : state.weekly;
      if (assetId !== state.assetId) return;
      renderWeekly();
      await loadChartLibrary();
      requestAnimationFrame(renderWeeklyChart);
    }
    if (route === "daily") {
      state.daily = force || !state.daily
        ? await loadJson(new URL("daily-series.json", root))
        : state.daily;
      if (assetId !== state.assetId) return;
      renderDaily();
      await loadChartLibrary();
      requestAnimationFrame(renderDailyChart);
    }
    if (route === "fundamentals") {
      state.fundamentals = force || !state.fundamentals
        ? await loadJson(new URL("fundamentals.json", root))
        : state.fundamentals;
      if (assetId !== state.assetId) return;
      renderFundamentals();
    }
    setRouteState(route, "ready");
  })().catch((error) => {
    state.routeLoads.delete(route);
    setRouteState(route, "error", error.message);
    console.error(error);
  });
  state.routeLoads.set(route, load);
  return load;
}

function signalClass(value) {
  const text = String(value || "");
  if (/支持|顺风|偏强|多头|绿灯|S2/.test(text)) return "support";
  if (/压力|逆风|压制|偏弱|熊市|红灯|S4/.test(text)) return "pressure";
  return "neutral";
}

function metricPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function bandStatusTone(status) {
  const text = String(status || "");
  if (/低位金叉|趋势金叉/.test(text)) return { className: "band-tone-green", color: "#06a94f" };
  if (/上行趋势/.test(text)) return { className: "band-tone-blue", color: "#1769dc" };
  if (/超卖观察/.test(text)) return { className: "band-tone-orange", color: "#f36b00" };
  if (/观察等待|高位保护/.test(text)) return { className: "band-tone-amber", color: "#d99822" };
  if (/下行风险|高位死叉/.test(text)) return { className: "band-tone-red", color: "#f23845" };
  return { className: "band-tone-neutral", color: "#7571b5" };
}

function returnText(value) {
  if (!Number.isFinite(Number(value))) return "待观察";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${fmt(number, 2)}%`;
}

function returnTone(value) {
  if (!Number.isFinite(Number(value))) return "pending";
  return Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
}

function updateHeader() {
  const { current } = state;
  const presentation = assets[state.assetId];
  const quote = current.quote;
  document.body.dataset.asset = state.assetId;
  document.title = `LZ-AssetScope · ${presentation.name}观察`;
  $("#asset-symbol").textContent = presentation.code;
  $("#asset-eyebrow").textContent = presentation.eyebrow;
  $("#asset-name").textContent = presentation.name;
  $("#overview-title").textContent = `${presentation.name}状态总览`;
  $("#footer-label").textContent = `LZ-AssetScope · ${presentation.name}观察`;
  $("#module-tabs").setAttribute("aria-label", `${presentation.name}分析模块`);
  $("#weekly-chart").setAttribute("aria-label", `${presentation.name}周线价格图`);
  $("#daily-chart").setAttribute("aria-label", `${presentation.name}日线价格图`);
  const delta = Number(quote.price) - Number(quote.previousClose);
  const percent = Number(quote.previousClose) ? (delta / Number(quote.previousClose)) * 100 : 0;
  $("#asset-benchmark").textContent = current.asset.technicalBenchmark;
  $("#quote-price").textContent = fmt(quote.price, 1);
  $("#quote-currency").textContent = quote.currency;
  const change = $("#quote-change");
  change.textContent = `${delta >= 0 ? "+" : ""}${fmt(delta, 1)} · ${percent >= 0 ? "+" : ""}${fmt(percent, 2)}%`;
  change.className = delta >= 0 ? "positive" : "negative";
  $("#daily-date").textContent = fmtDate(current.daily.asOf);
  $("#weekly-date").textContent = fmtDate(current.weekly.asOf);
  const generatedAt = new Date(current.generatedAt);
  $("#generated-at").textContent = generatedAt.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).replaceAll("/", "-");
  $("#generated-at").title = generatedAt.toLocaleString("zh-CN", { hour12: false });
  renderWatchlist();
}

function renderOverview() {
  const { current } = state;
  $("#overview-headline").textContent = current.synthesis.headline;
  const weeklyObservation = current.weekly.current.observation || {};
  const weeklyStage = Number(weeklyObservation.primaryStage || current.weekly.current.confirmed?.primary);
  const weeklyStageTitle = stagePresentation[weeklyStage]?.title || "";
  const weeklyLabel = [weeklyObservation.label || "未确认", weeklyStageTitle].filter(Boolean).join(" ");
  const fundamentalHealth = current.fundamentals.health || {};
  const staleCount = Number(fundamentalHealth.staleCount || current.quality.dataHealth?.staleFundamentalCount || 0);
  const metrics = [
    ["#overview-weekly-card", "#overview-weekly", "#overview-weekly-note", weeklyLabel, `完成周线 · ${fmtDate(current.weekly.asOf)}`],
    ["#overview-daily-card", "#overview-daily", "#overview-daily-note", current.daily.summary.fusion.status, `${current.daily.summary.traffic.status} · ${fmtDate(current.daily.asOf)}`],
    ["#overview-fundamental-card", "#overview-fundamental", "#overview-fundamental-note", current.fundamentals.regime, staleCount ? `${staleCount} 项沿用上一有效值` : `更新至 ${fmtDate(current.fundamentals.asOf)}`],
  ];
  metrics.forEach(([cardSelector, valueSelector, noteSelector, value, note]) => {
    const card = $(cardSelector);
    card.classList.remove("support", "pressure", "neutral");
    card.classList.add(signalClass(value));
    $(valueSelector).textContent = value;
    $(noteSelector).textContent = note;
  });
  const changeSummary = current.changeSummary || {
    direction: "stable",
    label: current.daily.change,
    items: current.recentChanges || [],
  };
  const changeBox = $("#overview-change");
  changeBox.classList.remove("improving", "weakening", "mixed", "stable");
  changeBox.classList.add(changeSummary.direction || "stable");
  $("#overview-change-label").textContent = changeSummary.label;
  $("#synthesis-title").textContent = current.synthesis.title || "当前主导逻辑";
  $("#tension-copy").textContent = current.synthesis.tension;
  const changes = changeSummary.items || current.recentChanges || [];
  $("#change-timeline").innerHTML = changes.length ? changes.map((item) => `
    <li class="${esc(item.direction || "changed")}">
      <div><strong>${esc(item.title)}</strong>${item.detail ? `<small>${esc(item.detail)}</small>` : ""}</div>
      <time datetime="${esc(item.date)}">${esc(fmtDate(item.date))}</time>
    </li>
  `).join("") : '<li class="empty-change">完成周期内暂无关键状态变化。</li>';
  const conditions = current.validationConditions || [];
  $("#validation-list").innerHTML = conditions.length ? conditions.map((item) => `
    <div class="validation-item ${esc(item.tone || "watch")}">
      <span>${esc(item.label)}</span>
      <strong>${esc(item.condition)}</strong>
    </div>
  `).join("") : '<div class="validation-item watch"><span>等待更新</span><strong>下一次数据生成后补充验证条件</strong></div>';
  const health = current.quality.dataHealth || {
    status: current.quality.status,
    label: current.quality.status === "ok" ? "数据正常" : "数据需注意",
    staleFundamentals: [],
  };
  $("#quality-summary").textContent = health.label;
  const qualityDetails = [];
  if (health.staleFundamentals?.length) {
    qualityDetails.push(`基本面中的${health.staleFundamentals.join("、")}未在本轮更新，页面沿用各自上一有效值。`);
  }
  if (current.quality.warnings?.length) qualityDetails.push(...current.quality.warnings);
  $("#quality-detail").textContent = qualityDetails.length
    ? qualityDetails.join(" ")
    : `行情、周线和日线数据已更新至 ${fmtDate(current.daily.asOf)}。`;
}

function renderWeekly() {
  const current = state.current.weekly.current;
  const stageTone = signalClass(current.observation?.label);
  const currentPrimaryStage = Number(current.observation?.primaryStage || current.confirmed?.primary);
  const currentStageTitle = stagePresentation[currentPrimaryStage]?.title || "";
  $("#weekly-asof-chip").textContent = `截至 ${fmtDate(state.weekly.asOf)}`;
  const confirmed = current.confirmed || {};
  $("#weekly-stats").innerHTML = `
    <span class="panel-kicker">CURRENT STAGE</span>
    <div class="big-state ${stageTone}"><span>${esc(current.observation?.label || "未确认")}</span>${currentStageTitle ? `<small>${esc(currentStageTitle)}</small>` : ""}</div>
    <dl class="stat-list">
      <div><dt>已确认主阶段</dt><dd>${esc(confirmed.label || "—")}</dd></div>
      <div><dt>持续周数</dt><dd>${esc(confirmed.weeks ?? "—")}</dd></div>
      <div><dt>周收盘</dt><dd>${fmt(current.close, 1)}</dd></div>
      <div><dt>MA10</dt><dd>${fmt(current.ma10, 1)}</dd></div>
      <div><dt>MA30</dt><dd>${fmt(current.ma30, 1)}</dd></div>
      <div><dt>MA30五周斜率</dt><dd>${fmt(Number(current.slope) * 100, 2)}%</dd></div>
      <div><dt>证据置信度</dt><dd>${fmt(current.confidence, 0)}%</dd></div>
    </dl>
    <div class="metric-track" aria-label="证据置信度 ${fmt(current.confidence, 0)}%"><span style="--metric: ${metricPercent(current.confidence)}%"></span></div>
    <p class="explanation">${esc(current.explanation || current.observation?.reason || "")}</p>
  `;
  $("#weekly-evidence").innerHTML = (current.evidence || []).map((item) => `
    <div class="evidence-item">
      <strong>${esc(item.label)}</strong>
      <span class="tag ${esc(item.state === "support" ? "support" : item.state === "warning" ? "warning" : "neutral")}">${esc(item.value)}</span>
      <p>${esc(item.detail)}</p>
    </div>
  `).join("") || '<p class="muted-copy">当前没有可展示的阶段证据。</p>';
  $("#stage-history").innerHTML = [...(state.weekly.stageHistory || [])].slice(-6).reverse().map((item) => `
    <div class="history-item stage-bg-s${stageNumber(item.newStage) || 0}">
      <strong>${esc(item.originalStage)} → ${esc(item.newStage)}</strong>
      <span>${esc(fmtDate(item.date))}</span>
      <p>阶段转换参考价 ${fmt(item.conversionPrice, 1)}</p>
    </div>
  `).join("") || '<p class="muted-copy">暂无阶段变化记录。</p>';
}

function renderDaily() {
  const summary = state.current.daily.summary;
  const fusionTone = signalClass(summary.fusion.status);
  const latestBar = state.daily.series?.at(-1) || {};
  const ma200Distance = Number(latestBar.ma200)
    ? ((Number(latestBar.close) / Number(latestBar.ma200)) - 1) * 100
    : null;
  $("#daily-asof-chip").textContent = `截至 ${fmtDate(state.daily.asOf)}`;
  $("#daily-summary").innerHTML = `
    <span class="panel-kicker">FUSION STATUS</span>
    <div class="big-state ${fusionTone}">${esc(summary.fusion.status)}</div>
    <dl class="stat-list">
      <div><dt>融合得分</dt><dd>${fmt(summary.fusion.score, 0)}</dd></div>
      <div><dt>牛熊状态</dt><dd>${esc(summary.bullBear.status)}</dd></div>
      <div><dt>趋势交通灯</dt><dd>${esc(summary.traffic.status)}</dd></div>
      <div><dt>波动状态</dt><dd>${esc(summary.band.status)}</dd></div>
      <div><dt>MA200偏离</dt><dd class="${returnTone(ma200Distance)}">${Number.isFinite(ma200Distance) ? `${ma200Distance > 0 ? "+" : ""}${fmt(ma200Distance, 2)}%` : "—"}</dd></div>
    </dl>
    <div class="metric-track" aria-label="融合得分 ${fmt(summary.fusion.score, 0)}"><span style="--metric: ${metricPercent(summary.fusion.score)}%"></span></div>
    <p class="explanation">${esc(summary.fusion.advice)}</p>
  `;
  $("#daily-change-summary").innerHTML = `
    <span>与上一日相比</span>
    <strong>${esc(state.current.daily.change)}</strong>
  `;
  const history = [...(state.daily.bandHistory || [])].reverse();
  $("#band-history-count").textContent = `最近 ${history.length} 条`;
  $("#band-history-list").innerHTML = history.map((item) => {
    const tone = bandStatusTone(item.status);
    return `
      <tr>
        <td><time datetime="${esc(item.date)}">${esc(fmtDate(item.date))}</time></td>
        <td><span class="band-status-chip ${tone.className}">${esc(item.status)}</span></td>
        <td class="number-cell">${fmt(item.price, 1)}</td>
        <td class="number-cell ${returnTone(item.return7)}">${esc(returnText(item.return7))}</td>
        <td class="number-cell ${returnTone(item.return14)}">${esc(returnText(item.return14))}</td>
        <td class="action-cell">${esc(item.action || "—")}</td>
      </tr>
    `;
  }).join("") || '<tr><td colspan="6" class="empty-history">暂无历史状态变化。</td></tr>';
}

function renderFundamentals() {
  const fundamentals = state.current.fundamentals;
  $("#fundamental-regime").textContent = fundamentals.regime;
  $("#fundamental-summary").textContent = fundamentals.summary;
  $("#factor-grid").innerHTML = fundamentals.factors.map((item) => {
    const delta = Number(item.change5Observations);
    const signed = delta > 0 ? `+${fmt(delta, 2)}` : fmt(delta, 2);
    return `
      <article class="factor-card ${esc(item.impact)}">
        <div class="factor-top"><h3>${esc(item.label)}</h3><span class="tag ${esc(item.impact)}">${esc(impactLabel[item.impact] || "暂不明确")}</span></div>
        <div class="factor-value">${fmt(item.value, 2)} <small>${esc(item.unit)}</small></div>
        <div class="factor-change ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${esc(directionLabel[item.direction])} · 五个观察值变化 ${signed}</div>
        <p>${esc(item.explanation)}</p>
        <div class="factor-source"><span>${esc(item.source.name)} · ${esc(item.source.seriesId)}</span><span>${esc(fmtDate(item.observationDate))}</span></div>
      </article>
    `;
  }).join("");
  const labels = {
    "real-yield": "实际利率",
    "nominal-yield": "名义利率",
    "inflation-expectations": "通胀预期",
    "broad-dollar": "广义美元",
    "gold-etf-flows": "黄金ETF资金流",
    "cftc-positioning": "CFTC持仓",
    "central-bank-demand": "央行购金",
    "china-premium": "中国溢价",
    "event-calendar": "宏观事件日历",
    "financial-conditions": "美国金融条件",
    "fed-balance-sheet": "美联储资产负债表",
    "spot-etf-flows": "现货ETF资金流",
    "stablecoin-supply": "稳定币供应",
    "exchange-balance": "交易所余额",
  };
  const coverage = state.fundamentals.coverage;
  $("#coverage-panel").innerHTML = `
    <div class="panel-heading"><span class="panel-kicker">COVERAGE</span><h2>基本面覆盖进度</h2></div>
    <div class="coverage-columns">
      <div><h3>已经接入</h3><ul>${coverage.implemented.map((key) => `<li>${esc(labels[key] || key)}</li>`).join("")}</ul></div>
      <div><h3>后续接入</h3><ul>${coverage.planned.map((key) => `<li>${esc(labels[key] || key)}</li>`).join("")}</ul></div>
    </div>
  `;
}

function renderMethodology() {
  const current = state.current;
  $("#provenance-panel").innerHTML = `
    <div class="panel-heading"><span class="panel-kicker">PROVENANCE</span><h2>可追溯信息</h2></div>
    <div class="provenance-grid">
      <div class="code-block">周线引擎<br>${esc(current.engines.weekly.name)}<br>内部版本: ${esc(current.engines.weekly.version)}</div>
      <div class="code-block">日线引擎<br>${esc(current.engines.daily.name)}<br>内部版本: ${esc(current.engines.daily.version)}</div>
      <div class="code-block">统一输入<br>${esc(current.asset.symbol)} · ${esc(current.asset.name)}<br>数据版本: ${esc(current.quality.dataVersion)}</div>
      <div class="code-block">数据日期<br>日线: ${esc(current.quality.dailyAsOf)}<br>周线: ${esc(current.quality.weeklyAsOf)}</div>
      <div class="code-block">行情来源<br>${esc(current.quote.source.name)}<br>日线数量: ${esc(current.quality.dailyBars)}</div>
    </div>
  `;
}

function chartApi(container, kind) {
  if (!window.LightweightCharts) return null;
  const uiFont = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim();
  const chart = window.LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: { background: { color: "transparent" }, textColor: "#65778a", fontFamily: uiFont },
    grid: { vertLines: { color: "rgba(17,42,67,.08)" }, horzLines: { color: "rgba(17,42,67,.08)" } },
    rightPriceScale: {
      borderColor: "rgba(17,42,67,.14)",
      scaleMargins: kind === "daily" ? { top: 0.08, bottom: 0.3 } : { top: 0.14, bottom: 0.1 },
    },
    timeScale: { borderColor: "rgba(17,42,67,.14)", timeVisible: kind === "daily" },
    crosshair: { vertLine: { color: "rgba(181,132,45,.45)" }, horzLine: { color: "rgba(181,132,45,.45)" } },
  });
  const addCandle = (options) => chart.addCandlestickSeries
    ? chart.addCandlestickSeries(options)
    : chart.addSeries(window.LightweightCharts.CandlestickSeries, options);
  const addLine = (options) => chart.addLineSeries
    ? chart.addLineSeries(options)
    : chart.addSeries(window.LightweightCharts.LineSeries, options);
  return { chart, addCandle, addLine };
}

function stageNumber(value) {
  const match = String(value ?? "").match(/[1-4]/);
  return match ? Number(match[0]) : null;
}

function stageSegments(series) {
  const segments = [];
  series.forEach((bar, index) => {
    const stage = stageNumber(bar.stage);
    const previous = segments.at(-1);
    if (previous?.stage === stage) {
      previous.end = index;
    } else if (stage) {
      segments.push({ stage, start: index, end: index });
    }
  });
  return segments;
}

function seriesWithConfirmedStages(series, history) {
  const transitions = [...(history || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let transitionIndex = 0;
  let confirmedStage = stageNumber(series[0]?.stage);
  return series.map((bar) => {
    const date = bar.time || bar.date;
    while (transitionIndex < transitions.length && transitions[transitionIndex].date <= date) {
      confirmedStage = stageNumber(transitions[transitionIndex].newStage) || confirmedStage;
      transitionIndex += 1;
    }
    return { ...bar, stage: confirmedStage };
  });
}

function installStageBackground(container, chart, series) {
  const backgroundLayer = document.createElement("div");
  const labelLayer = document.createElement("div");
  backgroundLayer.className = "stage-background-layer";
  labelLayer.className = "stage-label-layer";
  container.prepend(backgroundLayer);
  container.append(labelLayer);
  const segments = stageSegments(series);

  const redraw = () => {
    const coordinates = series.map((bar) => chart.timeScale().timeToCoordinate(bar.time || bar.date));
    if (coordinates.filter(Number.isFinite).length < 2) return;
    backgroundLayer.replaceChildren();
    labelLayer.replaceChildren();
    segments.forEach((segment) => {
      const startCoordinate = coordinates[segment.start];
      const endCoordinate = coordinates[segment.end];
      if (!Number.isFinite(startCoordinate) || !Number.isFinite(endCoordinate)) return;
      const before = coordinates[segment.start - 1];
      const after = coordinates[segment.end + 1];
      const left = Number.isFinite(before)
        ? (before + startCoordinate) / 2
        : startCoordinate - Math.abs((coordinates[segment.start + 1] ?? startCoordinate + 8) - startCoordinate) / 2;
      const right = Number.isFinite(after)
        ? (endCoordinate + after) / 2
        : endCoordinate + Math.abs(endCoordinate - (coordinates[segment.end - 1] ?? endCoordinate - 8)) / 2;
      const clippedLeft = Math.max(0, left);
      const clippedRight = Math.min(container.clientWidth, right);
      const width = clippedRight - clippedLeft;
      if (width <= 0) return;
      const presentation = stagePresentation[segment.stage];
      const zone = document.createElement("span");
      zone.className = `stage-zone s${segment.stage}`;
      zone.style.left = `${clippedLeft}px`;
      zone.style.width = `${width}px`;
      zone.title = `${presentation.code} ${presentation.title}`;
      backgroundLayer.append(zone);
      if (width >= 28) {
        const label = document.createElement("span");
        label.className = `stage-zone-label s${segment.stage}`;
        label.style.left = `${clippedLeft}px`;
        label.style.width = `${width}px`;
        label.textContent = presentation.code;
        labelLayer.append(label);
      }
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(redraw);
  return redraw;
}

function installStageTransitions(container, chart, candle, series, history) {
  const layer = document.createElement("div");
  layer.className = "stage-transition-layer";
  container.append(layer);
  const bars = new Map(series.map((bar) => [bar.time || bar.date, bar]));
  const transitions = (history || []).filter((item) => {
    const original = stageNumber(item.originalStage);
    const next = stageNumber(item.newStage);
    return original && next && original !== next && bars.has(item.date);
  });
  const redraw = () => {
    layer.replaceChildren();
    transitions.forEach((item) => {
      const stage = stageNumber(item.newStage);
      const bar = bars.get(item.date);
      const isBelow = stage === 1 || stage === 2;
      const x = chart.timeScale().timeToCoordinate(item.date);
      const y = candle.priceToCoordinate(isBelow ? bar.low : bar.high);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -40 || x > container.clientWidth + 40) return;
      const badge = document.createElement("span");
      badge.className = `stage-transition-badge s${stage} ${isBelow ? "below" : "above"}`;
      badge.style.left = `${x}px`;
      badge.style.top = `${isBelow ? y + 10 : y - 10}px`;
      badge.tabIndex = 0;
      const originalStage = stageNumber(item.originalStage);
      const presentation = stagePresentation[stage];
      const originalCode = stagePresentation[originalStage]?.code || item.originalStage;
      const label = document.createElement("span");
      label.className = "stage-transition-label";
      label.textContent = `${presentation.arrow} ${presentation.code}`;
      const tooltip = document.createElement("span");
      tooltip.className = "stage-transition-tooltip";
      if (x < 155) tooltip.classList.add("align-left");
      if (x > container.clientWidth - 155) tooltip.classList.add("align-right");
      const tooltipRows = [
        ["日期", item.date],
        ["收盘价", fmt(bar.close, 1)],
        ["阶段转换", `${originalCode} → ${presentation.code} ${presentation.phase}`],
      ];
      tooltipRows.forEach(([key, value]) => {
        const row = document.createElement("span");
        row.textContent = `${key}：${value}`;
        tooltip.append(row);
      });
      badge.setAttribute("aria-label", tooltipRows.map(([key, value]) => `${key}：${value}`).join("；"));
      badge.append(label, tooltip);
      layer.append(badge);
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(redraw);
  return redraw;
}

function bandMarkerPresentation(status) {
  if (/低位金叉|趋势金叉/.test(status)) return { tone: "positive", position: "below", iconLabel: "上三角" };
  if (/上行趋势/.test(status)) return { tone: "uptrend", position: "below", iconLabel: "蓝色圆点" };
  if (/高位保护/.test(status)) return { tone: "protection", position: "above", iconLabel: "橙色下三角" };
  if (/高位死叉|下行风险/.test(status)) return { tone: "risk", position: "above", iconLabel: "下三角" };
  return { tone: "watch", position: "below", iconLabel: "圆点" };
}

function installBandHistoryMarkers(container, chart, candle, series, history) {
  const layer = document.createElement("div");
  layer.className = "band-history-marker-layer";
  container.append(layer);
  const bars = new Map(series.map((bar) => [bar.date || bar.time, bar]));
  const observations = (history || []).filter((item) => bars.has(item.date));
  const redraw = () => {
    layer.replaceChildren();
    observations.forEach((item) => {
      const bar = bars.get(item.date);
      const presentation = bandMarkerPresentation(item.status);
      const isAbove = presentation.position === "above";
      const x = chart.timeScale().timeToCoordinate(item.date);
      const y = candle.priceToCoordinate(isAbove ? bar.high : bar.low);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -24 || x > container.clientWidth + 24) return;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `band-history-marker ${presentation.tone} ${presentation.position}`;
      marker.style.left = `${x}px`;
      marker.style.top = `${isAbove ? y - 9 : y + 9}px`;
      const icon = document.createElement("span");
      icon.className = "band-history-marker-icon";
      icon.setAttribute("aria-hidden", "true");
      const tooltip = document.createElement("span");
      tooltip.className = "band-history-marker-tooltip";
      if (x < 175) tooltip.classList.add("align-left");
      if (x > container.clientWidth - 175) tooltip.classList.add("align-right");
      const tooltipRows = [
        ["状态", item.status],
        ["日期", item.date],
        ["收盘价", fmt(item.price ?? bar.close, 1)],
        ["综合评分", `${fmt(item.fusionScore, 0)} · ${item.fusionStatus || "—"}`],
        ["牛熊分界", `${fmt(item.bullBearScore, 0)} 分`],
        ["趋势红绿灯", `${fmt(item.trafficScore, 0)} 分`],
        ["指标三", `${fmt(item.bandScore, 0)} · ${item.status}`],
        ["状态说明", item.action || "—"],
      ];
      tooltipRows.forEach(([key, value]) => {
        const row = document.createElement("span");
        row.textContent = `${key}：${value}`;
        tooltip.append(row);
      });
      marker.setAttribute("aria-label", `${presentation.iconLabel}；${tooltipRows.map(([key, value]) => `${key}：${value}`).join("；")}`);
      marker.append(icon, tooltip);
      layer.append(marker);
    });
  };
  chart.timeScale().subscribeVisibleLogicalRangeChange?.(redraw);
  requestAnimationFrame(redraw);
  return redraw;
}

function installStochRsi(container, chart, addLine, series) {
  const common = {
    priceScaleId: "stoch-rsi",
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: true,
    priceFormat: { type: "price", precision: 1, minMove: 0.1 },
  };
  const kLine = addLine({ ...common, color: "#3f82ad", title: "StochRSI K" });
  const dLine = addLine({ ...common, color: "#d68428", title: "StochRSI D" });
  kLine.setData(series.flatMap((bar) => Number.isFinite(Number(bar.stochK)) ? [{ time: bar.date || bar.time, value: Number(bar.stochK) }] : []));
  dLine.setData(series.flatMap((bar) => Number.isFinite(Number(bar.stochD)) ? [{ time: bar.date || bar.time, value: Number(bar.stochD) }] : []));
  chart.priceScale("stoch-rsi").applyOptions({
    autoScale: true,
    visible: false,
    scaleMargins: { top: 0.76, bottom: 0.05 },
  });
  for (const value of [20, 80]) {
    kLine.createPriceLine({
      price: value,
      color: "rgba(101,119,138,.36)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
    });
  }
  const label = document.createElement("div");
  label.className = "stoch-rsi-label";
  label.innerHTML = '<strong>STOCH RSI</strong><span class="k-line">K</span><span class="d-line">D</span><small>80 / 20</small>';
  container.append(label);
}

function renderPriceChart(id, series, movingAverages, kind, options = {}) {
  if (state.charts.has(id) || !series?.length) return;
  const container = document.getElementById(id);
  if (!container || container.clientWidth === 0) return;
  const api = chartApi(container, kind);
  if (!api) {
    container.innerHTML = '<p class="muted-copy">图表组件未能加载，状态数据仍可正常阅读。</p>';
    return;
  }
  const candle = api.addCandle({ upColor: "#16775d", downColor: "#ad4e4d", borderVisible: false, wickUpColor: "#16775d", wickDownColor: "#ad4e4d" });
  candle.setData(series.map((bar) => ({ time: bar.date || bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
  movingAverages.forEach(([key, color, title]) => {
    const showLabel = options.movingAverageLabels !== false;
    const line = api.addLine({
      color,
      lineWidth: 2,
      title: showLabel ? title : "",
      priceLineVisible: false,
      lastValueVisible: showLabel,
    });
    line.setData(series.flatMap((bar) => Number.isFinite(Number(bar[key])) ? [{ time: bar.date || bar.time, value: Number(bar[key]) }] : []));
    if (!showLabel) line.applyOptions({ title: "", priceLineVisible: false, lastValueVisible: false });
  });
  if (options.stochRsi) installStochRsi(container, api.chart, api.addLine, series);
  api.chart.timeScale().fitContent();
  if (options.visibleMonths) {
    const latestDate = series.at(-1)?.date || series.at(-1)?.time;
    if (latestDate) api.chart.timeScale().setVisibleRange({ from: shiftIsoMonths(latestDate, -options.visibleMonths), to: latestDate });
  }
  const decorationRedraws = [];
  if (options.stageBackground) decorationRedraws.push(installStageBackground(container, api.chart, series));
  if (options.stageTransitions?.length) {
    decorationRedraws.push(installStageTransitions(container, api.chart, candle, series, options.stageTransitions));
  }
  if (options.bandHistory?.length) {
    decorationRedraws.push(installBandHistoryMarkers(container, api.chart, candle, series, options.bandHistory));
  }
  const redrawDecoration = () => decorationRedraws.forEach((redraw) => redraw());
  const redrawAfterChartInteraction = () => {
    requestAnimationFrame(() => requestAnimationFrame(redrawDecoration));
  };
  container.addEventListener("pointermove", (event) => {
    if (event.buttons) redrawAfterChartInteraction();
  }, { capture: true });
  container.addEventListener("wheel", redrawAfterChartInteraction, { capture: true, passive: true });
  container.addEventListener("dblclick", redrawAfterChartInteraction, { capture: true });
  const observer = new ResizeObserver(() => {
    api.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    requestAnimationFrame(redrawDecoration);
  });
  observer.observe(container);
  state.charts.set(id, { ...api, candle, observer, redrawDecoration });
}

function renderWeeklyChart() {
  const completedSeries = seriesWithConfirmedStages(
    (state.weekly?.series || []).filter((bar) => !bar.provisional),
    state.weekly?.stageHistory,
  );
  renderPriceChart(
    "weekly-chart",
    completedSeries,
    [["ma30", "#3f82ad", "MA30"]],
    "weekly",
    { stageBackground: true, stageTransitions: state.weekly?.stageHistory, movingAverageLabels: false },
  );
}

function renderDailyChart() {
  const series = state.daily?.series || [];
  renderPriceChart(
    "daily-chart",
    series,
    [["ma20", "#b5842d", "MA20"], ["ma50", "#3f82ad", "MA50"], ["ma200", "#755fa7", "MA200"]],
    "daily",
    { bandHistory: state.daily?.bandHistory, movingAverageLabels: false, stochRsi: true, visibleMonths: 4 },
  );
}

async function loadAsset(assetId, { historyMode = "none" } = {}) {
  if (!assets[assetId]) return;
  const route = routeFromLocation();
  if (historyMode === "push") history.pushState({ assetId, route }, "", routePath(route, assetId));
  if (historyMode === "replace") history.replaceState({ assetId, route }, "", routePath(route, assetId));
  const token = state.loadToken + 1;
  state.loadToken = token;
  state.assetId = assetId;
  state.current = null;
  state.daily = null;
  state.weekly = null;
  state.fundamentals = null;
  state.routeLoads.clear();
  clearCharts();
  updateRouteLinks();
  renderWatchlist();
  $("#loading-state").hidden = false;
  $("#error-state").hidden = true;
  try {
    const current = await loadJson(new URL("current.json", dataRoot(assetId)), { attempts: 3, timeoutMs: 9000 });
    if (token !== state.loadToken || assetId !== state.assetId) return;
    state.current = current;
    updateHeader();
    renderOverview();
    renderMethodology();
    $("#loading-state").hidden = true;
    activateRoute();
  } catch (error) {
    if (token !== state.loadToken) return;
    $("#loading-state").hidden = true;
    $("#error-state").hidden = false;
    $("#error-message").textContent = error.message || "请稍后重试。";
    console.error(error);
  }
}

async function boot() {
  normalizeRoute();
  renderWatchlist();
  await loadAsset(state.assetId);
}

lockMobilePageZoom();
document.addEventListener("click", (event) => {
  const addButton = event.target.closest("#add-asset-button");
  if (addButton) {
    event.preventDefault();
    renderWatchlist();
    setAssetPicker(true);
    return;
  }
  if (event.target.closest("[data-close-asset-picker]")) {
    event.preventDefault();
    setAssetPicker(false);
    return;
  }
  const addAsset = event.target.closest("[data-add-asset]");
  if (addAsset) {
    event.preventDefault();
    const assetId = addAsset.dataset.addAsset;
    writeWatchlist([...readWatchlist(), assetId]);
    setAssetPicker(false);
    void loadAsset(assetId, { historyMode: "push" });
    return;
  }
  const assetButton = event.target.closest(".watchlist-asset[data-asset]");
  if (assetButton) {
    event.preventDefault();
    const assetId = assetButton.dataset.asset;
    if (assetId !== state.assetId) void loadAsset(assetId, { historyMode: "push" });
    return;
  }
  const retry = event.target.closest("[data-retry-route]");
  if (retry) {
    event.preventDefault();
    void ensureRouteData(retry.dataset.retryRoute, { force: true });
    return;
  }
  const link = event.target.closest("[data-route]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const route = routes.has(link.dataset.route) ? link.dataset.route : "overview";
  if (location.pathname !== routePath(route)) history.pushState({ assetId: state.assetId, route }, "", routePath(route));
  activateRoute();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#asset-picker").hidden) setAssetPicker(false);
});
window.addEventListener("popstate", () => {
  const context = locationContext();
  if (context.assetId !== state.assetId) {
    void loadAsset(context.assetId);
  } else {
    activateRoute();
  }
});

let deferredInstall;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  $("#install-button").hidden = false;
});
$("#install-button").addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("#install-button").hidden = true;
});

if ("serviceWorker" in navigator) {
  const localPreview = ["127.0.0.1", "localhost"].includes(location.hostname);
  window.addEventListener("load", async () => {
    if (localPreview) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      return;
    }
    navigator.serviceWorker.register(new URL("service-worker.js", SITE_ROOT)).catch(console.warn);
  });
}

boot();
