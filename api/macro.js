export default async function handler(req, res) {
  const now = new Date();
  const fourYearsAgo = new Date(now); fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  const twoYearsAgo  = new Date(now); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const p1_4y = Math.floor(fourYearsAgo.getTime() / 1000);
  const p1_2y = Math.floor(twoYearsAgo.getTime()  / 1000);
  const p2    = Math.floor(now.getTime()            / 1000);

  async function yahooSeries(symbol, period1) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${p2}&interval=1d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const d = await r.json();
      const result     = d?.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const closes     = result?.indicators?.quote?.[0]?.close ?? [];
      return timestamps
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: closes[i] }))
        .filter(p => p.value !== null);
    } catch { return []; }
  }

  async function fredSeries(seriesId, limit = 250) {
    try {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const text = await r.text();
      const lines = text.trim().split("\n").slice(1);
      return lines.slice(-limit).map(line => {
        const [date, val] = line.split(",");
        return { date: date.trim(), value: val === "." ? null : parseFloat(val) };
      }).filter(p => p.value !== null);
    } catch { return []; }
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

  try {
    const [
      vix, dxy, wti, spx, gold, copper,
      hyg, lqd, sphb, vtv,
      treasury10y, treasury2y, tips10y,
      cpi, jobless, m2, fedFunds,
      w5000, gdp,                      // ← Buffett Indicator
      hyOas, igOas,                    // ← Credit stress (OAS)
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
    ]);

    const yieldCurve = treasury10y.map(t => {
      const t2 = treasury2y.find(x => x.date === t.date);
      if (!t2) return null;
      return { date: t.date, value: parseFloat((t.value - t2.value).toFixed(3)) };
    }).filter(Boolean);

    const erp = tips10y.map(t => {
      const nom = treasury10y.find(x => x.date === t.date);
      if (!nom) return null;
      return { date: t.date, value: parseFloat((nom.value - t.value).toFixed(3)) };
    }).filter(Boolean);

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
    };

    const latestVix    = vix[vix.length - 1]?.value ?? 20;
    const latestBV     = betaValue[betaValue.length - 1]?.value ?? 1;
    const prevBV       = betaValue[betaValue.length - 20]?.value ?? latestBV;
    const latestSpread = spreadSeries[spreadSeries.length - 1]?.value ?? 1;
    const prevSpread   = spreadSeries[spreadSeries.length - 20]?.value ?? latestSpread;
    const latestYC     = yieldCurve[yieldCurve.length - 1]?.value ?? 0;
    const latestERP    = erp[erp.length - 1]?.value ?? 0;
    const latestCY     = copperGold[copperGold.length - 1]?.value ?? 0;
    const prevCY       = copperGold[copperGold.length - 20]?.value ?? latestCY;
    const latestBI     = buffettSeries[buffettSeries.length - 1]?.value ?? null;

    const latestHyOas  = hyOasSeries[hyOasSeries.length - 1]?.value ?? null;
    const prevHyOas    = hyOasSeries[hyOasSeries.length - 20]?.value ?? latestHyOas;
    const latestIgOas  = igOasSeries[igOasSeries.length - 1]?.value ?? null;
    const latestHyIg   = hyIgSpread[hyIgSpread.length - 1]?.value ?? null;

    // ── Risk score ───────────────────────────────────────────────────
    // Basis-componenten (ongewijzigd) + credit stress nu op HY OAS i.p.v.
    // LQD/HYG, + nieuwe momentum-bijdrage van de leidende indicatoren.
    let riskScore = 0;
    if (latestVix < 14) riskScore += 2;
    else if (latestVix > 25) riskScore -= 2;
    else if (latestVix > 20) riskScore -= 1;
    if (latestBV > prevBV) riskScore++; else if (latestBV < prevBV) riskScore--;
    if (latestYC > 0.5) riskScore++; else if (latestYC < -0.3) riskScore--;
    if (latestERP > 2) riskScore++; else if (latestERP < 1.5) riskScore--;
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
      erp:         latestERP,
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
      momentumSignals: {
        copperGold: momentumSignal(momentum.copperGold.d5),
        betaValue:  momentumSignal(momentum.betaValue.d5),
        hyOas:      momentumSignal(momentum.hyOas.d5),
      },
    };

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true, riskSignal,
      series: {
        vix, dxy, wti, spxGold, betaValue, spreadSeries,
        cpiYoY, cpiMoM, yieldCurve, erp, copperGold,
        jobless, m2YoY, fedFunds, treasury10y, treasury2y, tips10y,
        buffettSeries,                                // ← Buffett Indicator
        hyOasSeries, igOasSeries, hyIgSpread,         // ← Credit stress (OAS)
        momentum,                                      // ← Momentum-laag
      },
      latest,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
