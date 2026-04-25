export default async function handler(req, res) {
  const tickers = [
    { symbol: "QQQ",      name: "Nasdaq 100",       group: "Aandelen" },
    { symbol: "RSP",      name: "S&P500 ongewogen",  group: "Aandelen" },
    { symbol: "DIA",      name: "Dow Jones",         group: "Aandelen" },
    { symbol: "EEM",      name: "Emerging Markets",  group: "Aandelen" },
    { symbol: "EMXC",     name: "EM ex China",       group: "Aandelen" },
    { symbol: "IWM",      name: "Russell 2000",      group: "Aandelen" },
    { symbol: "FEZ",      name: "Stoxx 600",         group: "Aandelen" },
    { symbol: "BTC-USD",  name: "Bitcoin",           group: "Crypto" },
    { symbol: "SHY",      name: "Treasury 1-3yr",    group: "Obligaties" },
    { symbol: "TIP",      name: "10y TIPS",          group: "Obligaties" },
    { symbol: "GC=F",     name: "Goud",              group: "Grondstoffen" },
    { symbol: "SI=F",     name: "Zilver",            group: "Grondstoffen" },
    { symbol: "PL=F",     name: "Platina",           group: "Grondstoffen" },
    { symbol: "PA=F",     name: "Palladium",         group: "Grondstoffen" },
  ];

  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const period1YTD  = Math.floor(startOfYear.getTime() / 1000);
  const start2020   = new Date(2020, 0, 1);
  const period1Hist = Math.floor(start2020.getTime() / 1000);
  const period2     = Math.floor(now.getTime() / 1000);

  async function fetchSeries(symbol, period1) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await response.json();
    const closes     = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const timestamps = data?.chart?.result?.[0]?.timestamp ?? [];
    const valid = closes
      .map((c, i) => ({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: c }))
      .filter(d => d.close !== null);
    const base = valid[0]?.close;
    return valid.map(d => ({
      date: d.date,
      pct: base ? parseFloat((((d.close - base) / base) * 100).toFixed(2)) : 0,
    }));
  }

  try {
    const results = await Promise.all(
      tickers.map(async ({ symbol, name, group }) => {
        try {
          const [ytd, hist] = await Promise.all([
            fetchSeries(symbol, period1YTD),
            fetchSeries(symbol, period1Hist),
          ]);
          return { symbol, name, group, ytd, hist };
        } catch {
          return { symbol, name, group, ytd: [], hist: [] };
        }
      })
    );
    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({ ok: true, data: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
