export default async function handler(req, res) {
  const now = new Date();
  const oneYearAgo = new Date(now); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
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

  function pctChange(series, days) {
    if (series.length < days + 1) return null;
    const last = series[series.length - 1].value;
    const prev = series[series.length - 1 - days].value;
    if (!prev) return null;
    return parseFloat(((last - prev) / prev * 100).toFixed(2));
  }

  function aboveMa(series, period) {
    if (series.length < period) return null;
    const slice = series.slice(-period).map(d => d.value);
    const maVal = slice.reduce((a, b) => a + b, 0) / period;
    return series[series.length - 1].value > maVal;
  }

  function relStrength(series, spx, days = 63) {
    if (series.length < days || spx.length < days) return null;
    const sLast  = series[series.length - 1].value;
    const sPrev  = series[series.length - days].value;
    const spLast = spx[spx.length - 1].value;
    const spPrev = spx[spx.length - days].value;
    return parseFloat((((sLast - sPrev) / sPrev - (spLast - spPrev) / spPrev) * 100).toFixed(2));
  }

  function minerLeverage(spotSeries, minerSeries, days = 63) {
    if (!minerSeries || spotSeries.length < days || minerSeries.length < days) return null;
    const spotRet  = (spotSeries[spotSeries.length-1].value - spotSeries[spotSeries.length-days].value) / spotSeries[spotSeries.length-days].value;
    const minerRet = (minerSeries[minerSeries.length-1].value - minerSeries[minerSeries.length-days].value) / minerSeries[minerSeries.length-days].value;
    if (Math.abs(spotRet) < 0.001) return null;
    return parseFloat((minerRet / spotRet).toFixed(2));
  }

  function leverageSignal(lev) {
    if (lev === null) return "—";
    if (lev > 1.5) return "✅";
    if (lev >= 0.5) return "⚠️";
    return "❌";
  }

  function ratioSeries(num, denom) {
    const denomMap = {};
    denom.forEach(d => { denomMap[d.date] = d.value; });
    return num.filter(d => denomMap[d.date]).map(d => ({
      date: d.date, value: parseFloat((d.value / denomMap[d.date]).toFixed(4))
    }));
  }

  function ytdPct(series) {
    const base = series.find(d => d.date >= `${new Date().getFullYear()}-01-01`);
    if (!base) return null;
    const last = series[series.length - 1];
    return parseFloat(((last.value - base.value) / base.value * 100).toFixed(2));
  }

  const AUM = {
    USO: 0.9, UNG: 0.5, LNG: 40, KOL: 0.1, URA: 1.2, URNM: 0.8,
    COPX: 1.5, AA: 3.0, VALE: 25, LIT: 1.8,
    XLE: 35, FCG: 0.3,
  };

  try {
    const spx  = await yahooSeries("^GSPC", p1_1y);
    const gold = await yahooSeries("GC=F",  p1_1y);

    const [uso, ung, lng, kol, ura, urnm, xle, fcg] = await Promise.all([
      yahooSeries("USO",  p1_1y),
      yahooSeries("UNG",  p1_1y),
      yahooSeries("LNG",  p1_1y),
      yahooSeries("KOL",  p1_1y),
      yahooSeries("URA",  p1_1y),
      yahooSeries("URNM", p1_1y),
      yahooSeries("XLE",  p1_1y),
      yahooSeries("FCG",  p1_1y),
    ]);

    const [copx, hg, aa, vale] = await Promise.all([
      yahooSeries("COPX", p1_1y),
      yahooSeries("HG=F", p1_1y),
      yahooSeries("AA",   p1_1y),
      yahooSeries("VALE", p1_1y),
    ]);

    const [lit, albemarle] = await Promise.all([
      yahooSeries("LIT",  p1_1y),
      yahooSeries("ALB",  p1_1y),
    ]);

    function buildCommodity(name, cluster, spotSeries, minerSeries, aumKey, color) {
      const lev = minerLeverage(spotSeries, minerSeries);
      return {
        name, cluster, color,
        aum: AUM[aumKey] ?? 1,
        pct3m:   pctChange(spotSeries, 63),
        pct6m:   pctChange(spotSeries, 126),
        pct12m:  ytdPct(spotSeries),
        ma200:   aboveMa(spotSeries, 200),
        rs:      relStrength(spotSeries, spx, 63),
        leverage: lev,
        leverageSignal: leverageSignal(lev),
        last: spotSeries[spotSeries.length - 1]?.value,
      };
    }

    const commodities = [
      buildCommodity("WTI Olie",  "energy",     uso,  xle,       "USO",  "#f97316"),
      buildCommodity("Nat. Gas",  "energy",     ung,  fcg,       "UNG",  "#fb923c"),
      buildCommodity("LNG",       "energy",     lng,  null,      "LNG",  "#fbbf24"),
      buildCommodity("Coal",      "energy",     kol,  null,      "KOL",  "#78716c"),
      buildCommodity("Uranium",   "energy",     ura,  urnm,      "URA",  "#a78bfa"),
      buildCommodity("Koper",     "industrial", hg,   copx,      "COPX", "#22d3ee"),
      buildCommodity("Aluminium", "industrial", aa,   null,      "AA",   "#94a3b8"),
      buildCommodity("Nikkel",    "industrial", vale, null,      "VALE", "#34d399"),
      buildCommodity("Lithium",   "transition", lit,  albemarle, "LIT",  "#4ade80"),
    ];

    const copperGoldRatio    = ratioSeries(hg,  gold);
    const uraniumOilRatio    = ratioSeries(ura, uso);
    const lithiumCopperRatio = ratioSeries(lit, hg);
    const energyVsSpx        = ratioSeries(xle, spx);
    const copxVsHg           = ratioSeries(copx, hg);
    const uraVsUrnm          = ratioSeries(ura, urnm);

    const energyScore    = commodities.filter(c => c.cluster === "energy").reduce((a, c) => a + (c.rs ?? 0), 0);
    const industrialScore = commodities.filter(c => c.cluster === "industrial").reduce((a, c) => a + (c.rs ?? 0), 0);
    const transitionScore = commodities.filter(c => c.cluster === "transition").reduce((a, c) => a + (c.rs ?? 0), 0);

    let regime = "growth-cycle";
    if (energyScore > industrialScore && energyScore > transitionScore) regime = "energy-stress";
    if (transitionScore > energyScore && transitionScore > industrialScore) regime = "scarcity-squeeze";

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true, regime,
      scores: {
        energy:     parseFloat(energyScore.toFixed(1)),
        industrial: parseFloat(industrialScore.toFixed(1)),
        transition: parseFloat(transitionScore.toFixed(1)),
      },
      commodities,
      series: {
        copperGoldRatio:    copperGoldRatio.slice(-365),
        uraniumOilRatio:    uraniumOilRatio.slice(-365),
        lithiumCopperRatio: lithiumCopperRatio.slice(-365),
        energyVsSpx:        energyVsSpx.slice(-365),
        copxVsHg:           copxVsHg.slice(-365),
        uraVsUrnm:          uraVsUrnm.slice(-365),
        uso:  uso.slice(-365),
        ung:  ung.slice(-365),
        ura:  ura.slice(-365),
        hg:   hg.slice(-365),
        lit:  lit.slice(-365),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
