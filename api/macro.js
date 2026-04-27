export default async function handler(req, res) {
  const now = new Date();
  const fourYearsAgo = new Date(now); fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  const twoYearsAgo  = new Date(now); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const oneYearAgo   = new Date(now); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const p1_4y = Math.floor(fourYearsAgo.getTime() / 1000);
  const p1_2y = Math.floor(twoYearsAgo.getTime() / 1000);
  const p1_1y = Math.floor(oneYearAgo.getTime() / 1000);
  const p2    = Math.floor(now.getTime() / 1000);

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

  async function fredSeries(seriesId, limit = 60) {
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

  try {
    const [
      vix, dxy, wti, spx, gold, copper,
      hyg, lqd, sphb, vtv,
      treasury10y, treasury2y, tips10y,
      spxPE, cpi, pmi, jobless, m2, fedFunds,
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
      fredSeries("DGS10",      200),
      fredSeries("DGS2",       200),
      fredSeries("DFII10",     200),
      fredSeries("CAPE",        60),
      fredSeries("CPIAUCSL",    48),
      fredSeries("MANEMP",      48),
      fredSeries("ICSA",        60),
      fredSeries("M2SL",        48),
      fredSeries("FEDFUNDS",    48),
    ]);

    const yieldCurve = treasury10y.map(t => {
      const t2 = treasury2y.find(x => x.date === t.date);
      if (!t2) return null;
      return { date: t.date, value: parseFloat((t.value - t2.value).toFixed(3)) };
    }).filter(Boolean);

    const erp = spxPE.map(p => {
      const tips = tips10y.find(x => x.date.slice(0,7) === p.date.slice(0,7));
      if (!tips || !p.value) return null;
      const earningsYield = parseFloat((100 / p.value).toFixed(3));
      return { date: p.date, value: parseFloat((earningsYield - tips.value).toFixed(3)) };
    }).filter(Boolean);

    const spreadSeries = hyg.map((h, i) => {
      const l = lqd[i];
      if (!l) return null;
      return { date: h.date, value: parseFloat((l.value / h.value * 100).toFixed(3)) };
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

    const latestVix    = vix[vix.length - 1]?.value ?? 20;
    const latestBV     = betaValue[betaValue.length - 1]?.value ?? 1;
    const prevBV       = betaValue[betaValue.length - 20]?.value ?? latestBV;
    const latestSpread = spreadSeries[spreadSeries.length - 1]?.value ?? 1;
    const prevSpread   = spreadSeries[spreadSeries.length - 20]?.value ?? latestSpread;
    const latestYC     = yieldCurve[yieldCurve.length - 1]?.value ?? 0;
    const latestERP    = erp[erp.length - 1]?.value ?? 0;
    const latestCY     = copperGold[copperGold.length - 1]?.value ?? 0;
    const prevCY       = copperGold[copperGold.length - 20]?.value ?? latestCY;

    let riskScore = 0;
    if (latestVix < 14) riskScore += 2;
    else if (latestVix > 25) riskScore -= 2;
    else if (latestVix > 20) riskScore -= 1;
    if (latestBV > prevBV) riskScore++; else if (latestBV < prevBV) riskScore--;
    if (latestSpread < prevSpread) riskScore++; else if (latestSpread > prevSpread) riskScore--;
    if (latestYC > 0.5) riskScore++; else if (latestYC < -0.3) riskScore--;
    if (latestERP > 2) riskScore++; else if (latestERP < 0) riskScore--;
    if (latestCY > prevCY) riskScore++; else if (latestCY < prevCY) riskScore--;

    const riskSignal = riskScore >= 2 ? "risk-on" : riskScore <= -2 ? "risk-off" : "neutral";

    const latest = {
      vix: latestVix, dxy: dxy[dxy.length-1]?.value, wti: wti[wti.length-1]?.value,
      cpiYoY: cpiYoY[cpiYoY.length-1]?.value, cpiMoM: cpiMoM[cpiMoM.length-1]?.value,
      spxGold: spxGold[spxGold.length-1]?.value, betaValue: latestBV, spread: latestSpread,
      yieldCurve: latestYC, erp: latestERP, copperGold: latestCY,
      fedFunds: fedFunds[fedFunds.length-1]?.value,
      treasury10y: treasury10y[treasury10y.length-1]?.value,
      treasury2y: treasury2y[treasury2y.length-1]?.value,
      jobless: jobless[jobless.length-1]?.value,
      m2YoY: m2YoY[m2YoY.length-1]?.value, riskScore,
    };

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true, riskSignal,
      series: { vix, dxy, wti, spxGold, betaValue, spreadSeries, cpiYoY, cpiMoM, pmi, yieldCurve, erp, copperGold, jobless, m2YoY, fedFunds, treasury10y, treasury2y },
      latest,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
