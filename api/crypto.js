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
      const volumes    = result?.indicators?.quote?.[0]?.volume ?? [];
      return timestamps
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: closes[i], volume: volumes[i] ?? 0 }))
        .filter(p => p.value !== null);
    } catch { return []; }
  }

  async function coinGeckoMarket(ids) {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=1h,24h,7d,30d`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      return await r.json();
    } catch { return []; }
  }

  async function coinGeckoGlobal() {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/global", { headers: { "User-Agent": "Mozilla/5.0" } });
      const d = await r.json();
      return d?.data ?? {};
    } catch { return {}; }
  }

  async function coinGeckoHistory(id, days) {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const d = await r.json();
      return (d?.prices ?? []).map(([ts, price]) => ({
        date:  new Date(ts).toISOString().slice(0, 10),
        value: parseFloat(price.toFixed(2)),
      }));
    } catch { return []; }
  }

  async function coinGeckoStablecoinHistory() {
    try {
      const [usdt, usdc] = await Promise.all([
        coinGeckoHistory("tether", 365),
        coinGeckoHistory("usd-coin", 365),
      ]);
      const usdtMap = {};
      usdt.forEach(d => { usdtMap[d.date] = d.value; });
      return usdc.map(d => ({
        date:  d.date,
        value: parseFloat(((d.value + (usdtMap[d.date] ?? 0)) / 1e9).toFixed(2)),
      })).filter(d => d.value > 0);
    } catch { return []; }
  }

  async function fearGreed() {
    try {
      const r = await fetch("https://api.alternative.me/fng/?limit=365&format=json", { headers: { "User-Agent": "Mozilla/5.0" } });
      const d = await r.json();
      return (d?.data ?? []).reverse().map(p => ({
        date:  new Date(parseInt(p.timestamp) * 1000).toISOString().slice(0, 10),
        value: parseInt(p.value),
        label: p.value_classification,
      }));
    } catch { return []; }
  }

  async function fundingRate() {
    try {
      const url = "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=100";
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const d = await r.json();
      return (d ?? []).map(p => ({
        date:  new Date(parseInt(p.fundingTime)).toISOString().slice(0, 10),
        value: parseFloat((parseFloat(p.fundingRate) * 100).toFixed(4)),
      }));
    } catch { return []; }
  }

  function ma(series, period) {
    return series.map((p, i) => {
      if (i < period - 1) return { date: p.date, value: null };
      const slice = series.slice(i - period + 1, i + 1).map(x => x.value).filter(v => v !== null);
      return { date: p.date, value: parseFloat((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2)) };
    }).filter(p => p.value !== null);
  }

  try {
    const [
      btcSeries, ethSeries, ibitSeries,
      globalData, fearGreedData, fundingData,
      btcHistory, ethHistory,
      stablecoinHistory, coinMarkets,
    ] = await Promise.all([
      yahooSeries("BTC-USD", p1_1y),
      yahooSeries("ETH-USD", p1_1y),
      yahooSeries("IBIT",    p1_1y),
      coinGeckoGlobal(),
      fearGreed(),
      fundingRate(),
      coinGeckoHistory("bitcoin",  365),
      coinGeckoHistory("ethereum", 365),
      coinGeckoStablecoinHistory(),
      coinGeckoMarket("bitcoin,ethereum,solana,binancecoin,ripple,cardano,avalanche-2,chainlink,polkadot,uniswap"),
    ]);

    const btcMa200    = ma(btcHistory, 200);
    const btcLast     = btcSeries[btcSeries.length - 1]?.value;
    const ma200Last   = btcMa200[btcMa200.length - 1]?.value;
    const aboveMa200  = btcLast && ma200Last ? btcLast > ma200Last : null;

    const btcDominance    = globalData?.market_cap_percentage?.btc ?? null;
    const ethDominance    = globalData?.market_cap_percentage?.eth ?? null;
    const stableDominance = (globalData?.market_cap_percentage?.usdt ?? 0) + (globalData?.market_cap_percentage?.usdc ?? 0);
    const totalMarketCap  = globalData?.total_market_cap?.usd ?? null;
    const totalVolume24h  = globalData?.total_volume?.usd ?? null;
    const marketCapChange = globalData?.market_cap_change_percentage_24h_usd ?? null;

    const latestFG      = fearGreedData[fearGreedData.length - 1] ?? { value: 50, label: "Neutral" };
    const latestFunding = fundingData[fundingData.length - 1]?.value ?? null;

    const btcCoin    = coinMarkets.find(c => c.id === "bitcoin");
    const btc30d     = btcCoin?.price_change_percentage_30d_in_currency ?? 0;
    const altcoins   = coinMarkets.filter(c => c.id !== "bitcoin");
    const altcoinsBeatBtc    = altcoins.filter(c => (c.price_change_percentage_30d_in_currency ?? -99) > btc30d).length;
    const altcoinSeasonScore = Math.round((altcoinsBeatBtc / altcoins.length) * 100);
    const altcoinSeason      = altcoinSeasonScore >= 75 ? "Altcoin Season" : altcoinSeasonScore <= 25 ? "Bitcoin Season" : "Neutraal";

    const ibitAvgVol  = ibitSeries.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    const ibitLastVol = ibitSeries[ibitSeries.length - 1]?.volume ?? 0;
    const ibitVolRatio = ibitAvgVol ? parseFloat((ibitLastVol / ibitAvgVol).toFixed(2)) : null;

    const lastHalving = new Date("2024-04-19");
    const nextHalving = new Date("2028-04-01");
    const halvingPct  = parseFloat(((now - lastHalving) / (nextHalving - lastHalving) * 100).toFixed(1));

    let cryptoScore = 0;
    if (latestFG.value > 60) cryptoScore++;
    if (latestFG.value < 30) cryptoScore--;
    if (aboveMa200) cryptoScore++;
    else if (aboveMa200 === false) cryptoScore--;
    if (btcDominance > 55) cryptoScore++;
    if (altcoinSeasonScore > 75) cryptoScore++;
    if (latestFunding > 0.05) cryptoScore--;
    if (latestFunding < 0) cryptoScore++;
    if (stableDominance < 10) cryptoScore++;

    const momentumSignaal = cryptoScore >= 2 ? "bullish" : cryptoScore <= -2 ? "bearish" : "neutraal";

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true, momentumSignaal, cryptoScore,
      latest: {
        btcPrice: btcLast, ethPrice: ethSeries[ethSeries.length-1]?.value,
        btcDominance, ethDominance, stableDominance,
        totalMarketCap, totalVolume24h, marketCapChange,
        fearGreed: latestFG.value, fearGreedLabel: latestFG.label,
        funding: latestFunding, aboveMa200, ma200: ma200Last,
        altcoinSeasonScore, altcoinSeason, ibitVolRatio, halvingPct,
      },
      series: {
        btc: btcSeries.slice(-365), eth: ethSeries.slice(-365),
        btcMa200: btcMa200.slice(-365), fearGreed: fearGreedData.slice(-365),
        funding: fundingData, stablecoin: stablecoinHistory,
        ibit: ibitSeries.slice(-365),
      },
      coinMarkets,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
