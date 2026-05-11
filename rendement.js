/**
 * rendement.js — Portfolio Rendement Module v2
 * TWR + CAGR + Benchmarks (SPX / MSCI World / AEX)
 * Databron: Google Sheets Web App + Yahoo Finance
 *
 * FIXES v2:
 * - Robuuste data-normalisatie: werkt ook als Apps Script alleen posities retourneert
 * - Samenvatting wordt berekend vanuit posities als die ontbreken
 * - Chart rendert altijd (benchmarks), portfolio-lijn optioneel
 * - Betrouwbaardere benchmark fetch (meerdere fallback proxies)
 * - Null-safe rendering overal
 * - TWR proxy (kostenbasis) als twrHistorie niet beschikbaar is
 */

const Rendement = (() => {

  // ── BENCHMARK CONFIGURATIE ────────────────────────────────────────
  const BENCHMARK_TICKERS = {
    SPX:        "^GSPC",
    MSCI_WORLD: "URTH",
    AEX:        "^AEX",
  };
  const BENCHMARK_LABELS = {
    SPX:        "S&P 500",
    MSCI_WORLD: "MSCI All World",
    AEX:        "AEX",
  };
  const BENCHMARK_COLORS = {
    SPX:        "#60a5fa",
    MSCI_WORLD: "#4ade80",
    AEX:        "#fbbf24",
  };
  const PERIODE_MAANDEN = {
    "1M": 1, "3M": 3, "6M": 6, "YTD": 0, "1J": 12, "3J": 36, "MAX": 999,
  };

  // Fallback CORS proxies voor Yahoo Finance (in volgorde van voorkeur)
  const PROXIES = [
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://cors-anywhere.herokuapp.com/${url}`,
  ];

  // ── MODULE STATE ──────────────────────────────────────────────────
  let cfg          = {};
  let portfolioData = null;
  let benchData    = {};
  let activePeriod = "1J";
  let chartInstance = null;

  // ══════════════════════════════════════════════════════════════════
  // INITIALISATIE
  // ══════════════════════════════════════════════════════════════════
  function init(config) {
    cfg = {
      sheetsUrl:     "",
      benchmarks:    ["SPX", "MSCI_WORLD", "AEX"],
      defaultPeriod: "1J",
      ...config,
    };
    activePeriod = cfg.defaultPeriod;
    load();
  }

  async function refresh() {
    portfolioData = null;
    benchData     = {};
    const badge = document.getElementById("twr-badge");
    if (badge) badge.textContent = "Vernieuwen…";
    await load();
  }

  // ══════════════════════════════════════════════════════════════════
  // DATA LADEN
  // ══════════════════════════════════════════════════════════════════
  async function load() {
    setLoading();
    try {
      // Haal portfolio data op
      let raw = null;
      const isDemo = !cfg.sheetsUrl || cfg.sheetsUrl.includes("JOUW_");

      if (isDemo) {
        raw = getDemoData();
      } else {
        const url = cfg.sheetsUrl + (cfg.sheetsUrl.includes("?") ? "&" : "?") + "action=getData";
        const res = await fetch(url);
        if (!res.ok) throw new Error("Sheets antwoord: " + res.status);
        raw = await res.json();
        if (raw && raw.error) throw new Error(raw.error);
      }

      // Normaliseer — vult ontbrekende velden in vanuit posities
      portfolioData = normalizeData(raw);

      // Benchmarks parallel laden
      const resultaten = await Promise.allSettled(
        cfg.benchmarks.map(b => loadBenchmark(b))
      );
      resultaten.forEach((r, i) => {
        if (r.status === "fulfilled") benchData[cfg.benchmarks[i]] = r.value;
        else console.warn(`Benchmark ${cfg.benchmarks[i]} niet geladen:`, r.reason);
      });

      render(isDemo);

    } catch (err) {
      document.getElementById("content").innerHTML =
        `<div class="error">
          ⚠ Kon data niet laden: ${escHtml(err.message)}<br><br>
          Controleer de <strong>sheetsUrl</strong> in rendement.html.<br>
          <small style="color:var(--muted)">Open de Apps Script URL in je browser om de JSON-output te controleren.</small>
        </div>`;
    }
  }

  /**
   * normalizeData — het hart van de fix.
   * Accepteert elke structuur die de Apps Script retourneert en
   * vult alle verwachte velden in vanuit wat er WEL beschikbaar is.
   *
   * Ondersteunde input-formaten:
   *  A) { posities: [...] }                           — alleen posities
   *  B) { posities: [...], samenvatting: {...}, ... } — volledig formaat
   *  C) [...]                                          — array van posities (direct)
   */
  function normalizeData(raw) {
    if (!raw) throw new Error("Lege response van Apps Script");

    // Formaat C: array op het hoogste niveau → wrap
    if (Array.isArray(raw)) raw = { posities: raw };

    const posities   = (raw.posities   || []).filter(Boolean);
    const cashflows  = (raw.cashflows  || []);
    const twrHistorie = (raw.twrHistorie || raw.twr_historie || raw.historie || []);

    // ── Bereken samenvatting vanuit posities als die ontbreekt ──────
    const actievePos = posities.filter(p => {
      const n = parseFloat(p.aantal ?? p.shares ?? p.qty ?? 0);
      return n > 0.0001;
    });

    const totaalWaarde = actievePos.reduce((s, p) => {
      return s + parseFloat(p.waarde ?? p.currentValue ?? p.marketValue ?? 0);
    }, 0);

    const totaalKostenbasis = actievePos.reduce((s, p) => {
      const aantal  = parseFloat(p.aantal ?? p.shares ?? p.qty ?? 0);
      const aankoopprijs = parseFloat(p.gemAankoopprijs ?? p.avgPrice ?? p.costBasis ?? 0);
      return s + (aantal * aankoopprijs);
    }, 0);

    const totaalPnL = actievePos.reduce((s, p) => {
      const val = parseFloat(p.pnl ?? p.unrealizedPnl ?? 0);
      if (val !== 0) return s + val;
      // Bereken zelf als pnl niet aanwezig is
      const waarde = parseFloat(p.waarde ?? p.currentValue ?? 0);
      const aantal = parseFloat(p.aantal ?? p.shares ?? 0);
      const aankoopprijs = parseFloat(p.gemAankoopprijs ?? p.avgPrice ?? 0);
      return s + (waarde - aantal * aankoopprijs);
    }, 0);

    const totaalDividend = actievePos.reduce((s, p) =>
      s + parseFloat(p.dividend ?? p.dividendReceived ?? 0), 0);

    const totaalKosten = actievePos.reduce((s, p) =>
      s + parseFloat(p.kosten ?? p.transactionCosts ?? p.fees ?? 0), 0);

    // TWR: gebruik meegeleverde waarde, anders simpele rendement op kostenbasis
    let twr = 0;
    if (raw.samenvatting?.twr != null) {
      twr = parseFloat(raw.samenvatting.twr);
    } else if (raw.twr != null) {
      twr = parseFloat(raw.twr);
    } else if (totaalKostenbasis > 0) {
      // Proxy TWR = eenvoudig rendement (P&L / kostenbasis).
      // Elimineert géén cashflows — geeft aan in UI.
      twr = totaalPnL / totaalKostenbasis;
    }

    const samenvatting = {
      totaalWaarde:   raw.samenvatting?.totaalWaarde   ?? totaalWaarde,
      totaalPnL:      raw.samenvatting?.totaalPnL      ?? totaalPnL,
      totaalDividend: raw.samenvatting?.totaalDividend ?? totaalDividend,
      totaalKosten:   raw.samenvatting?.totaalKosten   ?? totaalKosten,
      twr:            raw.samenvatting?.twr             ?? twr,
      twrIsProxy:     raw.samenvatting?.twr == null,   // true = berekend vanuit kostenbasis
    };

    const meta = {
      gegenereerd:   raw.meta?.gegenereerd   ?? raw.lastUpdated ?? new Date().toISOString(),
      basisvaluta:   raw.meta?.basisvaluta   ?? "EUR",
      startdatum:    raw.meta?.startdatum    ?? raw.startDate ?? berekenStartdatumVanPosities(posities),
      startkapitaal: raw.meta?.startkapitaal ?? totaalKostenbasis,
    };

    // Normaliseer positie-velden naar consistent formaat
    const normalizedPosities = posities.map(p => normalizePositie(p));

    return { samenvatting, meta, posities: normalizedPosities, twrHistorie, cashflows };
  }

  /** Normaliseer één positie naar het verwachte formaat */
  function normalizePositie(p) {
    const aantal        = parseFloat(p.aantal ?? p.shares ?? p.qty ?? 0);
    const gemAankoopprijs = parseFloat(p.gemAankoopprijs ?? p.avgPrice ?? p.costBasis ?? 0);
    const huidig        = parseFloat(p.huidig ?? p.currentPrice ?? p.price ?? (aantal > 0 ? (p.waarde ?? 0) / aantal : 0));
    const waarde        = parseFloat(p.waarde ?? p.currentValue ?? p.marketValue ?? (aantal * huidig));
    const pnl           = parseFloat(p.pnl ?? p.unrealizedPnl ?? (waarde - aantal * gemAankoopprijs));
    const dividend      = parseFloat(p.dividend ?? p.dividendReceived ?? 0);
    const kosten        = parseFloat(p.kosten ?? p.fees ?? 0);
    const totaalInvest  = aantal * gemAankoopprijs;
    const totaalPort    = parseFloat(p._totaalPortfolio ?? 0); // wordt hieronder gezet
    return {
      product:         p.product ?? p.name ?? p.ticker ?? "Onbekend",
      isin:            p.isin ?? p.symbol ?? "",
      aantal, gemAankoopprijs, huidig, waarde, pnl, dividend, kosten,
      gewicht:         parseFloat(p.gewicht ?? p.weight ?? 0), // wordt hieronder herberekend
    };
  }

  /** Herbereken gewichten o.b.v. totaalWaarde */
  function herberekeningGewichten(posities, totaalWaarde) {
    if (totaalWaarde <= 0) return posities;
    return posities.map(p => ({
      ...p,
      gewicht: p.gewicht > 0 ? p.gewicht : (totaalWaarde > 0 ? p.waarde / totaalWaarde : 0),
    }));
  }

  /** Schat startdatum vanuit de oudste aankoopdatum in posities */
  function berekenStartdatumVanPosities(posities) {
    const datums = posities
      .map(p => p.aankoopDatum ?? p.purchaseDate ?? p.firstBuyDate)
      .filter(Boolean)
      .sort();
    return datums[0] ?? new Date(new Date().setFullYear(new Date().getFullYear() - 2))
      .toISOString().substring(0, 10);
  }

  // ── BENCHMARK LADEN ───────────────────────────────────────────────
  async function loadBenchmark(key) {
    const ticker = BENCHMARK_TICKERS[key];
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1mo&range=5y`;

    let lastErr = null;
    for (const makeProxy of PROXIES) {
      try {
        const res = await fetch(makeProxy(yahooUrl), { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        const chart = json?.chart?.result?.[0];
        const ts     = chart?.timestamp ?? [];
        const closes = chart?.indicators?.adjclose?.[0]?.adjclose
                    ?? chart?.indicators?.quote?.[0]?.close
                    ?? [];
        const punten = [];
        for (let i = 0; i < ts.length; i++) {
          const k = closes[i];
          if (k != null && !isNaN(k)) {
            punten.push({ datum: new Date(ts[i] * 1000).toISOString().substring(0, 10), koers: k });
          }
        }
        if (punten.length > 0) return punten;
        throw new Error("Lege koersenreeks");
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("Alle proxies mislukt voor " + key);
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDEMENT BEREKENINGEN
  // ══════════════════════════════════════════════════════════════════

  /** Modified Dietz TWR over subperiodes */
  function berekenTWR(subperiodes) {
    let cumulatief = 1;
    for (const p of subperiodes) {
      if (!p.startWaarde || p.startWaarde === 0) continue;
      const r = (p.eindWaarde - (p.cashflow ?? 0)) / p.startWaarde - 1;
      cumulatief *= (1 + r);
    }
    return cumulatief - 1;
  }

  /** CAGR: (1 + TWR)^(1/jaren) - 1 */
  function berekenCAGR(totaalRendement, aantalJaren) {
    if (!isFinite(aantalJaren) || aantalJaren <= 0) return null;
    if (!isFinite(totaalRendement))                 return null;
    return Math.pow(1 + totaalRendement, 1 / aantalJaren) - 1;
  }

  /** Normaliseer benchmarkserie naar rendement t.o.v. startpunt */
  function normaliseerBenchmark(serie, startDatum) {
    const gefilterd = (serie ?? []).filter(d => d.datum >= startDatum);
    if (gefilterd.length < 2) return [];
    const basis = gefilterd[0].koers;
    if (!basis) return [];
    return gefilterd.map(d => ({ datum: d.datum, rendement: d.koers / basis - 1 }));
  }

  /** ISO-datumstring voor begin van gekozen periode */
  function getStartDatum(periode) {
    const nu = new Date();
    if (periode === "YTD")  return `${nu.getFullYear()}-01-01`;
    if (periode === "MAX")  return "2000-01-01";
    const maanden = PERIODE_MAANDEN[periode] ?? 12;
    const d = new Date(nu);
    d.setMonth(d.getMonth() - maanden);
    return d.toISOString().substring(0, 10);
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER — HOOFD
  // ══════════════════════════════════════════════════════════════════
  function setLoading() {
    document.getElementById("content").innerHTML =
      `<div class="loading">Data laden<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>`;
  }

  function render(isDemo = false) {
    const { samenvatting, meta, cashflows = [], twrHistorie = [] } = portfolioData;
    let { posities = [] } = portfolioData;

    // Herbereken gewichten vanuit totaalWaarde
    posities = herberekeningGewichten(posities, samenvatting.totaalWaarde);

    const startDatum = getStartDatum(activePeriod);

    // CAGR
    const nu = new Date();
    const startMs    = new Date(meta.startdatum ?? startDatum).getTime();
    const aantalJaren = (nu.getTime() - startMs) / (365.25 * 24 * 3600 * 1000);
    const cagr = berekenCAGR(samenvatting.twr ?? 0, aantalJaren);

    // Badge
    const twr    = samenvatting.twr ?? 0;
    const twrPct = (twr * 100).toFixed(2);
    const badge  = document.getElementById("twr-badge");
    if (badge) {
      badge.textContent  = `${samenvatting.twrIsProxy ? "P&L" : "TWR"} ${twr >= 0 ? "+" : ""}${twrPct}%`;
      badge.style.color  = twr >= 0 ? "var(--pos)" : "var(--neg)";
      badge.style.borderColor = twr >= 0 ? "rgba(74,222,128,0.35)" : "rgba(248,113,113,0.35)";
      badge.style.background  = twr >= 0 ? "rgba(74,222,128,0.1)"  : "rgba(248,113,113,0.1)";
    }

    // Timestamp
    const lu = document.getElementById("last-update");
    if (lu && meta.gegenereerd) {
      lu.textContent = "bijgewerkt: " + new Date(meta.gegenereerd).toLocaleString("nl-NL", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      });
    }

    let html = "";

    if (isDemo) {
      html += `<div class="warn-box">⚠ Demo-modus — vervang <strong>sheetsUrl</strong> in rendement.html met je Google Sheets Web App URL om echte data te laden.</div>`;
    }

    if (samenvatting.twrIsProxy && !isDemo) {
      html += `<div class="warn-box">ℹ Rendement berekend als <strong>P&L / kostenbasis</strong> — geen gecorrigeerde TWR. Voeg <code>twrHistorie</code> toe aan de Apps Script output voor echte Time-Weighted Return.</div>`;
    }

    html += renderSectionTitle("Portefeuille Samenvatting");
    html += renderKpiGrid(samenvatting, cagr);
    html += renderGrafiekSectie();
    html += renderSectionTitle(`Benchmark Vergelijking — ${activePeriod}`);
    html += renderBenchmarkGrid(startDatum, twr);

    const actievePosities = posities.filter(p => p.aantal > 0.0001);
    html += renderSectionTitle(`Posities (${actievePosities.length})`);
    html += renderPosTable(actievePosities, samenvatting.totaalWaarde);

    if (cashflows.length > 0) {
      html += renderSectionTitle("Cashflows");
      html += renderCashflowGrid(cashflows);
    }

    html += renderSectionTitle("Methodologie");
    html += renderMethodologie(samenvatting.twrIsProxy);

    document.getElementById("content").innerHTML = html;
    requestAnimationFrame(() => drawChart(startDatum, twrHistorie, samenvatting.twrIsProxy, twr));
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER — ONDERDELEN
  // ══════════════════════════════════════════════════════════════════
  function renderSectionTitle(tekst) {
    return `<div class="section-title">${tekst}</div>\n`;
  }

  function renderKpiGrid(samenvatting, cagr) {
    const twr        = samenvatting.twr ?? 0;
    const twrKlasse  = twr >= 0       ? "pos" : "neg";
    const cagrKlasse = (cagr ?? 0) >= 0 ? "pos" : "neg";
    const pnlKlasse  = (samenvatting.totaalPnL ?? 0) >= 0 ? "pos" : "neg";
    const twrLabel   = samenvatting.twrIsProxy ? "P&L Rendement" : "TWR";
    const cagrText   = cagr != null ? fmtPct(cagr) : "—";

    return `
<div class="kpi-grid">
  <div class="kpi-card gold-accent">
    <div class="kpi-label">Portefeuillewaarde</div>
    <div class="kpi-value gold">${fmtEUR(samenvatting.totaalWaarde, 0)}</div>
    <div class="kpi-sub">incl. ongerealiseerd</div>
  </div>
  <div class="kpi-card ${twr >= 0 ? "pos-accent" : "neg-accent"}">
    <div class="kpi-label">${twrLabel} (${activePeriod})</div>
    <div class="kpi-value ${twrKlasse}">${fmtPct(twr)}</div>
    <div class="kpi-sub">${samenvatting.twrIsProxy ? "kostenbasis rendement" : "Time-Weighted Return"}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">CAGR (jaarl.)</div>
    <div class="kpi-value ${cagrKlasse}">${cagrText}</div>
    <div class="kpi-sub">samengesteld jaarrendement</div>
  </div>
  <div class="kpi-card ${(samenvatting.totaalPnL ?? 0) >= 0 ? "pos-accent" : "neg-accent"}">
    <div class="kpi-label">Ongerealiseerd P&amp;L</div>
    <div class="kpi-value ${pnlKlasse}">${fmtEUR(samenvatting.totaalPnL ?? 0, 0)}</div>
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
</div>`;
  }

  function renderGrafiekSectie() {
    const periodes = ["1M", "3M", "6M", "YTD", "1J", "3J", "MAX"];
    const knoppen = periodes.map(p =>
      `<button class="pf${activePeriod === p ? " active" : ""}" onclick="Rendement._setPeriod('${p}')">${p}</button>`
    ).join("");

    const legendaPortfolio = `
  <div class="leg-item">
    <div class="leg-dot" style="background:#fbbf24"></div>Portfolio
  </div>`;
    const legendaBenchmarks = cfg.benchmarks.map(b => `
  <div class="leg-item">
    <div class="leg-dot" style="background:${BENCHMARK_COLORS[b]}"></div>${BENCHMARK_LABELS[b]}
  </div>`).join("");

    return `
<div class="chart-wrap">
  <div class="chart-top">
    <div class="chart-title">Rendement vs Benchmarks</div>
    <div class="period-filters">${knoppen}</div>
  </div>
  <div class="chart-legend">
    ${legendaPortfolio}
    ${legendaBenchmarks}
  </div>
  <canvas id="rend-chart" height="180"></canvas>
</div>`;
  }

  function renderBenchmarkGrid(startDatum, portTWR) {
    const kaarten = cfg.benchmarks.map(b => renderBmKaart(b, startDatum, portTWR)).join("");
    return `<div class="bm-grid">${kaarten}</div>`;
  }

  function renderBmKaart(key, startDatum, portTWR) {
    const label = BENCHMARK_LABELS[key];
    const kleur = BENCHMARK_COLORS[key];
    const serie = benchData[key] ?? [];
    const genorm = normaliseerBenchmark(serie, startDatum);

    if (genorm.length === 0) {
      return `
  <div class="bm-card" style="border-left:3px solid ${kleur}">
    <div class="bm-name">${label}</div>
    <div class="bm-return neu">Geen data</div>
    <div class="bm-vs" style="color:var(--muted);font-size:10px">Controleer internetverbinding</div>
  </div>`;
    }

    const rend     = genorm[genorm.length - 1].rendement;
    const outpf    = portTWR - rend;
    const rendKlasse  = rend  >= 0 ? "pos" : "neg";
    const outpfKlasse = outpf >= 0 ? "pos" : "neg";

    return `
  <div class="bm-card" style="border-left:3px solid ${kleur}">
    <div class="bm-name">${label}</div>
    <div class="bm-return ${rendKlasse}">${fmtPct(rend)}</div>
    <div class="bm-vs ${outpfKlasse}">
      <span>Portfolio vs benchmark:</span>${outpf >= 0 ? "+" : ""}${(outpf * 100).toFixed(2)}%
    </div>
  </div>`;
  }

  function renderPosTable(posities, totaalWaarde) {
    if (posities.length === 0) {
      return `<div class="pos-table-wrap"><div style="padding:2rem;text-align:center;color:var(--muted);font-family:'DM Mono',monospace;font-size:12px">Geen open posities gevonden</div></div>`;
    }

    const gesorteerd = [...posities].sort((a, b) => (b.waarde ?? 0) - (a.waarde ?? 0));

    const rijen = gesorteerd.map(p => {
      const pnlPct    = (p.gemAankoopprijs ?? 0) > 0 ? ((p.huidig ?? 0) / p.gemAankoopprijs - 1) : 0;
      const pnlKlasse = (p.pnl ?? 0) >= 0  ? "pos" : "neg";
      const pctKlasse = pnlPct >= 0         ? "pos" : "neg";
      const gew       = Math.min((p.gewicht ?? 0) * 100, 100);

      return `
    <tr>
      <td>
        <div class="prod-name">${escHtml(p.product ?? "—")}</div>
        <div class="prod-isin">${escHtml(p.isin ?? "")}</div>
      </td>
      <td>${fmtNummer(p.aantal, 4)}</td>
      <td>${fmtEUR(p.gemAankoopprijs, 2)}</td>
      <td>${fmtEUR(p.waarde, 0)}</td>
      <td class="pos">${fmtEUR(p.dividend ?? 0, 0)}</td>
      <td class="${pnlKlasse}">${fmtEUR(p.pnl ?? 0, 0)}</td>
      <td class="${pctKlasse}">${fmtPct(pnlPct)}</td>
      <td>
        <div class="gewicht-bar">
          <span style="font-family:'DM Mono',monospace;font-size:11px">${gew.toFixed(1)}%</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${gew.toFixed(1)}%"></div>
          </div>
        </div>
      </td>
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
      <thead>
        <tr>
          <th>Product</th><th>Aantal</th><th>Gem. prijs</th><th>Huidige waarde</th>
          <th>Dividend</th><th>P&amp;L</th><th>P&amp;L %</th><th>Gewicht</th>
        </tr>
      </thead>
      <tbody>${rijen}</tbody>
    </table>
  </div>
</div>`;
  }

  function renderCashflowGrid(cashflows) {
    const totaalStorting = cashflows
      .filter(c => (c.type ?? "").toUpperCase() === "STORTING")
      .reduce((s, c) => s + Math.abs(parseFloat(c.bedrag ?? 0)), 0);
    const totaalOpname = cashflows
      .filter(c => (c.type ?? "").toUpperCase() === "OPNAME")
      .reduce((s, c) => s + Math.abs(parseFloat(c.bedrag ?? 0)), 0);

    return `
<div class="cf-grid">
  <div class="cf-card">
    <div class="cf-label">Totaal ingelegd</div>
    <div class="cf-val gold">${fmtEUR(totaalStorting, 0)}</div>
  </div>
  <div class="cf-card">
    <div class="cf-label">Totaal onttrokken</div>
    <div class="cf-val neg">-${fmtEUR(totaalOpname, 0)}</div>
  </div>
</div>`;
  }

  function renderMethodologie(isProxy) {
    const twrUitleg = isProxy
      ? `<strong>P&L Rendement</strong> — huidige waarde minus kostenbasis gedeeld door kostenbasis.
         Eenvoudig maar houdt <em>geen</em> rekening met tijdstip van stortingen/onttrekkingen.
         <br><br>Voor echte <strong>TWR</strong>: voeg een <code>twrHistorie</code>-array toe aan de Apps Script output
         (array van <code>{ datum, twr }</code> objecten, één per dag of maand).`
      : `<strong>Time-Weighted Return (TWR)</strong> — elimineert het effect van externe geldstromen
         (stortingen/opnames). Formule per subperiode:
         <strong>r = (EindWaarde &minus; Cashflow) / StartWaarde &minus; 1</strong>.
         Totaal TWR is het product van alle (1 + r_subperiode) verminderd met 1.`;

    return `
<div class="method-box">
  ${twrUitleg}
  <br><br>
  <strong>CAGR</strong> — samengesteld jaarrendement: <strong>(1 + TWR)^(1/jaren) &minus; 1</strong>.
  <br><br>
  Benchmarks: S&amp;P 500 (^GSPC), MSCI All World (URTH ETF proxy), AEX (^AEX) via Yahoo Finance.
</div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // CHART.JS GRAFIEK
  // ══════════════════════════════════════════════════════════════════
  function drawChart(startDatum, twrHistorie, twrIsProxy, portTWR) {
    const canvas = document.getElementById("rend-chart");
    if (!canvas) return;

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    const datasets = [];

    // ── Portfolio lijn ────────────────────────────────────────────
    const portData = (twrHistorie ?? [])
      .filter(h => h && h.datum >= startDatum)
      .map(h => ({ x: h.datum.substring(0, 7), y: parseFloat(((h.twr ?? 0) * 100).toFixed(3)) }));

    if (portData.length >= 2) {
      datasets.push({
        label: "Portfolio (TWR)",
        data: portData,
        borderColor: "#fbbf24",
        backgroundColor: "rgba(251,191,36,0.08)",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.35,
        fill: true,
        order: 0,
      });
    } else if (!twrIsProxy && portTWR != null) {
      // Geen historische data maar wel een eindwaarde: teken een horizontale referentielijn
      // (alleen informatief — geen tijdsserie)
    }

    // ── Benchmarks ────────────────────────────────────────────────
    for (const key of cfg.benchmarks) {
      const genorm = normaliseerBenchmark(benchData[key] ?? [], startDatum);
      if (genorm.length < 2) continue;
      datasets.push({
        label: BENCHMARK_LABELS[key],
        data: genorm.map(d => ({
          x: d.datum.substring(0, 7),
          y: parseFloat((d.rendement * 100).toFixed(3)),
        })),
        borderColor: BENCHMARK_COLORS[key],
        backgroundColor: "transparent",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.35,
        fill: false,
        order: 1,
      });
    }

    if (datasets.length === 0) {
      canvas.parentElement.innerHTML +=
        `<div style="text-align:center;color:var(--muted);font-family:'DM Mono',monospace;font-size:12px;padding:2rem 0">
          Geen grafiek-data beschikbaar — controleer internetverbinding voor benchmarks
         </div>`;
      return;
    }

    chartInstance = new Chart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#12121a",
            borderColor: "#1e1e2e",
            borderWidth: 1,
            titleColor: "#5a5a7a",
            bodyColor: "#e8e8f0",
            callbacks: {
              label: ctx =>
                ` ${ctx.dataset.label}: ${ctx.parsed.y >= 0 ? "+" : ""}${ctx.parsed.y.toFixed(2)}%`,
            },
          },
        },
        scales: {
          x: {
            type: "category",
            grid: { color: "#1e1e2e" },
            ticks: { color: "#5a5a7a", maxTicksLimit: 8, font: { family: "DM Mono", size: 10 } },
          },
          y: {
            grid: { color: "#1e1e2e" },
            ticks: {
              color: "#5a5a7a",
              font: { family: "DM Mono", size: 10 },
              callback: v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
            },
          },
        },
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PERIODE WISSELEN
  // ══════════════════════════════════════════════════════════════════
  function setPeriod(p) {
    activePeriod = p;
    if (portfolioData) {
      const isDemo = !cfg.sheetsUrl || cfg.sheetsUrl.includes("JOUW_");
      render(isDemo);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // HULPFUNCTIES — OPMAAK & VEILIGHEID
  // ══════════════════════════════════════════════════════════════════
  function fmtEUR(waarde, decimals = 0) {
    const n = parseFloat(waarde);
    if (waarde == null || isNaN(n)) return "—";
    return new Intl.NumberFormat("nl-NL", {
      style: "currency", currency: "EUR", maximumFractionDigits: decimals,
    }).format(n);
  }

  function fmtPct(waarde) {
    const n = parseFloat(waarde);
    if (waarde == null || isNaN(n)) return "—";
    return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
  }

  function fmtNummer(waarde, decimals = 2) {
    const n = parseFloat(waarde);
    if (waarde == null || isNaN(n)) return "—";
    return new Intl.NumberFormat("nl-NL", { maximumFractionDigits: decimals }).format(n);
  }

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ══════════════════════════════════════════════════════════════════
  // DEMO DATA
  // ══════════════════════════════════════════════════════════════════
  function getDemoData() {
    const nu = new Date();
    const startdatum = new Date(nu.getFullYear() - 2, nu.getMonth(), 1);
    const historie = [];
    let twr = 0;
    for (let i = 24; i >= 0; i--) {
      const d = new Date(nu);
      d.setMonth(d.getMonth() - i);
      twr += (Math.random() - 0.40) * 0.025;
      historie.push({ datum: d.toISOString().substring(0, 10), twr });
    }
    const finalTwr = twr;

    return {
      meta: {
        gegenereerd:   new Date().toISOString(),
        basisvaluta:   "EUR",
        startdatum:    startdatum.toISOString().substring(0, 10),
        startkapitaal: 10000,
      },
      samenvatting: {
        totaalWaarde:   24350,
        totaalDividend: 820,
        totaalKosten:   145,
        totaalPnL:      4350,
        twr:            finalTwr,
        twrIsProxy:     false,
      },
      posities: [
        { isin: "IE00B4L5Y983", product: "iShares Core MSCI World",
          aantal: 45, gemAankoopprijs: 88.20, huidig: 98.50, waarde: 4432.50,
          kosten: 18.40, dividend: 0,      pnl: 463.50,  gewicht: 0.182 },
        { isin: "IE00B3RBWM25", product: "Vanguard FTSE All-World",
          aantal: 62, gemAankoopprijs: 97.10, huidig: 110.80, waarde: 6869.60,
          kosten: 24.10, dividend: 142.30, pnl: 849.40,  gewicht: 0.282 },
        { isin: "NL0011821202", product: "ASML Holding NV",
          aantal: 8,  gemAankoopprijs: 620.00, huidig: 710.50, waarde: 5684.00,
          kosten: 32.00, dividend: 64.40,  pnl: 724.00,  gewicht: 0.233 },
        { isin: "US5949181045", product: "Microsoft Corporation",
          aantal: 15, gemAankoopprijs: 280.00, huidig: 415.20, waarde: 5738.40,
          kosten: 38.50, dividend: 38.70,  pnl: 2028.00, gewicht: 0.236 },
        { isin: "IE00BKX55T58", product: "Vanguard S&P 500 ETF",
          aantal: 18, gemAankoopprijs: 80.50, huidig: 90.20,  waarde: 1623.60,
          kosten: 8.20,  dividend: 22.80,  pnl: 174.60,  gewicht: 0.067 },
      ],
      twrHistorie: historie,
      cashflows: [
        { datum: "2023-01-15", type: "STORTING", bedrag: 10000, omschrijving: "Initiële inleg" },
        { datum: "2023-07-01", type: "STORTING", bedrag: 5000,  omschrijving: "Bijstorting Q3 2023" },
        { datum: "2024-01-10", type: "STORTING", bedrag: 5000,  omschrijving: "Bijstorting Q1 2024" },
        { datum: "2023-09-15", type: "DIVIDEND", bedrag: 820,   omschrijving: "Dividend ontvangen Q3" },
      ],
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // PUBLIEKE API
  // ══════════════════════════════════════════════════════════════════
  return {
    init,
    refresh,
    _setPeriod: setPeriod,
    // Debug helper: log genormaliseerde data naar console
    _debug: () => console.log("portfolioData:", portfolioData, "benchData:", benchData),
  };

})();
