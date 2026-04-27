export default async function handler(req, res) {
  const now = new Date();
  const oneYearAgo = new Date(now); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const p1_1y = Math.floor(oneYearAgo.getTime() / 1000);
  const p2    = Math.floor(now.getTime() / 1000);

  const SECTORS = [
    { symbol: "XLK",  name: "Technology",        type: "cyclisch" },
    { symbol: "XLV",  name: "Healthcare",         type: "defensief" },
    { symbol: "XLF",  name: "Financials",         type: "cyclisch" },
    { symbol: "XLY",  name: "Consumer Discret.",  type: "cyclisch" },
    { symbol: "XLP",  name: "Consumer Staples",   type: "defensief" },
    { symbol: "XLI",  name: "Industrials",        type: "cyclisch" },
    { symbol: "XLE",  name: "Energy",             type: "cyclisch" },
    { symbol: "XLU",  name: "Utilities",          type: "defensief" },
    { symbol: "XLRE", name: "Real Estate",        type: "defensief" },
    { symbol: "XLB",  name: "Materials",          type: "cyclisch" },
    { symbol: "XLC",  name: "Communication",      type: "cyclisch" },
  ];

  const MACRO_ETFS = [
    { symbol: "SPY",  name: "S&P 500" },
    { symbol: "QQQ",  name: "Nasdaq 100" },
    { symbol: "EEM",  name: "Emerging Markets" },
    { symbol: "IEUR", name: "Europe" },
  ];

  async function fetchFull(symbol) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1_1y}&period2=${p2}&interval=1d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const d = await r.json();
      const result     = d?.chart?.result?.[0];
      const timestamps = result?.timestamp ?? [];
      const closes     = result?.indicators?.quote?.[0]?.close ?? [];
      const volumes    = result?.indicators?.quote?.[0]?.volume ?? [];
      return timestamps
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i], volume: volumes[i] ?? 0 }))
        .filter(p => p.close !== null);
    } catch { return []; }
  }

  function pctChange(data, days) {
    if (data.length < days + 1) return null;
    const last = data[data.length - 1].close;
    const prev = data[data.length - 1 - days].close;
    return parseFloat(((last - prev) / prev * 100).toFixed(2));
  }

  function ma(data, period) {
    if (data.length < period) return null;
    const slice = data.slice(-period).map(d => d.close);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  function avgVolume(data, period = 20) {
    if (data.length < period) return null;
    const slice = data.slice(-period).map(d => d.volume);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  function trendStatus(data) {
    const ma20val = ma(data, 20);
    const ma50val = ma(data, 50);
    const last    = data[data.length - 1]?.close;
    if (!ma20val || !ma50val || !last) return "sideways";
    if (last > ma20val && ma20val > ma50val) return "up";
    if (last < ma20val && ma20val < ma50val) return "down";
    return "sideways";
  }

  function relativeStrength(sectorData, spxData, days = 60) {
    if (sectorData.length < days || spxData.length < days) return null;
    const sLast  = sectorData[sectorData.length - 1].close;
    const sPrev  = sectorData[sectorData.length - days].close;
    const spLast = spxData[spxData.length - 1].close;
    const spPrev = spxData[spxData.length - days].close;
    const sRet   = (sLast - sPrev) / sPrev;
    const spRet  = (spLast - spPrev) / spPrev;
    return parseFloat(((sRet - spRet) * 100).toFixed(2));
  }

  function rsLineSeries(sectorData, spxData) {
    const spxMap = {};
    spxData.forEach(d => { spxMap[d.date] = d.close; });
    return sectorData
      .filter(d => spxMap[d.date])
      .map(d => ({ date: d.date, value: parseFloat((d.close / spxMap[d.date] * 100).toFixed(4)) }));
  }

  try {
    const spxRaw = await fetchFull("^GSPC");
    const [sectorResults, macroResults] = await Promise.all([
      Promise.all(SECTORS.map(s => fetchFull(s.symbol))),
      Promise.all(MACRO_ETFS.map(m => fetchFull(m.symbol))),
    ]);

    const TRADING_DAYS = { "1W": 5, "1M": 21, "3M": 63 };

    const sectors = SECTORS.map((s, i) => {
      const data    = sectorResults[i];
      const last    = data[data.length - 1]?.close ?? 0;
      const h52     = data.length ? Math.max(...data.map(d => d.close)) : null;
      const l52     = data.length ? Math.min(...data.map(d => d.close)) : null;
      const ma20val = ma(data, 20);
      const ma50val = ma(data, 50);
      const avgVol  = avgVolume(data, 20);
      const lastVol = data[data.length - 1]?.volume ?? 0;
      return {
        symbol: s.symbol, name: s.name, type: s.type, last,
        pct1w:  pctChange(data, TRADING_DAYS["1W"]),
        pct1m:  pctChange(data, TRADING_DAYS["1M"]),
        pct3m:  pctChange(data, TRADING_DAYS["3M"]),
        high52w: h52, low52w: l52,
        pctFrom52High: h52 ? parseFloat(((last - h52) / h52 * 100).toFixed(2)) : null,
        ma20: ma20val ? parseFloat(ma20val.toFixed(2)) : null,
        ma50: ma50val ? parseFloat(ma50val.toFixed(2)) : null,
        aboveMa20: ma20val ? last > ma20val : null,
        aboveMa50: ma50val ? last > ma50val : null,
        volRatio: avgVol ? parseFloat((lastVol / avgVol).toFixed(2)) : null,
        trend: trendStatus(data),
        rs20: relativeStrength(data, spxRaw, 20),
        rs60: relativeStrength(data, spxRaw, 60),
        rsSeries: rsLineSeries(data, spxRaw).slice(-60),
      };
    });

    const macroEtfs = MACRO_ETFS.map((m, i) => {
      const data = macroResults[i];
      return {
        symbol: m.symbol, name: m.name,
        pct1w: pctChange(data, TRADING_DAYS["1W"]),
        pct1m: pctChange(data, TRADING_DAYS["1M"]),
        pct3m: pctChange(data, TRADING_DAYS["3M"]),
        rs20:  relativeStrength(data, spxRaw, 20),
        trend: trendStatus(data),
      };
    });

    const defensief = sectors.filter(s => s.type === "defensief");
    const cyclisch  = sectors.filter(s => s.type === "cyclisch");
    const defScore  = defensief.reduce((a, s) => a + (s.rs20 ?? 0), 0) / defensief.length;
    const cycScore  = cyclisch.reduce((a, s)  => a + (s.rs20 ?? 0), 0) / cyclisch.length;
    let rotatieSignaal = "neutraal";
    if (cycScore - defScore > 1.5) rotatieSignaal = "cyclisch";
    if (defScore - cycScore > 1.5) rotatieSignaal = "defensief";

    const ranked1w = [...sectors].sort((a, b) => (b.pct1w ?? -99) - (a.pct1w ?? -99));
    const top3     = ranked1w.slice(0, 3).map(s => s.symbol);
    const bottom3  = ranked1w.slice(-3).map(s => s.symbol);

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true, sectors, macroEtfs, rotatieSignaal,
      cycScore: parseFloat(cycScore.toFixed(2)),
      defScore: parseFloat(defScore.toFixed(2)),
      top3, bottom3,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
