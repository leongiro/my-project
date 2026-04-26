export default async function handler(req, res) {
  const now = new Date();
  const fourYearsAgo = new Date(now);
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const p1_4y = Math.floor(fourYearsAgo.getTime() / 1000);
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

  async function fredSeries(seriesId, limit = 48) {
    try {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const text = await r.text();
      const lines = text.trim().split("\n").slice(1);
      return lines
        .slice(-limit)
        .map(line => {
          const [date, val] = line.split(",");
          return { date: date.trim(), value: val === "." ? null : parseFloat(val) };
        })
        .filter(p => p.value !== null);
    } catch { return []; }
  }

  try {
    const [
      vix,
      dxy,
      wti,
      spx,
      gold,
      hyg,
      lqd,
      sphb,
      vtv,
      cpi,
      pmi,
    ] = await Promise.all([
      yahooSeries("^VIX",     p1_4y),
      yahooSeries("DX-Y.NYB", p1_1y),
      yahooSeries("CL=F",     p1_1y),
      yahooSeries("^GSPC",    p1_1y),
      yahooSeries("GC=F",     p1_1y),
      yahooSeries("HYG",      p1_1y),
      yahooSeries("LQD",      p1_1y),
      yahooSeries("SPHB",     p1_1y),
      yahooSeries("VTV",      p1_1y),
      fredSeries("CPIAUCSL",  36),
      fredSeries("MANEMP",    36),
    ]);

    // Credit spread proxy: LQD/HYG ratio
    const spreadSeries = hyg.map((h, i) => {
      const l = lqd[i];
      if (!l) return null;
      return { date: h.date, value: parseFloat((l.value / h.value * 100).toFixed(3)) };
    }).filter(Boolean);

    // SPX/Gold ratio
    const spxGold = spx.map(s => {
      const g = gold.find(x => x.date === s.date);
      if (!g) return null;
      return { date: s.date, value: parseFloat((s.value / g.value).toFixed(4)) };
    }).filter(Boolean);

    // SPHB/VTV ratio (high beta vs value)
    const betaValue = sphb.map(s => {
      const v = vtv.find(x => x.date === s.date);
      if (!v) return null;
      return { date: s.date, value: parseFloat((s.value / v.value).toFixed(4)) };
    }).filter(Boolean);

    // CPI YoY en MoM
    const cpiYoY = cpi.slice(12).map((c, i) => ({
      date: c.date,
      value: parseFloat(((c.value - cpi[i].value) / cpi[i].value * 100).toFixed(2))
    }));
    const cpiMoM = cpi.slice(1).map((c, i) => ({
      date: c.date,
      value: parseFloat(((c.value - cpi[i].value) / cpi[i].value * 100).toFixed(2))
    }));

    // Risk signal
    const latestVix    = vix[vix.length - 1]?.value ?? 20;
    const latestBV     = betaValue[betaValue.length - 1]?.value ?? 1;
    const prevBV       = betaValue[betaValue.length - 20]?.value ?? latestBV;
    const latestSpread = spreadSeries[spreadSeries.length - 1]?.value ?? 1;

    let riskScore = 0;
    if (latestVix < 14) riskScore++;
    if (latestVix > 20) riskScore--;
    if (latestBV > prevBV) riskScore++;
    if (latestBV < prevBV) riskScore--;

    const riskSignal = riskScore >= 1 ? "risk-on" : riskScore <= -1 ? "risk-off" : "neutral";

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true,
      riskSignal,
      series: { vix, dxy, wti, spxGold, betaValue, spreadSeries, cpiYoY, cpiMoM, pmi },
      latest: {
        vix:      latestVix,
        dxy:      dxy[dxy.length - 1]?.value,
        wti:      wti[wti.length - 1]?.value,
        cpiYoY:   cpiYoY[cpiYoY.length - 1]?.value,
        cpiMoM:   cpiMoM[cpiMoM.length - 1]?.value,
        spxGold:  spxGold[spxGold.length - 1]?.value,
        betaValue: latestBV,
        spread:   latestSpread,
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
