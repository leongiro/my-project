export default async function handler(req, res) {
  const now = new Date();
  const twoYearsAgo  = new Date(now); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const oneYearAgo   = new Date(now); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

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
      const volumes    = result?.indicators?.quote?.[0]?.volume ?? [];
      const shares     = result?.indicators?.quote?.[0]?.close ?? []; // proxy
      return timestamps
        .map((t, i) => ({
          date:   new Date(t * 1000).toISOString().slice(0, 10),
          value:  closes[i],
          volume: volumes[i] ?? 0,
        }))
        .filter(p => p.value !== null);
    } catch { return []; }
  }

  // FRED voor real rates (TIPS)
  async function fredSeries(seriesId, limit = 500) {
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

  // Bereken ratio serie
  function ratioSeries(numerator, denominator) {
    const denomMap = {};
    denominator.forEach(d => { denomMap[d.date] = d.value; });
    return numerator
      .filter(d => denomMap[d.date] && denomMap[d.date] !== 0)
      .map(d => ({
        date:  d.date,
        value: parseFloat((d.value / denomMap[d.date]).toFixed(4)),
      }));
  }

  // MA berekening
  function ma(series, period) {
    return series.map((p, i) => {
      if (i < period - 1) return null;
      const slice = series.slice(i - period + 1, i + 1).map(x => x.value).filter(v => v !== null);
      if (!slice.length) return null;
      return { date: p.date, value: parseFloat((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(4)) };
    }).filter(Boolean);
  }

  // SLV shares outstanding proxy: gebruik volume trend als vraagproxy
  function physicalDemandProxy(series, period = 20) {
    return series.map((p, i) => {
      if (i < period - 1) return null;
      const slice = series.slice(i - period + 1, i + 1).map(x => x.volume);
      const avgVol = slice.reduce((a, b) => a + b, 0) / period;
      return { date: p.date, value: parseFloat((p.volume / (avgVol || 1)).toFixed(3)) };
    }).filter(Boolean);
  }

  function pctChange(series, days) {
    if (series.length < days + 1) return null;
    const last = series[series.length - 1].value;
    const prev = series[series.length - 1 - days].value;
    if (!prev) return null;
    return parseFloat(((last - prev) / prev * 100).toFixed(2));
  }

  function deltaClass20(series) {
    if (series.length < 20) return "neu";
    const last = series[series.length - 1]?.value;
    const prev = series[series.length - 20]?.value;
    return last > prev ? "pos" : last < prev ? "neg" : "neu";
  }

  try {
    const [
      gold, silver, platinum, palladium, copper,
      wti,
      dow,
      gdx, gdxj, sil, silj,
      gld, slv, pslv, iau,
      cny,
      tips10y,
    ] = await Promise.all([
      yahooSeries("GC=F",    p1_2y),  // Goud futures
      yahooSeries("SI=F",    p1_2y),  // Zilver futures
      yahooSeries("PL=F",    p1_2y),  // Platina futures
      yahooSeries("PA=F",    p1_2y),  // Palladium futures
      yahooSeries("HG=F",    p1_2y),  // Koper futures
      yahooSeries("CL=F",    p1_2y),  // WTI olie
      yahooSeries("^DJI",    p1_2y),  // Dow Jones
      yahooSeries("GDX",     p1_2y),  // Gold Miners ETF
      yahooSeries("GDXJ",    p1_2y),  // Junior Gold Miners
      yahooSeries("SIL",     p1_2y),  // Silver Miners ETF
      yahooSeries("SILJ",    p1_2y),  // Junior Silver Miners
      yahooSeries("GLD",     p1_2y),  // SPDR Gold ETF (flows proxy)
      yahooSeries("SLV",     p1_2y),  // iShares Silver ETF (fysieke vraag proxy)
      yahooSeries("PSLV",    p1_2y),  // Sprott Physical Silver (premium proxy)
      yahooSeries("IAU",     p1_2y),  // iShares Gold (secondary flows)
      yahooSeries("CNY=X",   p1_2y),  // USD/CNY (Shanghai premium proxy)
      fredSeries("DFII10",   500),    // 10Y TIPS real yield
    ]);

    // ── RATIOS ──────────────────────────────────────────────────
    const goldSilverRatio    = ratioSeries(gold, silver);
    const goldOilRatio       = ratioSeries(gold, wti);
    const silverOilRatio     = ratioSeries(silver, wti);
    const dowSilverRatio     = ratioSeries(dow, silver);
    const platGoldRatio      = ratioSeries(platinum, gold);
    const palladPlatRatio    = ratioSeries(palladium, platinum);
    const copperSilverRatio  = ratioSeries(copper, silver);
    const gdxGldRatio        = ratioSeries(gdx, gld);     // Miner leverage
    const gdxjGdxRatio       = ratioSeries(gdxj, gdx);    // Junior vs Senior ratio
    const silvSilRatio       = ratioSeries(silj, sil);    // Junior zilver vs senior

    // ── PSLV PREMIUM proxy ──────────────────────────────────────
    // PSLV vs SLV: beide tracken zilver, verschil = premium voor fysiek
    const pslvSlvRatio = ratioSeries(pslv, slv);

    // ── CNY/SILVER proxy voor Shanghai premium ──────────────────
    // Als CNY zwakt (hogere USD/CNY) maar zilver stijgt = Chinese premiumdruk
    const cnyMap = {};
    cny.forEach(d => { cnyMap[d.date] = d.value; });
    const shanghaiProxy = silver
      .filter(d => cnyMap[d.date])
      .map(d => ({
        date:  d.date,
        // Zilver in CNY termen: zilverprijs * CNY rate
        // Stijgende waarde = meer Chinese koopkracht nodig = premiumsignaal
        value: parseFloat((d.value * cnyMap[d.date]).toFixed(2)),
      }));

    // ── GLD VOLUME als institutionele flow proxy ─────────────────
    const gldFlowProxy = physicalDemandProxy(gld, 20);
    const slvFlowProxy = physicalDemandProxy(slv, 20);

    // ── REAL RATES vs GOUD ───────────────────────────────────────
    // Negatieve real rates = bullish voor goud
    const tipsMap = {};
    tips10y.forEach(d => { tipsMap[d.date.slice(0,7)] = d.value; });
    const goldVsRealRates = gold.map(g => {
      const tips = tipsMap[g.date.slice(0,7)];
      if (!tips) return null;
      return { date: g.date, gold: g.value, tips, goldNorm: parseFloat((g.value / 1000).toFixed(3)) };
    }).filter(Boolean);

    // ── MINERS PERFORMANCE ───────────────────────────────────────
    function ytdPct(series) {
      const startOfYear = `${now.getFullYear()}-01-01`;
      const base = series.find(d => d.date >= startOfYear);
      if (!base) return null;
      const last = series[series.length - 1];
      return parseFloat(((last.value - base.value) / base.value * 100).toFixed(2));
    }

    function pct1m(series) { return pctChange(series, 21); }
    function pct3m(series) { return pctChange(series, 63); }

    const miners = [
      { symbol: "GDX",  name: "Gold Miners",        type: "senior", metal: "goud",   series: gdx },
      { symbol: "GDXJ", name: "Junior Gold Miners",  type: "junior", metal: "goud",   series: gdxj },
      { symbol: "SIL",  name: "Silver Miners",       type: "senior", metal: "zilver", series: sil },
      { symbol: "SILJ", name: "Junior Silver Miners",type: "junior", metal: "zilver", series: silj },
    ].map(m => ({
      ...m,
      last:  m.series[m.series.length - 1]?.value,
      ytd:   ytdPct(m.series),
      pct1m: pct1m(m.series),
      pct3m: pct3m(m.series),
    }));

    // ── MOMENTUM SCORE ───────────────────────────────────────────
    const latestGSR     = goldSilverRatio[goldSilverRatio.length - 1]?.value;
    const prevGSR       = goldSilverRatio[goldSilverRatio.length - 20]?.value;
    const latestTIPS    = tips10y[tips10y.length - 1]?.value;
    const prevTIPS      = tips10y[tips10y.length - 20]?.value;
    const latestPlatGold = platGoldRatio[platGoldRatio.length - 1]?.value;
    const latestGDXGLD  = gdxGldRatio[gdxGldRatio.length - 1]?.value;
    const prevGDXGLD    = gdxGldRatio[gdxGldRatio.length - 20]?.value;
    const latestGDXJ    = gdxjGdxRatio[gdxjGdxRatio.length - 1]?.value;
    const prevGDXJ      = gdxjGdxRatio[gdxjGdxRatio.length - 20]?.value;

    let metalScore = 0;
    // Dalende real rates = bullish edelmetalen
    if (latestTIPS < prevTIPS) metalScore += 2;
    else if (latestTIPS > prevTIPS) metalScore -= 1;
    // Dalende Gold/Silver ratio = zilver outperformt = bullish voor beide
    if (latestGSR < prevGSR) metalScore++;
    else if (latestGSR > prevGSR) metalScore--;
    // Stijgende GDX/GLD = miners outperformen metal = bullish
    if (latestGDXGLD > prevGDXGLD) metalScore++;
    else if (latestGDXGLD < prevGDXGLD) metalScore--;
    // Stijgende GDXJ/GDX = juniors leiden = risk on binnen sector
    if (latestGDXJ > prevGDXJ) metalScore++;
    else if (latestGDXJ < prevGDXJ) metalScore--;
    // Platina goedkoper dan goud = historisch undervalued
    if (latestPlatGold < 0.7) metalScore++;

    const momentumSignaal = metalScore >= 2 ? "bullish" : metalScore <= -2 ? "bearish" : "neutraal";

    // Latest values
    const latest = {
      gold:     gold[gold.length - 1]?.value,
      silver:   silver[silver.length - 1]?.value,
      platinum: platinum[platinum.length - 1]?.value,
      palladium: palladium[palladium.length - 1]?.value,
      copper:   copper[copper.length - 1]?.value,
      goldSilverRatio:  latestGSR,
      goldOilRatio:     goldOilRatio[goldOilRatio.length - 1]?.value,
      silverOilRatio:   silverOilRatio[silverOilRatio.length - 1]?.value,
      dowSilverRatio:   dowSilverRatio[dowSilverRatio.length - 1]?.value,
      platGoldRatio:    latestPlatGold,
      palladPlatRatio:  palladPlatRatio[palladPlatRatio.length - 1]?.value,
      copperSilverRatio: copperSilverRatio[copperSilverRatio.length - 1]?.value,
      gdxGldRatio:      latestGDXGLD,
      gdxjGdxRatio:     latestGDXJ,
      pslvSlvRatio:     pslvSlvRatio[pslvSlvRatio.length - 1]?.value,
      tipsYield:        latestTIPS,
      cny:              cny[cny.length - 1]?.value,
      shanghaiProxy:    shanghaiProxy[shanghaiProxy.length - 1]?.value,
      metalScore,
    };

    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({
      ok: true,
      momentumSignaal,
      latest,
      miners,
      series: {
        gold:            gold.slice(-500),
        silver:          silver.slice(-500),
        platinum:        platinum.slice(-500),
        palladium:       palladium.slice(-500),
        copper:          copper.slice(-500),
        goldSilverRatio: goldSilverRatio.slice(-500),
        goldOilRatio:    goldOilRatio.slice(-500),
        silverOilRatio:  silverOilRatio.slice(-500),
        dowSilverRatio:  dowSilverRatio.slice(-500),
        platGoldRatio:   platGoldRatio.slice(-500),
        palladPlatRatio: palladPlatRatio.slice(-500),
        gdxGldRatio:     gdxGldRatio.slice(-500),
        gdxjGdxRatio:    gdxjGdxRatio.slice(-500),
        pslvSlvRatio:    pslvSlvRatio.slice(-500),
        shanghaiProxy:   shanghaiProxy.slice(-500),
        gldFlowProxy:    gldFlowProxy.slice(-250),
        slvFlowProxy:    slvFlowProxy.slice(-250),
        tips10y:         tips10y.slice(-500),
        gdx:             gdx.slice(-500),
        gdxj:            gdxj.slice(-500),
        sil:             sil.slice(-500),
        silj:            silj.slice(-500),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
