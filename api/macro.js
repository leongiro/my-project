export default async function handler(req, res) {
  const now = new Date();
  const fourYearsAgo = new Date(now); fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  const twoYearsAgo  = new Date(now); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const p1_4y = Math.floor(fourYearsAgo.getTime() / 1000);
  const p1_2y = Math.floor(twoYearsAgo.getTime()  / 1000);
  const p2    = Math.floor(now.getTime()            / 1000);

  // ── Gedeelde fetch-helper met timeout ────────────────────────────
  // Voorkomt dat een trage/hangende upstream (FRED of Yahoo) de hele
  // serverless-functie laat timeouten (wat anders als 504 naar de
  // browser gaat en als "data" in de charts terechtkomt).
  async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function yahooSeries(symbol, period1, attempt = 0) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${p2}&interval=1d`;
      const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) {
        if (attempt === 0) return yahooSeries(symbol, period1, 1);
        return [];
      }
      const d = await r.json().catch(() => null);
      const result     = d?.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const closes     = result?.indicators?.quote?.[0]?.close ?? [];
      return timestamps
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: closes[i] }))
        .filter(p => p.value !== null);
    } catch {
      if (attempt === 0) return yahooSeries(symbol, period1, 1);
      return [];
    }
  }

  // ── Robuuste FRED-fetch ──────────────────────────────────────────
  // Voorkomt dat een Vercel/upstream 504-pagina (of andere HTML-foutpagina)
  // per ongeluk als CSV-data wordt geparsed. Valideert status + content,
  // met timeout en één retry bij falen.
  function looksLikeCsv(text) {
    if (!text || !text.length) return false;
    const firstLine = text.trim().split("\n")[0] ?? "";
    // Een geldige FRED CSV begint met "DATE,<SERIES_ID>" — een HTML/foutpagina
    // begint met "<", "{", of bevat geen komma.
    if (firstLine.trim().startsWith("<")) return false;
    if (!firstLine.includes(",")) return false;
    return true;
  }

  async function fredSeries(seriesId, limit = 250, attempt = 0) {
    try {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
      const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });

      if (!r.ok) {
        if (attempt === 0) return fredSeries(seriesId, limit, 1); // één retry
        return [];
      }

      const contentType = r.headers.get("content-type") ?? "";
      const text = await r.text();

      // Bescherming tegen gateway/error-pagina's die als 200 met HTML-body
      // terugkomen, of een content-type die niet op tekst/csv wijst.
      if (contentType.includes("text/html") || !looksLikeCsv(text)) {
        if (attempt === 0) return fredSeries(seriesId, limit, 1);
        return [];
      }

      const lines = text.trim().split("\n").slice(1);
      return lines.slice(-limit).map(line => {
        const [date, val] = line.split(",");
        return { date: date?.trim(), value: val === "." ? null : parseFloat(val) };
      }).filter(p => p.date && p.value !== null && !Number.isNaN(p.value));
    } catch {
      if (attempt === 0) return fredSeries(seriesId, limit, 1);
      return [];
    }
  }

  // ── Momentum / rate-of-change helper ──────────────────────────────
  // Geeft een serie terug met de procentuele of absolute verandering
  // t.o.v. `window` observaties terug. Voor leidende indicatoren is dit
  // vaak een vroeger signaal dan het absolute niveau zelf.
  function momentumSeries(series, window, mode = "pct") {
    if (!series || series.length <= window) return [];
    return series.slice(window).map((p, i) => {
      const prev = series[i].value;
      const curr = p.value;
      if (prev === 0 || prev === null || curr === null) return null;
      const value = mode === "pct"
        ? parseFloat((((curr - prev) / Math.abs(prev)) * 100).toFixed(3))
        : parseFloat((curr - prev).toFixed(3));
      return { date: p.date, value };
    }).filter(Boolean);
  }

  // Eenvoudige trendclassificatie op basis van de laatste N waarden van
  // een momentumserie: "versnellend" = laatste waarde > vorige waarde
  // én beide dezelfde richting (consistente acceleratie).
  function momentumSignal(momSeries) {
    if (!momSeries || momSeries.length < 2) return "flat";
    const last = momSeries[momSeries.length - 1]?.value;
    const prev = momSeries[momSeries.length - 2]?.value;
    if (last == null || prev == null) return "flat";
    if (last > 0 && last > prev) return "accelerating-up";
    if (last < 0 && last < prev) return "accelerating-down";
    if (last > 0) return "up";
    if (last < 0) return "down";
    return "flat";
  }

  // ── Yahoo quoteSummary: huidige (niet-historische) kerncijfers ──
  // Gebruikt voor de S&P 500 trailing P/E, nodig voor een ECHTE Equity
  // Risk Premium (earnings yield − 10Y yield). Dit endpoint geeft alleen
  // het huidige snapshot terug, geen tijdreeks.
  async function yahooQuoteSummary(symbol, modules, attempt = 0) {
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules.join(",")}`;
      const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) {
        if (attempt === 0) return yahooQuoteSummary(symbol, modules, 1);
        return null;
      }
      const d = await r.json().catch(() => null);
      return d?.quoteSummary?.result?.[0] ?? null;
    } catch {
      if (attempt === 0) return yahooQuoteSummary(symbol, modules, 1);
      return null;
    }
  }


  try {
    const [
      vix, dxy, wti, spx, gold, copper,
      hyg, lqd, sphb, vtv,
      treasury10y, treasury2y, tips10y,
      cpi, jobless, m2, fedFunds,
      w5000, gdp,                      // ← Buffett Indicator
      hyOas, igOas,                    // ← Credit stress (OAS)
      move,                            // ← MOVE Index (bond volatility)
      xlp, xly, xlu, xli, xlv, smh,    // ← Sector rotatie ratio's
      iwf, iwd,                        // ← Growth/Value (EPS-revisie proxy)
      gspcStats,                       // ← S&P 500 trailing P/E (echte ERP)
    ] = await Promise.all([
      yahooSeries("^VIX",      p1_4y),
      yahooSeries("DX-Y.NYB",  p1_4y),
      yahooSeries("CL=F",      p1_4y),
      yahooSeries("^GSPC",     p1_4y),
      yahooSeries("GC=F",      p1_4y),
      yahooSeries("HG=F",      p1_4y),
      yahooSeries("HYG",       p1_4y),
      yahooSeries("LQD",       p1_4y),
      yahooSeries("SPHB",      p1_2y),
      yahooSeries("VTV",       p1_2y),
      fredSeries("DGS10",      250),
      fredSeries("DGS2",       250),
      fredSeries("DFII10",     250),
      fredSeries("CPIAUCSL",    60),
      fredSeries("ICSA",        60),
      fredSeries("M2SL",        60),
      fredSeries("FEDFUNDS",    60),
      yahooSeries("^W5000", p1_4y),   // Wilshire 5000 index ≈ marktkapitalisatie in mrd $
      fredSeries("GDP",     150),      // US GDP in mrd $
      fredSeries("BAMLH0A0HYM2", 1000), // ICE BofA US High Yield OAS
      fredSeries("BAMLC0A0CM",   1000), // ICE BofA US Corporate (IG) OAS
      yahooSeries("^MOVE",     p1_2y), // ICE BofA MOVE Index (rentevolatiliteit) — kan leeg zijn
      yahooSeries("XLP",       p1_2y), // Consumer Staples
      yahooSeries("XLY",       p1_2y), // Consumer Discretionary
      yahooSeries("XLU",       p1_2y), // Utilities
      yahooSeries("XLI",       p1_2y), // Industrials
      yahooSeries("XLV",       p1_2y), // Healthcare
      yahooSeries("SMH",       p1_2y), // Semiconductors
      yahooSeries("IWF",       p1_2y), // Russell 1000 Growth (EPS-revisie proxy)
      yahooSeries("IWD",       p1_2y), // Russell 1000 Value
      yahooQuoteSummary("^GSPC", ["defaultKeyStatistics", "summaryDetail"]), // trailing PE — point-in-time
    ]);

    const yieldCurve = treasury10y.map(t => {
      const t2 = treasury2y.find(x => x.date === t.date);
      if (!t2) return null;
      return { date: t.date, value: parseFloat((t.value - t2.value).toFixed(3)) };
    }).filter(Boolean);

    // ── Breakeven Inflation = 10Y nominaal − 10Y TIPS (real yield) ───
    // Dit is GEEN Equity Risk Premium — het is de markt-impliciete
    // inflatieverwachting over 10 jaar. Voorheen abusievelijk "erp" genoemd.
    const breakeven = tips10y.map(t => {
      const nom = treasury10y.find(x => x.date === t.date);
      if (!nom) return null;
      return { date: t.date, value: parseFloat((nom.value - t.value).toFixed(3)) };
    }).filter(Boolean);

    // ── Echte Equity Risk Premium = S&P 500 earnings yield − 10Y nominaal ──
    // Earnings yield = 1 / trailing P/E. Point-in-time snapshot (Yahoo
    // quoteSummary levert geen historische P/E-reeks gratis) — dus dit is
    // GEEN tijdreeks zoals de andere indicatoren, maar een actuele waarde
    // die bij elke load opnieuw wordt berekend.
    // trailingPE.raw is het correcte veld; forwardPE als secundaire fallback
    // (defaultKeyStatistics.trailingEps is EPS in $, NIET hetzelfde als P/E —
    // gebruik dat dus nooit als directe fallback hiervoor).
    const trailingPE = gspcStats?.summaryDetail?.trailingPE?.raw
      ?? gspcStats?.defaultKeyStatistics?.forwardPE?.raw
      ?? null;
    const earningsYield = trailingPE ? parseFloat((100 / trailingPE).toFixed(3)) : null;
    const latestTreasury10yForErp = treasury10y[treasury10y.length - 1]?.value ?? null;
    const erpNow = (earningsYield !== null && latestTreasury10yForErp !== null)
      ? parseFloat((earningsYield - latestTreasury10yForErp).toFixed(3))
      : null;

    // ── Credit stress: LQD/HYG (market-based proxy, blijft als secundair) ──
    const spreadSeries = hyg.map((h, i) => {
      const l = lqd[i];
      if (!l) return null;
      return { date: h.date, value: parseFloat((l.value / h.value * 100).toFixed(3)) };
    }).filter(Boolean);

    // ── Credit stress: HY OAS (primair signaal) ─────────────────────
    // ICE BofA US High Yield Option-Adjusted Spread t.o.v. treasuries.
    // Zuiver creditrisico-signaal, geen duration-ruis zoals bij LQD/HYG.
    const hyOasSeries = hyOas;

    // ── Credit stress: IG OAS ────────────────────────────────────────
    const igOasSeries = igOas;

    // ── Flight-to-quality spread: HY OAS - IG OAS ───────────────────
    // Stijgt sneller wanneer beleggers specifiek uit lager-kwaliteit
    // credit vluchten i.p.v. een algemene rentebeweging — vroeger en
    // zuiverder signaal voor het begin van risk-off rotatie in credit.
    const hyIgSpread = hyOas.map(h => {
      const ig = igOas.find(x => x.date === h.date);
      if (!ig) return null;
      return { date: h.date, value: parseFloat((h.value - ig.value).toFixed(3)) };
    }).filter(Boolean);

    const spxGold = spx.map(s => {
      const g = gold.find(x => x.date === s.date);
      if (!g) return null;
      return { date: s.date, value: parseFloat((s.value / g.value).toFixed(4)) };
    }).filter(Boolean);

    const copperGold = copper.map(c => {
      const g = gold.find(x => x.date === c.date);
      if (!g) return null;
      return { date: c.date, value: parseFloat((c.value / g.value * 1000).toFixed(4)) };
    }).filter(Boolean);

    const betaValue = sphb.map(s => {
      const v = vtv.find(x => x.date === s.date);
      if (!v) return null;
      return { date: s.date, value: parseFloat((s.value / v.value).toFixed(4)) };
    }).filter(Boolean);

    // ── Generieke ratio-helper voor sector rotatie-pairs ────────────
    function ratioSeries(numerator, denominator, decimals = 4) {
      return numerator.map(n => {
        const d = denominator.find(x => x.date === n.date);
        if (!d || !d.value) return null;
        return { date: n.date, value: parseFloat((n.value / d.value).toFixed(decimals)) };
      }).filter(Boolean);
    }

    // ── Sector rotatie ratio's ───────────────────────────────────────
    // XLY/XLP: Discretionary vs Staples — stijgend = risk-on (consumenten
    // geven meer uit aan niet-essentiële zaken), dalend = defensief/risk-off.
    const discStaples = ratioSeries(xly, xlp);

    // XLI/XLU: Industrials vs Utilities — stijgend = cyclisch/risk-on,
    // dalend = vlucht naar defensieve dividend-sectoren.
    const indusUtil = ratioSeries(xli, xlu);

    // SMH/XLV: Semis vs Healthcare — stijgend = risk-on/groei-appetijt
    // (semis zijn hoogcyclisch), dalend = vlucht naar defensieve healthcare.
    const semisHealth = ratioSeries(smh, xlv);

    // IWF/IWD: Growth vs Value — proxy voor earnings-revisie sentiment.
    // Groei-outperformance correleert historisch met breder positieve
    // EPS-revisies (groeibedrijven worden geherwaardeerd op toekomstige
    // winstgroei); dit is GEEN directe revisie-data maar een marktproxy.
    const growthValue = ratioSeries(iwf, iwd);

    // ── MOVE Index (rentevolatiliteit) ──────────────────────────────
    // ^MOVE via Yahoo is onbetrouwbaar/vaak leeg — als de serie leeg is
    // laten we dit gewoon weg in de output (frontend toont dan "—").
    const moveSeries = move;

    const cpiYoY = cpi.slice(12).map((c, i) => ({
      date: c.date, value: parseFloat(((c.value - cpi[i].value) / cpi[i].value * 100).toFixed(2))
    }));
    const cpiMoM = cpi.slice(1).map((c, i) => ({
      date: c.date, value: parseFloat(((c.value - cpi[i].value) / cpi[i].value * 100).toFixed(2))
    }));
    const m2YoY = m2.slice(12).map((m, i) => ({
      date: m.date, value: parseFloat(((m.value - m2[i].value) / m2[i].value * 100).toFixed(2))
    }));

    // ── Buffett Indicator = Wilshire 5000 Full Cap / GDP × 100 ─────────
    // GDP is kwartaaldata — forward-fill naar meest recente kwartaalcijfer
    const buffettSeries = w5000.map(d => {
      const latestGdp = gdp.filter(g => g.date <= d.date).slice(-1)[0];
      if (!latestGdp) return null;
      return {
        date:  d.date,
        value: parseFloat((d.value / latestGdp.value * 100).toFixed(1)),
      };
    }).filter(Boolean);

    // ── Momentum-laag voor leidende indicatoren ─────────────────────
    // 5-daags (≈1 week) en 20-daags (≈1 maand) rate-of-change.
    // Vroege rotatie manifesteert zich vaak eerst als een versnelling
    // in deze korte-termijn momentumseries, voordat het absolute niveau
    // een drempel doorbreekt.
    const momentum = {
      copperGold:    { d5: momentumSeries(copperGold,    5), d20: momentumSeries(copperGold,    20) },
      betaValue:     { d5: momentumSeries(betaValue,     5), d20: momentumSeries(betaValue,     20) },
      vix:           { d5: momentumSeries(vix,           5), d20: momentumSeries(vix,           20) },
      hyOas:         { d5: momentumSeries(hyOasSeries,   5), d20: momentumSeries(hyOasSeries,   20) },
      yieldCurve:    { d5: momentumSeries(yieldCurve,     5), d20: momentumSeries(yieldCurve,    20) },
      discStaples:   { d5: momentumSeries(discStaples,   5), d20: momentumSeries(discStaples,   20) },
      indusUtil:     { d5: momentumSeries(indusUtil,     5), d20: momentumSeries(indusUtil,     20) },
      semisHealth:   { d5: momentumSeries(semisHealth,   5), d20: momentumSeries(semisHealth,   20) },
      growthValue:   { d5: momentumSeries(growthValue,   5), d20: momentumSeries(growthValue,   20) },
    };

    const latestVix    = vix[vix.length - 1]?.value ?? 20;
    const latestBV     = betaValue[betaValue.length - 1]?.value ?? 1;
    const prevBV       = betaValue[betaValue.length - 20]?.value ?? latestBV;
    const latestSpread = spreadSeries[spreadSeries.length - 1]?.value ?? 1;
    const prevSpread   = spreadSeries[spreadSeries.length - 20]?.value ?? latestSpread;
    const latestYC     = yieldCurve[yieldCurve.length - 1]?.value ?? 0;
    const latestBreakeven = breakeven[breakeven.length - 1]?.value ?? 0;
    const latestCY     = copperGold[copperGold.length - 1]?.value ?? 0;
    const prevCY       = copperGold[copperGold.length - 20]?.value ?? latestCY;
    const latestBI     = buffettSeries[buffettSeries.length - 1]?.value ?? null;

    const latestHyOas  = hyOasSeries[hyOasSeries.length - 1]?.value ?? null;
    const prevHyOas    = hyOasSeries[hyOasSeries.length - 20]?.value ?? latestHyOas;
    const latestIgOas  = igOasSeries[igOasSeries.length - 1]?.value ?? null;
    const latestHyIg   = hyIgSpread[hyIgSpread.length - 1]?.value ?? null;

    const latestMove   = moveSeries[moveSeries.length - 1]?.value ?? null;

    const latestDS     = discStaples[discStaples.length - 1]?.value ?? null;
    const prevDS       = discStaples[discStaples.length - 20]?.value ?? latestDS;
    const latestIU     = indusUtil[indusUtil.length - 1]?.value ?? null;
    const prevIU       = indusUtil[indusUtil.length - 20]?.value ?? latestIU;
    const latestSH     = semisHealth[semisHealth.length - 1]?.value ?? null;
    const prevSH       = semisHealth[semisHealth.length - 20]?.value ?? latestSH;
    const latestGV     = growthValue[growthValue.length - 1]?.value ?? null;
    const prevGV       = growthValue[growthValue.length - 20]?.value ?? latestGV;

    // ── Risk score ───────────────────────────────────────────────────
    // Basis-componenten (ongewijzigd) + credit stress nu op HY OAS i.p.v.
    // LQD/HYG, + nieuwe momentum-bijdrage van de leidende indicatoren.
    let riskScore = 0;
    if (latestVix < 14) riskScore += 2;
    else if (latestVix > 25) riskScore -= 2;
    else if (latestVix > 20) riskScore -= 1;
    if (latestBV > prevBV) riskScore++; else if (latestBV < prevBV) riskScore--;
    if (latestYC > 0.5) riskScore++; else if (latestYC < -0.3) riskScore--;
    if (latestBreakeven > 2) riskScore++; else if (latestBreakeven < 1.5) riskScore--;
    if (latestCY > prevCY) riskScore++; else if (latestCY < prevCY) riskScore--;

    // Credit stress component: HY OAS dalend = risk-on, stijgend = risk-off.
    // Fallback naar LQD/HYG-ratio als FRED-data ontbreekt.
    if (latestHyOas !== null && prevHyOas !== null) {
      if (latestHyOas < prevHyOas) riskScore++; else if (latestHyOas > prevHyOas) riskScore--;
    } else {
      if (latestSpread < prevSpread) riskScore++; else if (latestSpread > prevSpread) riskScore--;
    }

    // Momentum-component: telt extra mee wanneer meerdere leidende
    // indicatoren versnellen in dezelfde richting (vroeg rotatiesignaal).
    const momSignals = [
      momentumSignal(momentum.copperGold.d5),
      momentumSignal(momentum.betaValue.d5),
      momentumSignal(momentum.hyOas.d5),
    ];
    const accelUp   = momSignals.filter(s => s === "accelerating-up").length;
    const accelDown = momSignals.filter(s => s === "accelerating-down").length;
    // hyOas "accelerating-up" = spread stijgt sneller = risk-off, dus tegengesteld wegen
    let momentumScore = 0;
    if (momentumSignal(momentum.copperGold.d5) === "accelerating-up") momentumScore++;
    if (momentumSignal(momentum.copperGold.d5) === "accelerating-down") momentumScore--;
    if (momentumSignal(momentum.betaValue.d5) === "accelerating-up") momentumScore++;
    if (momentumSignal(momentum.betaValue.d5) === "accelerating-down") momentumScore--;
    if (momentumSignal(momentum.hyOas.d5) === "accelerating-down") momentumScore++; // spread daalt sneller = risk-on
    if (momentumSignal(momentum.hyOas.d5) === "accelerating-up") momentumScore--;   // spread stijgt sneller = risk-off

    riskScore += momentumScore;

    // Sector-rotatie component: cyclisch/groei vs defensief.
    // Discretionary>Staples, Industrials>Utilities, Semis>Healthcare en
    // Growth>Value stijgend = risk-on; dalend = defensieve rotatie.
    let sectorScore = 0;
    if (latestDS !== null && prevDS !== null) {
      if (latestDS > prevDS) sectorScore++; else if (latestDS < prevDS) sectorScore--;
    }
    if (latestIU !== null && prevIU !== null) {
      if (latestIU > prevIU) sectorScore++; else if (latestIU < prevIU) sectorScore--;
    }
    if (latestSH !== null && prevSH !== null) {
      if (latestSH > prevSH) sectorScore++; else if (latestSH < prevSH) sectorScore--;
    }
    if (latestGV !== null && prevGV !== null) {
      if (latestGV > prevGV) sectorScore++; else if (latestGV < prevGV) sectorScore--;
    }
    riskScore += sectorScore;

    const riskSignal = riskScore >= 2 ? "risk-on" : riskScore <= -2 ? "risk-off" : "neutral";

    const latest = {
      vix:         latestVix,
      dxy:         dxy[dxy.length-1]?.value,
      wti:         wti[wti.length-1]?.value,
      cpiYoY:      cpiYoY[cpiYoY.length-1]?.value,
      cpiMoM:      cpiMoM[cpiMoM.length-1]?.value,
      spxGold:     spxGold[spxGold.length-1]?.value,
      betaValue:   latestBV,
      spread:      latestSpread,
      hyOas:       latestHyOas,
      igOas:       latestIgOas,
      hyIgSpread:  latestHyIg,
      yieldCurve:  latestYC,
      erp:         erpNow,                            // ← Echte ERP (point-in-time, kan null zijn)
      breakeven:   latestBreakeven,                    // ← Breakeven inflation (was abusievelijk "erp")
      tipsYield:   tips10y[tips10y.length-1]?.value,
      copperGold:  latestCY,
      fedFunds:    fedFunds[fedFunds.length-1]?.value,
      treasury10y: treasury10y[treasury10y.length-1]?.value,
      treasury2y:  treasury2y[treasury2y.length-1]?.value,
      jobless:     jobless[jobless.length-1]?.value,
      m2YoY:       m2YoY[m2YoY.length-1]?.value,
      buffett:     latestBI,                          // ← Buffett Indicator
      riskScore,
      momentumScore,
      sectorScore,
      momentumSignals: {
        copperGold:  momentumSignal(momentum.copperGold.d5),
        betaValue:   momentumSignal(momentum.betaValue.d5),
        hyOas:       momentumSignal(momentum.hyOas.d5),
        discStaples: momentumSignal(momentum.discStaples.d5),
        indusUtil:   momentumSignal(momentum.indusUtil.d5),
        semisHealth: momentumSignal(momentum.semisHealth.d5),
        growthValue: momentumSignal(momentum.growthValue.d5),
      },
      move:        latestMove,
      discStaples: latestDS,
      indusUtil:   latestIU,
      semisHealth: latestSH,
      growthValue: latestGV,
    };

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true, riskSignal,
      series: {
        vix, dxy, wti, spxGold, betaValue, spreadSeries,
        cpiYoY, cpiMoM, yieldCurve, breakeven, copperGold,
        jobless, m2YoY, fedFunds, treasury10y, treasury2y, tips10y,
        buffettSeries,                                // ← Buffett Indicator
        hyOasSeries, igOasSeries, hyIgSpread,         // ← Credit stress (OAS)
        momentum,                                      // ← Momentum-laag
        moveSeries,                                    // ← MOVE Index
        discStaples, indusUtil, semisHealth, growthValue, // ← Sector rotatie ratio's
      },
      latest,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
