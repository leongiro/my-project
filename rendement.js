/**
 * rendement.js — Portfolio Rendement Module
 * TWR + CAGR + Dividend + FX + Benchmarks (SPX / MSCI World / AEX)
 * Datbron: Google Sheets Web App + Yahoo Finance via allorigins proxy
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
    "1M":  1,
    "3M":  3,
    "6M":  6,
    "YTD": 0,
    "1J":  12,
    "3J":  36,
    "MAX": 999,
  };

  // ── MODULE STATE ──────────────────────────────────────────────────
  let cfg           = {};
  let portfolioData = null;
  let benchData     = {};
  let activePeriod  = "1J";
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
      if (!cfg.sheetsUrl || cfg.sheetsUrl === "JOUW_SHEETS_WEBAPP_URL_HIER") {
        portfolioData = getDemoData();
      } else {
        const res = await fetch(cfg.sheetsUrl + "?action=getData");
        if (!res.ok) throw new Error("Sheets antwoord: " + res.status);
        portfolioData = await res.json();
        if (portfolioData.error) throw new Error(portfolioData.error);
      }

      const resultaten = await Promise.allSettled(
        cfg.benchmarks.map(b => loadBenchmark(b))
      );
      resultaten.forEach((r, i) => {
        if (r.status === "fulfilled") benchData[cfg.benchmarks[i]] = r.value;
      });

      render();
    } catch (err) {
      document.getElementById("content").innerHTML =
        `<div class="error">⚠ Kon data niet laden: ${err.message}<br><br>Controleer de sheetsUrl in rendement.html</div>`;
    }
  }

  async function loadBenchmark(key) {
    const ticker = BENCHMARK_TICKERS[key];
    const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1mo&range=5y`;
    const proxy  = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    const res    = await fetch(proxy);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json   = await res.json();

    const chart  = json.chart?.result?.[0];
    const ts     = chart?.timestamp || [];
    const closes = chart?.indicators?.adjclose?.[0]?.adjclose || [];

    const punten = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] !== null && closes[i] !== undefined) {
        punten.push({
          datum: new Date(ts[i] * 1000).toISOString().substring(0, 10),
          koers: closes[i],
        });
      }
    }
    return punten;
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDEMENT BEREKENINGEN
  // ══════════════════════════════════════════════════════════════════

  /**
   * Modified Dietz Time-Weighted Return.
   * Elimineert effect van externe cashflows (stortingen / opnames).
   * Formule per subperiode: r = (EindWaarde - Cashflow) / StartWaarde - 1
   * Totaal TWR = product van alle (1 + r_subperiode) - 1
   */
  function berekenTWR(subperiodes) {
    let cumulatief = 1;
    for (const p of subperiodes) {
      if (!p.startWaarde || p.startWaarde === 0) continue;
      const r = (p.eindWaarde - p.cashflow) / p.startWaarde - 1;
      cumulatief *= (1 + r);
    }
    return cumulatief - 1;
  }

  /**
   * Samengesteld jaarlijks groeipercentage (CAGR).
   * Formule: (1 + TWR)^(1/jaren) - 1
   * Aanvullende metriek naast TWR — geen IRR-driver.
   */
  function berekenCAGR(totaalRendement, aantalJaren) {
    if (aantalJaren <= 0) return 0;
    return Math.pow(1 + totaalRendement, 1 / aantalJaren) - 1;
  }

  /**
   * Herindexeer een benchmarkserie naar rendement t.o.v. startpunt.
   * Eerste koers na startDatum wordt als basis (0%) gebruikt.
   */
  function normaliseerBenchmark(serie, startDatum) {
    const gefilterd = (serie || []).filter(d => d.datum >= startDatum);
    if (gefilterd.length < 2) return [];
    const basis = gefilterd[0].koers;
    return gefilterd.map(d => ({
      datum:     d.datum,
      rendement: d.koers / basis - 1,
    }));
  }

  /**
   * Geeft ISO-datumstring terug voor het begin van de gekozen periode.
   */
  function getStartDatum(periode) {
    const nu = new Date();
    if (periode === "YTD") return `${nu.getFullYear()}-01-01`;
    if (periode === "MAX") return "2000-01-01";
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

  function render() {
    const { samenvatting, meta, posities = [], twrHistorie = [], cashflows = [] } = portfolioData;

    const startDatum  = getStartDatum(activePeriod);
    const nu          = new Date();
    const startMs     = new Date(meta.startdatum || startDatum).getTime();
    const aantalJaren = (nu.getTime() - startMs) / (365.25 * 24 * 3600 * 1000);
    const cagr        = berekenCAGR(samenvatting.twr, aantalJaren);
    const isDemo      = !cfg.sheetsUrl || cfg.sheetsUrl === "JOUW_SHEETS_WEBAPP_URL_HIER";

    // Badge
    const twrPct = (samenvatting.twr * 100).toFixed(2);
    const badge  = document.getElementById("twr-badge");
    if (badge) {
      badge.textContent     = `TWR ${samenvatting.twr >= 0 ? "+" : ""}${twrPct}%`;
      badge.style.color       = samenvatting.twr >= 0 ? "var(--pos)"                : "var(--neg)";
      badge.style.borderColor = samenvatting.twr >= 0 ? "rgba(74,222,128,0.35)"     : "rgba(248,113,113,0.35)";
      badge.style.background  = samenvatting.twr >= 0 ? "rgba(74,222,128,0.1)"      : "rgba(248,113,113,0.1)";
    }

    // Timestamp
    const lu = document.getElementById("last-update");
    if (lu && meta.gegenereerd) {
      lu.textContent = "bijgewerkt: " + new Date(meta.gegenereerd).toLocaleString("nl-NL", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      });
    }

    // HTML samenstellen
    let html = "";

    if (isDemo) {
      html += `<div class="warn-box">⚠ Demo-modus — vervang <strong>sheetsUrl</strong> in rendement.html met je Google Sheets Web App URL om echte data te laden.</div>`;
    }

    html += renderSectionTitle("Portefeuille Samenvatting");
    html += renderKpiGrid(samenvatting, cagr);
    html += renderGrafiekSectie();
    html += renderSectionTitle(`Benchmark Vergelijking — ${activePeriod}`);
    html += renderBenchmarkGrid(startDatum, samenvatting.twr);
    html += renderSectionTitle(`Posities (${posities.filter(p => p.aantal > 0.0001).length})`);
    html += renderPosTable(posities, samenvatting.totaalWaarde);
    html += renderSectionTitle("Cashflows");
    html += renderCashflowGrid(cashflows);
    html += renderSectionTitle("Methodologie");
    html += renderMethodologie();

    document.getElementById("content").innerHTML = html;

    requestAnimationFrame(() => drawChart(startDatum, twrHistorie));
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER — ONDERDELEN
  // ══════════════════════════════════════════════════════════════════

  function renderSectionTitle(tekst) {
    return `<div class="section-title">${tekst}</div>\n`;
  }

  function renderKpiGrid(samenvatting, cagr) {
    const twrKlasse  = samenvatting.twr       >= 0 ? "pos" : "neg";
    const cagrKlasse = cagr                   >= 0 ? "pos" : "neg";
    const pnlKlasse  = samenvatting.totaalPnL >= 0 ? "pos" : "neg";

    return `
      <div class="kpi-grid">
        <div class="kpi-card gold-accent">
          <div class="kpi-label">Portefeuillewaarde</div>
          <div class="kpi-value gold">${fmtEUR(samenvatting.totaalWaarde, 0)}</div>
          <div class="kpi-sub">incl. ongerealiseerd</div>
        </div>
        <div class="kpi-card ${samenvatting.twr >= 0 ? "pos-accent" : "neg-accent"}">
          <div class="kpi-label">TWR (${activePeriod})</div>
          <div class="kpi-value ${twrKlasse}">${fmtPct(samenvatting.twr)}</div>
          <div class="kpi-sub">Time-Weighted Return</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">CAGR (jaarl.)</div>
          <div class="kpi-value ${cagrKlasse}">${fmtPct(cagr)}</div>
          <div class="kpi-sub">samengesteld jaarrendement</div>
        </div>
        <div class="kpi-card ${samenvatting.totaalPnL >= 0 ? "pos-accent" : "neg-accent"}">
          <div class="kpi-label">Ongerealiseerd P&amp;L</div>
          <div class="kpi-value ${pnlKlasse}">${fmtEUR(samenvatting.totaalPnL, 0)}</div>
          <div class="kpi-sub">t.o.v. aankoopprijs</div>
        </div>
        <div class="kpi-card pos-accent">
          <div class="kpi-label">Dividend ontvangen</div>
          <div class="kpi-value pos">${fmtEUR(samenvatting.totaalDividend, 0)}</div>
          <div class="kpi-sub">netto ontvangen</div>
        </div>
        <div class="kpi-card neg-accent">
          <div class="kpi-label">Transactiekosten</div>
          <div class="kpi-value neg">-${fmtEUR(samenvatting.totaalKosten, 0)}</div>
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
        <div class="leg-dot" style="background:#fbbf24"></div>Portfolio (TWR)
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
    const label  = BENCHMARK_LABELS[key];
    const kleur  = BENCHMARK_COLORS[key];
    const serie  = benchData[key] || [];
    const genorm = normaliseerBenchmark(serie, startDatum);

    if (genorm.length === 0) {
      return `
        <div class="bm-card" style="border-left:3px solid ${kleur}">
          <div class="bm-name">${label}</div>
          <div class="bm-return neu">laden…</div>
        </div>`;
    }

    const rend       = genorm[genorm.length - 1].rendement;
    const outpf      = portTWR - rend;
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
    const actief = posities
      .filter(p => p.aantal > 0.0001)
      .sort((a, b) => (b.waarde || 0) - (a.waarde || 0));

    const rijen = actief.map(p => {
      const pnlPct      = p.gemAankoopprijs > 0 ? (p.huidig / p.gemAankoopprijs - 1) : 0;
      const pnlKlasse   = p.pnl  >= 0 ? "pos" : "neg";
      const pctKlasse   = pnlPct >= 0 ? "pos" : "neg";
      const gewPct      = Math.min((p.gewicht || 0) * 100, 100).toFixed(1);

      return `
        <tr>
          <td>
            <div class="prod-name">${p.product || "—"}</div>
            <div class="prod-isin">${p.isin    || ""}</div>
          </td>
          <td>${fmtNummer(p.aantal, 4)}</td>
          <td>${fmtEUR(p.gemAankoopprijs, 2)}</td>
          <td>${fmtEUR(p.waarde, 0)}</td>
          <td class="pos">${fmtEUR(p.dividend, 0)}</td>
          <td class="${pnlKlasse}">${fmtEUR(p.pnl, 0)}</td>
          <td class="${pctKlasse}">${fmtPct(pnlPct)}</td>
          <td>
            <div class="gewicht-bar">
              <span style="font-family:'DM Mono',monospace;font-size:11px">${((p.gewicht || 0) * 100).toFixed(1)}%</span>
              <div class="bar-track">
                <div class="bar-fill" style="width:${gewPct}%"></div>
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
                <th>Product</th>
                <th>Aantal</th>
                <th>Gem. prijs</th>
                <th>Huidige waarde</th>
                <th>Dividend</th>
                <th>P&amp;L</th>
                <th>P&amp;L %</th>
                <th>Gewicht</th>
              </tr>
            </thead>
            <tbody>${rijen}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderCashflowGrid(cashflows) {
    const totaalStorting = cashflows
      .filter(c => c.type === "STORTING")
      .reduce((s, c) => s + Math.abs(c.bedrag || 0), 0);
    const totaalOpname = cashflows
      .filter(c => c.type === "OPNAME")
      .reduce((s, c) => s + Math.abs(c.bedrag || 0), 0);

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

  function renderMethodologie() {
    return `
      <div class="method-box">
        <strong>Time-Weighted Return (TWR)</strong> — elimineert het effect van externe
        geldstromen (stortingen/opnames). Formule per subperiode:
        <strong>r = (EindWaarde &minus; Cashflow) / StartWaarde &minus; 1</strong>.
        Totaal TWR is het product van alle (1 + r_subperiode) verminderd met 1.
        <br><br>
        <strong>CAGR</strong> — samengesteld jaarrendement:
        <strong>(1 + TWR)^(1/jaren) &minus; 1</strong>.
        Aanvullende groeimetriek, geen IRR-driver.
        <br><br>
        Inclusief: dividend (netto ontvangen), FX-conversie naar EUR, transactiekosten.
        Benchmarks: S&amp;P 500 (^GSPC), MSCI All World (URTH ETF proxy), AEX (^AEX)
        via Yahoo Finance.
      </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // CHART.JS GRAFIEK
  // ══════════════════════════════════════════════════════════════════

  function drawChart(startDatum, twrHistorie) {
    const canvas = document.getElementById("rend-chart");
    if (!canvas) return;

    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }

    // Portfolio dataserie
    const portData = twrHistorie
      .filter(h => h.datum >= startDatum)
      .map(h => ({
        x: h.datum.substring(0, 7),
        y: parseFloat((h.twr * 100).toFixed(3)),
      }));

    const datasets = [];

    // Portfolio — goud met fill
    if (portData.length > 0) {
      datasets.push({
        label:           "Portfolio (TWR)",
        data:            portData,
        borderColor:     "#fbbf24",
        backgroundColor: "rgba(251,191,36,0.08)",
        borderWidth:     2,
        pointRadius:     0,
        tension:         0.3,
        fill:            true,
      });
    }

    // Benchmarks
    for (const key of cfg.benchmarks) {
      const genorm = normaliseerBenchmark(benchData[key] || [], startDatum);
      const bmData = genorm.map(d => ({
        x: d.datum.substring(0, 7),
        y: parseFloat((d.rendement * 100).toFixed(3)),
      }));
      datasets.push({
        label:           BENCHMARK_LABELS[key],
        data:            bmData,
        borderColor:     BENCHMARK_COLORS[key],
        backgroundColor: "transparent",
        borderWidth:     1.5,
        pointRadius:     0,
        tension:         0.3,
        fill:            false,
      });
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
            borderColor:     "#1e1e2e",
            borderWidth:     1,
            titleColor:      "#5a5a7a",
            bodyColor:       "#e8e8f0",
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y >= 0 ? "+" : ""}${ctx.parsed.y.toFixed(2)}%`,
            },
          },
        },
        scales: {
          x: {
            type: "category",
            grid:  { color: "#1e1e2e" },
            ticks: { color: "#5a5a7a", maxTicksLimit: 8, font: { family: "DM Mono", size: 10 } },
          },
          y: {
            grid:  { color: "#1e1e2e" },
            ticks: {
              color: "#5a5a7a",
              font:  { family: "DM Mono", size: 10 },
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
    if (portfolioData) render();
  }

  // ══════════════════════════════════════════════════════════════════
  // HULPFUNCTIES — OPMAAK
  // ══════════════════════════════════════════════════════════════════

  function fmtEUR(waarde, decimals = 0) {
    if (waarde === null || waarde === undefined || isNaN(waarde)) return "—";
    return new Intl.NumberFormat("nl-NL", {
      style: "currency", currency: "EUR", maximumFractionDigits: decimals,
    }).format(waarde);
  }

  function fmtPct(waarde) {
    if (waarde === null || waarde === undefined || isNaN(waarde)) return "—";
    return `${waarde >= 0 ? "+" : ""}${(waarde * 100).toFixed(2)}%`;
  }

  function fmtNummer(waarde, decimals = 2) {
    if (waarde === null || waarde === undefined || isNaN(waarde)) return "—";
    return new Intl.NumberFormat("nl-NL", { maximumFractionDigits: decimals }).format(waarde);
  }

  // ══════════════════════════════════════════════════════════════════
  // DEMO DATA — actief zolang sheetsUrl niet ingevuld is
  // ══════════════════════════════════════════════════════════════════

  function getDemoData() {
    const nu         = new Date();
    const startdatum = new Date(nu.getFullYear() - 2, nu.getMonth(), 1);
    const historie   = [];
    let twr          = 0;

    for (let i = 24; i >= 0; i--) {
      const d = new Date(nu);
      d.setMonth(d.getMonth() - i);
      twr += (Math.random() - 0.42) * 0.025;
      historie.push({ datum: d.toISOString().substring(0, 10), twr });
    }

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
        twr:            twr,
        cagr:           berekenCAGR(twr, 2),
      },
      posities: [
        {
          isin: "IE00B4L5Y983", product: "iShares Core MSCI World",
          aantal: 45, gemAankoopprijs: 88.20, huidig: 98.50,
          waarde: 4432.50, kosten: 18.40, dividend: 0, pnl: 463.50, gewicht: 0.182,
        },
        {
          isin: "IE00B3RBWM25", product: "Vanguard FTSE All-World",
          aantal: 62, gemAankoopprijs: 97.10, huidig: 110.80,
          waarde: 6869.60, kosten: 24.10, dividend: 142.30, pnl: 849.40, gewicht: 0.282,
        },
        {
          isin: "NL0011821202", product: "ASML Holding NV",
          aantal: 8, gemAankoopprijs: 620.00, huidig: 710.50,
          waarde: 5684.00, kosten: 32.00, dividend: 64.40, pnl: 724.00, gewicht: 0.233,
        },
        {
          isin: "US5949181045", product: "Microsoft Corporation",
          aantal: 15, gemAankoopprijs: 280.00, huidig: 415.20,
          waarde: 5738.40, kosten: 38.50, dividend: 38.70, pnl: 2028.00, gewicht: 0.236,
        },
        {
          isin: "IE00BKX55T58", product: "Vanguard S&P 500 ETF",
          aantal: 18, gemAankoopprijs: 80.50, huidig: 90.20,
          waarde: 1623.60, kosten: 8.20, dividend: 22.80, pnl: 174.60, gewicht: 0.067,
        },
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
    init:       init,
    refresh:    refresh,
    _setPeriod: setPeriod,
  };

})();
