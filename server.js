const express = require("express");
const cors    = require("cors");
const yf      = require("yahoo-finance2").default;

const app = express();
app.use(express.json());
app.use(cors());

const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function fromCache(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  return null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

function calcDCF({ freeCashFlow, netIncome, revenueGrowthRate, sharesOutstanding, totalDebt, totalCash, discountRate = 0.12, terminalGrowthRate = 0.05, forecastYears = 5 }) {
  const baseFCF = freeCashFlow && freeCashFlow > 0 ? freeCashFlow : netIncome;
  if (!baseFCF || baseFCF <= 0 || !sharesOutstanding) return null;
  const g = Math.min(Math.max(revenueGrowthRate || 0.10, 0.03), 0.30);
  const gFade = (g - terminalGrowthRate) / forecastYears;
  let totalPV = 0;
  let fcf = baseFCF;
  const yearData = [];
  for (let y = 1; y <= forecastYears; y++) {
    const yearGrowth = g - gFade * (y - 1);
    fcf = fcf * (1 + yearGrowth);
    const pv = fcf / Math.pow(1 + discountRate, y);
    yearData.push({ year: y, fcf: Math.round(fcf), pv: Math.round(pv), growth: (yearGrowth * 100).toFixed(1) });
    totalPV += pv;
  }
  const terminalFCF = fcf * (1 + terminalGrowthRate);
  const terminalValue = terminalFCF / (discountRate - terminalGrowthRate);
  const pvTerminal = terminalValue / Math.pow(1 + discountRate, forecastYears);
  const totalEquityValue = totalPV + pvTerminal;
  const netDebt = (totalDebt || 0) - (totalCash || 0);
  const equityValue = Math.max(0, totalEquityValue - netDebt);
  const intrinsicValue = equityValue / sharesOutstanding;
  return {
    intrinsicValue: Math.round(intrinsicValue * 100) / 100,
    equityValue: Math.round(equityValue),
    pvForecast: Math.round(totalPV),
    pvTerminal: Math.round(pvTerminal),
    terminalValue: Math.round(terminalValue),
    yearData,
    assumptions: {
      baseFCFCr: (baseFCF / 1e7).toFixed(0) + " Cr",
      growthRateStart: (g * 100).toFixed(1) + "%",
      discountRate: (discountRate * 100).toFixed(1) + "%",
      terminalGrowth: (terminalGrowthRate * 100).toFixed(1) + "%",
      forecastYears,
    },
  };
}

app.get("/api/stock/:symbol", async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const cacheKey = "stock_" + sym;
  const cached = fromCache(cacheKey);
  if (cached) return res.json(cached);
  let raw;
  for (const suffix of [".NS", ".BO"]) {
    try {
      raw = await yf.quoteSummary(sym + suffix, {
        modules: ["price","summaryDetail","defaultKeyStatistics","financialData","incomeStatementHistory","cashflowStatementHistory","balanceSheetHistory","assetProfile"],
      });
      if (raw?.price?.regularMarketPrice) break;
    } catch {}
  }
  if (!raw?.price?.regularMarketPrice) {
    return res.status(404).json({ ok: false, error: `Symbol "${sym}" not found on NSE or BSE.` });
  }
  try {
    const p = raw.price || {};
    const sd = raw.summaryDetail || {};
    const ks = raw.defaultKeyStatistics || {};
    const fd = raw.financialData || {};
    const ap = raw.assetProfile || {};
    const ish = raw.incomeStatementHistory || {};
    const cfh = raw.cashflowStatementHistory || {};
    const bsh = raw.balanceSheetHistory || {};
    const price = p.regularMarketPrice?.raw ?? p.regularMarketPrice;
    const prevClose = p.regularMarketPreviousClose?.raw ?? p.regularMarketPreviousClose;
    const change = prevClose ? price - prevClose : null;
    const changePct = prevClose && change != null ? (change / prevClose) * 100 : null;
    const incomeStmts = ish.incomeStatementHistory || [];
    const cashflows = cfh.cashflowStatements || [];
    const balSheets = bsh.balanceSheetStatements || [];
    const latestIS = incomeStmts[0] || {};
    const latestCF = cashflows[0] || {};
    const latestBS = balSheets[0] || {};
    const prevIS = incomeStmts[1] || {};
    const revenue = latestIS.totalRevenue?.raw;
    const prevRevenue = prevIS.totalRevenue?.raw;
    const netIncome = latestIS.netIncome?.raw;
    const freeCashFlow = latestCF.freeCashFlow?.raw || latestCF.totalCashFromOperatingActivities?.raw;
    const totalDebt = latestBS.longTermDebt?.raw || 0;
    const totalCash = latestBS.cash?.raw || fd.totalCash?.raw || 0;
    const sharesOut = ks.sharesOutstanding?.raw || p.sharesOutstanding?.raw;
    const revenueGrowthRate = revenue && prevRevenue && prevRevenue > 0 ? (revenue - prevRevenue) / prevRevenue : fd.revenueGrowth?.raw || 0.10;
    const dcf = calcDCF({ freeCashFlow, netIncome, revenueGrowthRate, sharesOutstanding: sharesOut, totalDebt, totalCash });
    const marginOfSafety = dcf ? ((dcf.intrinsicValue - price) / dcf.intrinsicValue) * 100 : null;
    let fundamental = 5, momentum = 5, valuation = 5, growth = 5, financial = 5;
    const roe = fd.returnOnEquity?.raw;
    if (roe >= 0.20) fundamental += 2; else if (roe >= 0.15) fundamental += 1; else if (roe < 0.08) fundamental -= 1;
    const pm = fd.profitMargins?.raw;
    if (pm >= 0.20) fundamental += 1; else if (pm < 0.05) fundamental -= 1;
    const de = fd.debtToEquity?.raw;
    if (de != null) { if (de < 0.5) financial += 2; else if (de < 1) financial += 1; else if (de > 2) financial -= 1; }
    const pe = sd.trailingPE?.raw;
    if (pe != null) { if (pe < 15) valuation += 2; else if (pe < 25) valuation += 1; else if (pe > 50) valuation -= 1; }
    if (marginOfSafety != null) { if (marginOfSafety > 30) valuation += 2; else if (marginOfSafety > 10) valuation += 1; else if (marginOfSafety < -30) valuation -= 2; else if (marginOfSafety < -10) valuation -= 1; }
    if (revenueGrowthRate > 0.20) growth += 2; else if (revenueGrowthRate > 0.10) growth += 1; else if (revenueGrowthRate < 0.05) growth -= 1;
    const hi = p.fiftyTwoWeekHigh?.raw ?? p.fiftyTwoWeekHigh;
    const lo = p.fiftyTwoWeekLow?.raw ?? p.fiftyTwoWeekLow;
    const pr = p.regularMarketPrice?.raw ?? p.regularMarketPrice;
    if (hi && lo && pr) { const pos = (pr - lo) / (hi - lo); if (pos > 0.8) momentum += 2; else if (pos > 0.5) momentum += 1; else if (pos < 0.2) momentum -= 1; }
    const scores = {
      fundamentals: Math.min(10, Math.max(1, Math.round(fundamental))),
      momentum: Math.min(10, Math.max(1, Math.round(momentum))),
      valuation: Math.min(10, Math.max(1, Math.round(valuation))),
      growth: Math.min(10, Math.max(1, Math.round(growth))),
      financial: Math.min(10, Math.max(1, Math.round(financial))),
      overall: Math.min(10, Math.max(1, Math.round((fundamental + momentum + valuation + growth + financial) / 5))),
    };
    const result = {
      ok: true, symbol: sym,
      companyName: p.longName || p.shortName || sym,
      exchange: p.exchangeName || "NSE",
      sector: ap.sector || "N/A",
      industry: ap.industry || "N/A",
      price, prevClose,
      change: change ? +change.toFixed(2) : null,
      changePct: changePct ? +changePct.toFixed(2) : null,
      dayHigh: p.regularMarketDayHigh?.raw ?? p.regularMarketDayHigh,
      dayLow: p.regularMarketDayLow?.raw ?? p.regularMarketDayLow,
      week52High: p.fiftyTwoWeekHigh?.raw ?? p.fiftyTwoWeekHigh,
      week52Low: p.fiftyTwoWeekLow?.raw ?? p.fiftyTwoWeekLow,
      volume: p.regularMarketVolume?.raw ?? p.regularMarketVolume,
      marketCap: p.marketCap?.raw ?? p.marketCap,
      peRatio: sd.trailingPE?.raw != null ? +sd.trailingPE.raw.toFixed(2) : null,
      forwardPE: sd.forwardPE?.raw != null ? +sd.forwardPE.raw.toFixed(2) : null,
      pbRatio: ks.priceToBook?.raw != null ? +ks.priceToBook.raw.toFixed(2) : null,
      dividendYield: sd.dividendYield?.raw ? +(sd.dividendYield.raw * 100).toFixed(2) + "%" : "N/A",
      roe: fd.returnOnEquity?.raw ? +(fd.returnOnEquity.raw * 100).toFixed(2) + "%" : "N/A",
      roa: fd.returnOnAssets?.raw ? +(fd.returnOnAssets.raw * 100).toFixed(2) + "%" : "N/A",
      revenueGrowth: fd.revenueGrowth?.raw ? +(fd.revenueGrowth.raw * 100).toFixed(2) + "%" : "N/A",
      grossMargin: fd.grossMargins?.raw ? +(fd.grossMargins.raw * 100).toFixed(2) + "%" : "N/A",
      profitMargin: fd.profitMargins?.raw ? +(fd.profitMargins.raw * 100).toFixed(2) + "%" : "N/A",
      debtToEquity: fd.debtToEquity?.raw != null ? +fd.debtToEquity.raw.toFixed(2) : null,
      currentRatio: fd.currentRatio?.raw != null ? +fd.currentRatio.raw.toFixed(2) : null,
      eps: ks.trailingEps?.raw != null ? +ks.trailingEps.raw.toFixed(2) : null,
      bookValue: ks.bookValue?.raw != null ? +ks.bookValue.raw.toFixed(2) : null,
      revenue: revenue ? +(revenue / 1e7).toFixed(0) : null,
      netIncome: netIncome ? +(netIncome / 1e7).toFixed(0) : null,
      freeCashFlow: freeCashFlow ? +(freeCashFlow / 1e7).toFixed(0) : null,
      totalDebt: totalDebt ? +(totalDebt / 1e7).toFixed(0) : null,
      totalCash: totalCash ? +(totalCash / 1e7).toFixed(0) : null,
      dcf, marginOfSafety: marginOfSafety != null ? +marginOfSafety.toFixed(2) : null,
      dcfVerdict: !dcf ? "N/A" : marginOfSafety > 20 ? "Undervalued" : marginOfSafety < -20 ? "Overvalued" : "Fairly Valued",
      scores,
    };
    toCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: "Error: " + e.message });
  }
});

app.get("/api/mf/search", async (req, res) => {
  const cached = fromCache("mfs_" + req.query.q);
  if (cached) return res.json(cached);
  try {
    const r = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(req.query.q)}`);
    const data = await r.json();
    toCache("mfs_" + req.query.q, data);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/mf/nav/:code", async (req, res) => {
  const cached = fromCache("mfn_" + req.params.code);
  if (cached) return res.json(cached);
  try {
    const r = await fetch(`https://api.mfapi.in/mf/${req.params.code}`);
    const data = await r.json();
    toCache("mfn_" + req.params.code, data);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.json({ status: "NiveshAI backend running", cost: "₹0" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`NiveshAI backend running on port ${PORT}`));
