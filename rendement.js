/**
 * rendement.js — Portfolio Rendement Module v2.1
 * TWR + CAGR + Benchmarks (SPX / MSCI World / AEX)
 *
 * v2.1 fixes:
 * - safeNum() behandelt lege strings (""), NaN en valuta-opmaak ("€1.234,56")
 * - normalizePositie berekent waarde/pnl/gewicht als Apps Script ze leeg retourneert
 * - cashflow type-mapping: Deposit→STORTING, Withdrawal→OPNAME
 * - samenvatting.totaalWaarde altijd herberekend vanuit posities als malgeformateerd
 */

const Rendement = (() => {

  // ── BENCHMARK CONFIGURATIE ────────────────────────────────────────
  const BENCHMARK_TICKERS = { SPX: "^GSPC", MSCI_WORLD: "URTH", AEX: "^AEX" };
  const BENCHMARK_LABELS  = { SPX: "S&P 500", MSCI_WORLD: "MSCI All World", AEX: "AEX" };
  const BENCHMARK_COLORS  = { SPX: "#60a5fa", MSCI_WORLD: "#4ade80", AEX: "#fbbf24" };
  const PERIODE_MAANDEN   = { "1M":1,"3M":3,"6M":6,"YTD":0,"1J":12,"3J":36,"MAX":999 };

  // Cashflow type-mapping (Apps Script → intern formaat)
  const CF_TYPE_MAP = {
    deposit: "STORTING", storting: "STORTING", inleg: "STORTING", buy: "STORTING",
    withdrawal: "OPNAME", opname: "OPNAME", onttrekking: "OPNAME", sell: "OPNAME",
    dividend: "DIVIDEND",
  };

  // CORS-proxies voor Yahoo Finance (volgorde van voorkeur)
  const PROXIES = [
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];

  // ── MODULE STATE ──────────────────────────────────────────────────
  let cfg           = {};
  let portfolioData = null;
  let benchData     = {};
  let activePeriod  = "1J";
  let chartInstance = null;
  let toonGesloten  = false; // toggle open/gesloten posities

  // ══════════════════════════════════════════════════════════════════
  // INITIALISATIE
  // ══════════════════════════════════════════════════════════════════
  function init(config) {
    cfg = { sheetsUrl: "", benchmarks: ["SPX","MSCI_WORLD","AEX"], defaultPeriod: "1J", ...config };
    activePeriod = cfg.defaultPeriod;
    load();
  }

  async function refresh() {
    portfolioData = null;
    benchData = {};
    const badge = document.getElementById("twr-badge");
    if (badge) badge.textContent = "Vernieuwen…";
    await load();
  }

  // ══════════════════════════════════════════════════════════════════
  // HULPFUNCTIE — VEILIG GETAL PARSEN
  // Behandelt: null, undefined, "", "€ 1.234,56", "1234.56", 0
  // ══════════════════════════════════════════════════════════════════
  function safeNum(val, fallback = 0) {
    if (val == null || val === "" || val === false) return fallback;
    if (typeof val === "number") return isNaN(val) ? fallback : val;
    // Verwijder valutasymbolen, spaties, punten als duizendtalscheider
    // Vervang komma (decimaalscheider NL) door punt
    const cleaned = String(val)
      .replace(/[€$£\s]/g, "")     // valutasymbolen & spaties weg
      .replace(/\.(?=\d{3})/g, "") // punten als duizendtalscheider weg
      .replace(",", ".");           // komma → punt decimaal
    const n = parseFloat(cleaned);
    return isNaN(n) ? fallback : n;
  }

  // ══════════════════════════════════════════════════════════════════
  // DATA LADEN
  // ══════════════════════════════════════════════════════════════════
  async function load() {
    setLoading();
    try {
      const isDemo = !cfg.sheetsUrl || cfg.sheetsUrl.includes("JOUW_");
      let raw = isDemo ? getDemoData() : await fetchSheets();
      portfolioData = normalizeData(raw);

      // Gebruik server-side benchmark data als beschikbaar (geen CORS-probleem)
      // Valt terug op client-side fetch als de Apps Script ze niet meestuurt
      const serverBm = portfolioData.benchmarkData ?? {};
      const needClientFetch = [];
      for (const b of cfg.benchmarks) {
        if (serverBm[b] && serverBm[b].length > 0) {
          benchData[b] = serverBm[b];
        } else {
          needClientFetch.push(b);
        }
      }
      if (needClientFetch.length > 0) {
        await Promise.allSettled(needClientFetch.map(async b => {
          try { benchData[b] = await loadBenchmark(b); }
          catch(e) { console.warn("Benchmark", b, "client-side mislukt:", e.message); }
        }));
      }

      render(isDemo);
    } catch (err) {
      document.getElementById("content").innerHTML =
        `<div class="error">⚠ Kon data niet laden: ${escHtml(err.message)}<br><br>
         <small>Open de Apps Script URL in je browser en controleer de JSON-output.</small></div>`;
    }
  }

  async function fetchSheets() {
    const sep = cfg.sheetsUrl.includes("?") ? "&" : "?";
    const res = await fetch(cfg.sheetsUrl + sep + "action=getData");
    if (!res.ok) throw new Error("Sheets antwoord: " + res.status);
    const data = await res.json();
    if (data?.error) throw new Error(data.error);
    return data;
  }

  // ══════════════════════════════════════════════════════════════════
  // DATA NORMALISATIE
  // Accepteert elke response-structuur en vult ontbrekende velden aan
  // ══════════════════════════════════════════════════════════════════
  function normalizeData(raw) {
    if (!raw) throw new Error("Lege response van Apps Script");
    if (Array.isArray(raw)) raw = { posities: raw };

    const rawPos     = raw.posities ?? raw.positions ?? [];
    const twrHistorie = raw.twrHistorie ?? raw.twr_historie ?? raw.historie ?? [];
    const rawCF      = raw.cashflows ?? raw.transactions ?? [];

    // Normaliseer posities (vult lege velden in via safeNum + berekeningen)
    const posities = rawPos.filter(Boolean).map(normalizePositie);
    const actief   = posities.filter(p => p.aantal > 0.0001);

    // Herbereken portfolio-totalen vanuit posities (betrouwbaarder dan Apps Script output)
    const totaalWaarde     = actief.reduce((s, p) => s + p.waarde, 0);
    const totaalKostenbasis = actief.reduce((s, p) => s + p.aantal * p.gemAankoopprijs, 0);
    const totaalPnL        = actief.reduce((s, p) => s + p.pnl, 0);
    const totaalDividend   = actief.reduce((s, p) => s + p.dividend, 0);
    const totaalKosten     = actief.reduce((s, p) => s + p.kosten, 0);

    // Gewichten o.b.v. herberekende totaalWaarde
    if (totaalWaarde > 0) {
      posities.forEach(p => { p.gewicht = p.waarde / totaalWaarde; });
    }

    // TWR: gebruik Apps Script waarde als die > 0 is, anders proxy van kostenbasis
    const rawTwr = safeNum(raw.samenvatting?.twr ?? raw.twr, null);
    const twr        = (rawTwr != null && rawTwr !== 0)
      ? rawTwr
      : (totaalKostenbasis > 0 ? totaalPnL / totaalKostenbasis : 0);
    const twrIsProxy = rawTwr == null || rawTwr === 0;

    const samenvatting = {
      totaalWaarde, totaalPnL, totaalDividend, totaalKosten,
      twr, twrIsProxy,
      cagr: safeNum(raw.samenvatting?.cagr, null),
    };

    // Meta
    const meta = {
      gegenereerd:   raw.meta?.gegenereerd ?? raw.lastUpdated ?? new Date().toISOString(),
      basisvaluta:   raw.meta?.basisvaluta ?? "EUR",
      startdatum:    raw.meta?.startdatum ?? raw.startDate ?? eersteAankoopDatum(rawPos),
      startkapitaal: safeNum(raw.meta?.startkapitaal, totaalKostenbasis),
    };

    // Cashflows — normaliseer type-namen
    const cashflows = rawCF.map(c => ({
      ...c,
      bedrag: safeNum(c.bedrag ?? c.amount, 0),
      type:   CF_TYPE_MAP[(c.type ?? "").toLowerCase()] ?? (c.type ?? "OVERIG").toUpperCase(),
    }));

    return { samenvatting, meta, posities, twrHistorie, cashflows };
  }

  function normalizePositie(p) {
    const aantal          = safeNum(p.aantal ?? p.shares ?? p.qty, 0);
    const gemAankoopprijs = safeNum(p.gemAankoopprijs ?? p.avgPrice ?? p.costBasis, 0);
    const huidig          = safeNum(p.huidig ?? p.currentPrice ?? p.price, 0);

    // waarde: gebruik meegeleverde waarde als die geldig is, anders bereken
    const rawWaarde = safeNum(p.waarde ?? p.currentValue ?? p.marketValue, null);
    const waarde    = (rawWaarde != null && rawWaarde > 0) ? rawWaarde : (aantal * huidig);

    // pnl: gebruik meegeleverde waarde als die geldig is, anders bereken
    const rawPnl = safeNum(p.pnl ?? p.unrealizedPnl, null);
    const pnl    = rawPnl != null ? rawPnl : (waarde - aantal * gemAankoopprijs);

    return {
      product:         p.product ?? p.name ?? p.ticker ?? "Onbekend",
      isin:            p.isin ?? p.symbol ?? "",
      aantal,
      gemAankoopprijs,
      huidig:          huidig > 0 ? huidig : (aantal > 0 ? waarde / aantal : 0),
      waarde,
      pnl,
      dividend:        safeNum(p.dividend ?? p.dividendReceived, 0),
      kosten:          safeNum(p.kosten ?? p.fees ?? p.transactionCosts, 0),
      gewicht:         safeNum(p.gewicht ?? p.weight, 0), // wordt herberekend in normalizeData
    };
  }

  function eersteAankoopDatum(posities) {
    const datums = (posities ?? [])
      .map(p => p.aankoopDatum ?? p.purchaseDate ?? p.firstBuyDate)
      .filter(Boolean).sort();
    return datums[0] ?? new Date(new Date().setFullYear(new Date().getFullYear() - 1))
      .toISOString().substring(0, 10);
  }

  // ══════════════════════════════════════════════════════════════════
  // BENCHMARK LADEN
  // ══════════════════════════════════════════════════════════════════
  async function loadBenchmark(key) {
    const ticker   = BENCHMARK_TICKERS[key];
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1mo&range=5y`;

    for (const makeProxy of PROXIES) {
      try {
        const res = await fetch(makeProxy(yahooUrl), { signal: AbortSignal.timeout(9000) });
        if (!res.ok) continue;
        const json = await res.json();
        const chart  = json?.chart?.result?.[0];
        const ts     = chart?.timestamp ?? [];
        const closes = chart?.indicators?.adjclose?.[0]?.adjclose
                    ?? chart?.indicators?.quote?.[0]?.close ?? [];
        const punten = ts
          .map((t, i) => ({ datum: new Date(t*1000).toISOString().substring(0,10), koers: closes[i] }))
          .filter(d => d.koers != null && !isNaN(d.koers));
        if (punten.length > 0) return punten;
      } catch (_) {}
    }
    return [];
  }

  // ══════════════════════════════════════════════════════════════════
  // BEREKENINGEN
  // ══════════════════════════════════════════════════════════════════
  function berekenCAGR(twr, aantalJaren) {
    if (!isFinite(aantalJaren) || aantalJaren <= 0) return null;
    if (!isFinite(twr)) return null;
    return Math.pow(1 + twr, 1 / aantalJaren) - 1;
  }

  function normaliseerBenchmark(serie, startDatum) {
    const gefilterd = (serie ?? []).filter(d => d.datum >= startDatum);
    if (gefilterd.length < 2) return [];
    const basis = gefilterd[0].koers;
    return basis ? gefilterd.map(d => ({ datum: d.datum, rendement: d.koers / basis - 1 })) : [];
  }

  function getStartDatum(periode) {
    const nu = new Date();
    if (periode === "YTD") return `${nu.getFullYear()}-01-01`;
    if (periode === "MAX") return "2000-01-01";
    const d = new Date(nu);
    d.setMonth(d.getMonth() - (PERIODE_MAANDEN[periode] ?? 12));
    return d.toISOString().substring(0, 10);
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════
  function setLoading() {
    document.getElementById("content").innerHTML =
      `<div class="loading">Data laden<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>`;
  }

  function render(isDemo = false) {
    const { samenvatting, meta, cashflows = [], twrHistorie = [], posities = [] } = portfolioData;
    const startDatum  = getStartDatum(activePeriod);
    const nu          = new Date();
    const aantalJaren = (nu - new Date(meta.startdatum ?? startDatum)) / (365.25*24*3600*1000);
    const cagr        = berekenCAGR(samenvatting.twr, aantalJaren);
    const twr         = samenvatting.twr ?? 0;

    // Badge
    const badge = document.getElementById("twr-badge");
    if (badge) {
      badge.textContent  = `${samenvatting.twrIsProxy ? "P&L" : "TWR"} ${twr >= 0 ? "+" : ""}${(twr*100).toFixed(2)}%`;
      badge.style.color       = twr >= 0 ? "var(--pos)" : "var(--neg)";
      badge.style.borderColor = twr >= 0 ? "rgba(74,222,128,0.35)" : "rgba(248,113,113,0.35)";
      badge.style.background  = twr >= 0 ? "rgba(74,222,128,0.1)"  : "rgba(248,113,113,0.1)";
    }

    // Timestamp
    const lu = document.getElementById("last-update");
    if (lu && meta.gegenereerd) {
      lu.textContent = "bijgewerkt: " + new Date(meta.gegenereerd).toLocaleString("nl-NL",
        { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
    }

    let html = "";
    if (isDemo) html += `<div class="warn-box">⚠ Demo-modus — vul <strong>sheetsUrl</strong> in rendement.html in.</div>`;
    if (samenvatting.twrIsProxy && !isDemo) {
      html += `<div class="warn-box">ℹ Rendement = <strong>P&L / kostenbasis</strong> (geen gecorrigeerde TWR). Voeg <code>twrHistorie</code> toe aan je Apps Script voor echte Time-Weighted Return.</div>`;
    }

    const actief    = posities.filter(p => p.aantal > 0.0001);
    const gesloten  = portfolioData.geslotenPosities ?? [];

    html += renderSectionTitle("Portefeuille Samenvatting");
    html += renderKpiGrid(samenvatting, cagr, gesloten);
    html += renderGrafiekSectie();
    html += renderSectionTitle(`Benchmark Vergelijking — ${activePeriod}`);
    html += renderBenchmarkGrid(startDatum, twr);

    // Posities header met toggle
    html += renderPositiesSectionHeader(actief.length, gesloten.length);
    if (!toonGesloten) {
      html += renderPosTable(actief, samenvatting.totaalWaarde);
    } else {
      html += renderGeslotenTable(gesloten);
    }

    if (cashflows.length > 0) {
      html += renderSectionTitle("Cashflows");
      html += renderCashflowGrid(cashflows);
    }
    html += renderSectionTitle("Methodologie");
    html += renderMethodologie(samenvatting.twrIsProxy);

    document.getElementById("content").innerHTML = html;
    requestAnimationFrame(() => drawChart(startDatum, twrHistorie));
  }

  // ── Render helpers ────────────────────────────────────────────────
  function renderSectionTitle(t) { return `<div class="section-title">${t}</div>\n`; }

  function renderPositiesSectionHeader(aantalOpen, aantalGesloten) {
    const actief  = !toonGesloten;
    return `
<div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
  <span>${actief ? `Open posities (${aantalOpen})` : `Gesloten posities (${aantalGesloten})`}</span>
  <div style="display:flex;gap:6px">
    <button class="pf${actief ? " active" : ""}" onclick="Rendement._setGesloten(false)">Open</button>
    <button class="pf${!actief ? " active" : ""}" onclick="Rendement._setGesloten(true)">Gesloten</button>
  </div>
</div>`;
  }

  function renderGeslotenTable(gesloten) {
    if (!gesloten || gesloten.length === 0) {
      return `<div class="pos-table-wrap"><div style="padding:2rem;text-align:center;color:var(--muted);font-family:'DM Mono',monospace;font-size:12px">Geen gesloten posities gevonden</div></div>`;
    }
    const gesorteerd = [...gesloten].sort((a, b) => (b.gerealiseerd ?? 0) - (a.gerealiseerd ?? 0));
    const totaalGerealiseerd = gesorteerd.reduce((s, p) => s + (p.gerealiseerd ?? 0), 0);
    const rijen = gesorteerd.map(p => {
      const ger = p.gerealiseerd ?? 0;
      return `<tr>
        <td><div class="prod-name">${escHtml(p.product ?? "—")}</div><div class="prod-isin">${escHtml(p.isin ?? "")}</div></td>
        <td style="color:var(--muted);font-size:11px">${escHtml(p.lastDatum ?? "—")}</td>
        <td class="${ger >= 0 ? "pos" : "neg"}">${fmtEUR(ger, 0)}</td>
        <td class="pos">${fmtEUR(p.dividend ?? 0, 0)}</td>
        <td class="neg">-${fmtEUR(p.kosten ?? 0, 0)}</td>
        <td class="${(ger + (p.dividend??0) - (p.kosten??0)) >= 0 ? "pos":"neg"}">${fmtEUR(ger + (p.dividend??0) - (p.kosten??0), 0)}</td>
      </tr>`;
    }).join("");
    return `
<div class="pos-table-wrap">
  <div class="pos-table-header">
    <div class="pos-table-title">Gerealiseerde posities</div>
    <div class="pos-count ${totaalGerealiseerd >= 0 ? "pos":"neg"}">${fmtEUR(totaalGerealiseerd, 0)} totaal</div>
  </div>
  <div style="overflow-x:auto">
    <table class="positions">
      <thead><tr>
        <th>Product</th><th>Laatste transactie</th><th>Gerealiseerd P&amp;L</th>
        <th>Dividend</th><th>Kosten</th><th>Netto resultaat</th>
      </tr></thead>
      <tbody>${rijen}</tbody>
    </table>
  </div>
</div>`;
  }

  function renderKpiGrid(samenvatting, cagr, gesloten) {
    const twr = samenvatting.twr ?? 0;
    const totaalGerealiseerd = samenvatting.totaalGerealiseerd ??
      (gesloten ?? []).reduce((s, p) => s + (p.gerealiseerd ?? 0), 0);
    return `
<div class="kpi-grid">
  <div class="kpi-card gold-accent">
    <div class="kpi-label">Portefeuillewaarde</div>
    <div class="kpi-value gold">${fmtEUR(samenvatting.totaalWaarde, 0)}</div>
    <div class="kpi-sub">incl. ongerealiseerd</div>
  </div>
  <div class="kpi-card ${twr >= 0 ? "pos-accent":"neg-accent"}">
    <div class="kpi-label">${samenvatting.twrIsProxy ? "P&L Rendement" : "TWR"} (${activePeriod})</div>
    <div class="kpi-value ${twr >= 0 ? "pos":"neg"}">${fmtPct(twr)}</div>
    <div class="kpi-sub">${samenvatting.twrIsProxy ? "kostenbasis rendement" : "Time-Weighted Return"}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">CAGR (jaarl.)</div>
    <div class="kpi-value ${(cagr ?? 0) >= 0 ? "pos":"neg"}">${cagr != null ? fmtPct(cagr) : "—"}</div>
    <div class="kpi-sub">samengesteld jaarrendement</div>
  </div>
  <div class="kpi-card ${(samenvatting.totaalPnL ?? 0) >= 0 ? "pos-accent":"neg-accent"}">
    <div class="kpi-label">Ongerealiseerd P&amp;L</div>
    <div class="kpi-value ${(samenvatting.totaalPnL ?? 0) >= 0 ? "pos":"neg"}">${fmtEUR(samenvatting.totaalPnL ?? 0, 0)}</div>
    <div class="kpi-sub">t.o.v. aankoopprijs</div>
  </div>
  <div class="kpi-card pos-accent">
    <div class="kpi-label">Dividend ontvangen</div>
    <div class="kpi-value pos">${fmtEUR(samenvatting.totaalDividend ?? 0, 0)}</div>
    <div class="kpi-sub">netto ontvangen</div>
  </div>
  <div class="kpi-card neg-accent">
    <div class="kpi-label">Transactiekosten</div>
    <div class="kpi-value neg">-${fmtEUR(samenvatting.totaalKosten ?? 0, 0)}</div>
    <div class="kpi-sub">broker + taks</div>
  </div>
  <div class="kpi-card ${totaalGerealiseerd >= 0 ? "pos-accent":"neg-accent"}" style="display:${totaalGerealiseerd !== 0 ? 'block' : 'none'}">
    <div class="kpi-label">Gerealiseerd P&amp;L</div>
    <div class="kpi-value ${totaalGerealiseerd >= 0 ? "pos":"neg"}">${fmtEUR(totaalGerealiseerd, 0)}</div>
    <div class="kpi-sub">gesloten posities</div>
  </div>
</div>`;
  }

  function renderGrafiekSectie() {
    const periodes = ["1M","3M","6M","YTD","1J","3J","MAX"];
    const knoppen  = periodes.map(p =>
      `<button class="pf${activePeriod===p?" active":""}" onclick="Rendement._setPeriod('${p}')">${p}</button>`
    ).join("");
    const legPort = `<div class="leg-item"><div class="leg-dot" style="background:#fbbf24"></div>Portfolio</div>`;
    const legBm   = cfg.benchmarks.map(b =>
      `<div class="leg-item"><div class="leg-dot" style="background:${BENCHMARK_COLORS[b]}"></div>${BENCHMARK_LABELS[b]}</div>`
    ).join("");
    return `
<div class="chart-wrap">
  <div class="chart-top">
    <div class="chart-title">Rendement vs Benchmarks</div>
    <div class="period-filters">${knoppen}</div>
  </div>
  <div class="chart-legend">${legPort}${legBm}</div>
  <canvas id="rend-chart" height="180"></canvas>
</div>`;
  }

  function renderBenchmarkGrid(startDatum, portTWR) {
    return `<div class="bm-grid">${cfg.benchmarks.map(b => renderBmKaart(b, startDatum, portTWR)).join("")}</div>`;
  }

  function renderBmKaart(key, startDatum, portTWR) {
    const kleur  = BENCHMARK_COLORS[key];
    const genorm = normaliseerBenchmark(benchData[key] ?? [], startDatum);
    if (genorm.length === 0) {
      return `<div class="bm-card" style="border-left:3px solid ${kleur}">
        <div class="bm-name">${BENCHMARK_LABELS[key]}</div>
        <div class="bm-return neu">Laden…</div></div>`;
    }
    const rend  = genorm[genorm.length - 1].rendement;
    const outpf = portTWR - rend;
    return `<div class="bm-card" style="border-left:3px solid ${kleur}">
      <div class="bm-name">${BENCHMARK_LABELS[key]}</div>
      <div class="bm-return ${rend >= 0 ? "pos":"neg"}">${fmtPct(rend)}</div>
      <div class="bm-vs ${outpf >= 0 ? "pos":"neg"}">
        <span>vs portfolio:</span>${outpf >= 0 ? "+" : ""}${(outpf*100).toFixed(2)}%
      </div></div>`;
  }

  function renderPosTable(posities, totaalWaarde) {
    if (posities.length === 0) return `<div class="pos-table-wrap"><div style="padding:2rem;text-align:center;color:var(--muted);font-family:'DM Mono',monospace;font-size:12px">Geen open posities</div></div>`;
    const gesorteerd = [...posities].sort((a, b) => b.waarde - a.waarde);
    const rijen = gesorteerd.map(p => {
      const pnlPct = p.gemAankoopprijs > 0 ? (p.huidig / p.gemAankoopprijs - 1) : 0;
      const gew    = Math.min((p.gewicht ?? 0) * 100, 100);
      return `<tr>
        <td><div class="prod-name">${escHtml(p.product)}</div><div class="prod-isin">${escHtml(p.isin)}</div></td>
        <td>${fmtNummer(p.aantal, 4)}</td>
        <td>${fmtEUR(p.gemAankoopprijs, 2)}</td>
        <td>${fmtEUR(p.waarde, 0)}</td>
        <td class="pos">${fmtEUR(p.dividend, 0)}</td>
        <td class="${p.pnl >= 0 ? "pos":"neg"}">${fmtEUR(p.pnl, 0)}</td>
        <td class="${pnlPct >= 0 ? "pos":"neg"}">${fmtPct(pnlPct)}</td>
        <td><div class="gewicht-bar">
          <span style="font-family:'DM Mono',monospace;font-size:11px">${gew.toFixed(1)}%</span>
          <div class="bar-track"><div class="bar-fill" style="width:${gew.toFixed(1)}%"></div></div>
        </div></td>
      </tr>`;
    }).join("");
    return `
<div class="pos-table-wrap">
  <div class="pos-table-header">
    <div class="pos-table-title">Portefeuille holdings</div>
    <div class="pos-count">${fmtEUR(totaalWaarde, 0)} totaal</div>
  </div>
  <div style="overflow-x:auto">
    <table class="positions">
      <thead><tr>
        <th>Product</th><th>Aantal</th><th>Gem. prijs</th><th>Huidige waarde</th>
        <th>Dividend</th><th>P&amp;L</th><th>P&amp;L %</th><th>Gewicht</th>
      </tr></thead>
      <tbody>${rijen}</tbody>
    </table>
  </div>
</div>`;
  }

  function renderCashflowGrid(cashflows) {
    const totaalStorting = cashflows.filter(c => c.type === "STORTING").reduce((s,c) => s + Math.abs(c.bedrag), 0);
    const totaalOpname   = cashflows.filter(c => c.type === "OPNAME").reduce((s,c) => s + Math.abs(c.bedrag), 0);
    return `<div class="cf-grid">
      <div class="cf-card"><div class="cf-label">Totaal ingelegd</div><div class="cf-val gold">${fmtEUR(totaalStorting, 0)}</div></div>
      <div class="cf-card"><div class="cf-label">Totaal onttrokken</div><div class="cf-val neg">-${fmtEUR(totaalOpname, 0)}</div></div>
    </div>`;
  }

  function renderMethodologie(isProxy) {
    const uitleg = isProxy
      ? `<strong>P&L Rendement</strong> — (huidige waarde − kostenbasis) / kostenbasis. Geen cashflow-correctie.
         <br><br>Voor echte <strong>TWR</strong>: voeg <code>twrHistorie: [{ datum, twr }, …]</code> toe aan je Apps Script output.`
      : `<strong>Time-Weighted Return (TWR)</strong> — elimineert externe cashflows.
         Formule: <strong>(EindWaarde − Cashflow) / StartWaarde − 1</strong> per subperiode, geketend.`;
    return `<div class="method-box">${uitleg}<br><br>
      <strong>CAGR</strong> = <strong>(1 + TWR)^(1/jaren) − 1</strong><br><br>
      Benchmarks: S&amp;P 500 (^GSPC), MSCI All World (URTH proxy), AEX (^AEX) via Yahoo Finance.
    </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // CHART
  // ══════════════════════════════════════════════════════════════════
  function drawChart(startDatum, twrHistorie) {
    const canvas = document.getElementById("rend-chart");
    if (!canvas) return;
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    const datasets = [];

    // Portfolio lijn (alleen als er historische data is)
    const portData = (twrHistorie ?? [])
      .filter(h => h?.datum >= startDatum)
      .map(h => ({ x: h.datum.substring(0,7), y: +((h.twr ?? 0) * 100).toFixed(3) }));
    if (portData.length >= 2) {
      datasets.push({
        label: "Portfolio (TWR)", data: portData,
        borderColor: "#fbbf24", backgroundColor: "rgba(251,191,36,0.08)",
        borderWidth: 2, pointRadius: 0, tension: 0.35, fill: true, order: 0,
      });
    }

    // Benchmarks
    for (const key of cfg.benchmarks) {
      const genorm = normaliseerBenchmark(benchData[key] ?? [], startDatum);
      if (genorm.length < 2) continue;
      datasets.push({
        label: BENCHMARK_LABELS[key],
        data: genorm.map(d => ({ x: d.datum.substring(0,7), y: +(d.rendement*100).toFixed(3) })),
        borderColor: BENCHMARK_COLORS[key], backgroundColor: "transparent",
        borderWidth: 1.5, pointRadius: 0, tension: 0.35, fill: false, order: 1,
      });
    }

    if (datasets.length === 0) {
      canvas.insertAdjacentHTML("afterend",
        `<div style="text-align:center;color:var(--muted);font-family:'DM Mono',monospace;font-size:12px;padding:2rem 0">
          Geen grafiekdata — controleer internetverbinding</div>`);
      return;
    }

    chartInstance = new Chart(canvas, {
      type: "line", data: { datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#12121a", borderColor: "#1e1e2e", borderWidth: 1,
            titleColor: "#5a5a7a", bodyColor: "#e8e8f0",
            callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y >= 0 ? "+" : ""}${ctx.parsed.y.toFixed(2)}%` },
          },
        },
        scales: {
          x: { type:"category", grid:{color:"#1e1e2e"}, ticks:{color:"#5a5a7a",maxTicksLimit:8,font:{family:"DM Mono",size:10}} },
          y: { grid:{color:"#1e1e2e"}, ticks:{color:"#5a5a7a",font:{family:"DM Mono",size:10},callback:v=>`${v>=0?"+":""}${v.toFixed(1)}%`} },
        },
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PERIODE WISSELEN
  // ══════════════════════════════════════════════════════════════════
  function setPeriod(p) {
    activePeriod = p;
    if (portfolioData) render(!cfg.sheetsUrl || cfg.sheetsUrl.includes("JOUW_"));
  }

  // ══════════════════════════════════════════════════════════════════
  // OPMAAK
  // ══════════════════════════════════════════════════════════════════
  function fmtEUR(waarde, decimals = 0) {
    const n = safeNum(waarde, null);
    if (n == null) return "—";
    return new Intl.NumberFormat("nl-NL", { style:"currency", currency:"EUR", maximumFractionDigits:decimals }).format(n);
  }
  function fmtPct(waarde) {
    const n = safeNum(waarde, null);
    if (n == null) return "—";
    return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
  }
  function fmtNummer(waarde, decimals = 2) {
    const n = safeNum(waarde, null);
    if (n == null) return "—";
    return new Intl.NumberFormat("nl-NL", { maximumFractionDigits:decimals }).format(n);
  }
  function escHtml(str) {
    return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ══════════════════════════════════════════════════════════════════
  // DEMO DATA
  // ══════════════════════════════════════════════════════════════════
  function getDemoData() {
    const nu = new Date();
    const startdatum = new Date(nu.getFullYear()-2, nu.getMonth(), 1);
    const historie = [];
    let twr = 0;
    for (let i = 24; i >= 0; i--) {
      const d = new Date(nu); d.setMonth(d.getMonth() - i);
      twr += (Math.random() - 0.40) * 0.025;
      historie.push({ datum: d.toISOString().substring(0,10), twr });
    }
    return {
      meta: { gegenereerd: new Date().toISOString(), basisvaluta:"EUR", startdatum: startdatum.toISOString().substring(0,10), startkapitaal:10000 },
      samenvatting: { totaalWaarde:24350, totaalDividend:820, totaalKosten:145, totaalPnL:4350, twr, twrIsProxy:false },
      posities: [
        { isin:"IE00B4L5Y983", product:"iShares Core MSCI World", aantal:45, gemAankoopprijs:88.20, huidig:98.50, waarde:4432.50, kosten:18.40, dividend:0,     pnl:463.50,  gewicht:0.182 },
        { isin:"IE00B3RBWM25", product:"Vanguard FTSE All-World",  aantal:62, gemAankoopprijs:97.10, huidig:110.80,waarde:6869.60, kosten:24.10, dividend:142.30,pnl:849.40,  gewicht:0.282 },
        { isin:"NL0011821202", product:"ASML Holding NV",           aantal:8,  gemAankoopprijs:620,   huidig:710.50,waarde:5684.00, kosten:32.00, dividend:64.40, pnl:724.00,  gewicht:0.233 },
        { isin:"US5949181045", product:"Microsoft Corporation",     aantal:15, gemAankoopprijs:280,   huidig:415.20,waarde:5738.40, kosten:38.50, dividend:38.70, pnl:2028.00, gewicht:0.236 },
        { isin:"IE00BKX55T58", product:"Vanguard S&P 500 ETF",      aantal:18, gemAankoopprijs:80.50, huidig:90.20, waarde:1623.60, kosten:8.20,  dividend:22.80, pnl:174.60,  gewicht:0.067 },
      ],
      twrHistorie: historie,
      cashflows: [
        { datum:"2023-01-15", type:"STORTING", bedrag:10000 },
        { datum:"2023-07-01", type:"STORTING", bedrag:5000  },
        { datum:"2024-01-10", type:"STORTING", bedrag:5000  },
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // PUBLIEKE API
  // ══════════════════════════════════════════════════════════════════
  return {
    init, refresh,
    _setPeriod: setPeriod,
    _setGesloten: (v) => {
      toonGesloten = v;
      if (portfolioData) render(!cfg.sheetsUrl || cfg.sheetsUrl.includes("JOUW_"));
    },
    _debug: () => console.log("portfolioData:", portfolioData, "\nbenchData:", benchData),
  };

})();
