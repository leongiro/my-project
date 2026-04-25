export default async function handler(req, res) {
  const tickers = [
    { symbol: "^GSPC",  name: "S&P 500" },
    { symbol: "GC=F",   name: "Goud" },
    { symbol: "SI=F",   name: "Zilver" },
    { symbol: "GDX",    name: "Goldminers" },
    { symbol: "MSFT",   name: "Microsoft" },
  ];

  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const period1 = Math.floor(startOfYear.getTime() / 1000);
  const period2 = Math.floor(now.getTime() / 1000);

  try {
    const results = await Promise.all(
      tickers.map(async ({ symbol, name }) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
        const response = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const data = await response.json();
        const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
        const timestamps = data?.chart?.result?.[0]?.timestamp ?? [];

        const valid = closes
          .map((c, i) => ({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), close: c }))
          .filter((d) => d.close !== null);

        const base = valid[0]?.close;
        const series = valid.map((d) => ({
          date: d.date,
          ytd: base ? parseFloat((((d.close - base) / base) * 100).toFixed(2)) : 0,
        }));

        return { symbol, name, series };
      })
    );

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({ ok: true, data: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
