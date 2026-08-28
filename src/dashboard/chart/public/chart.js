/**
 * AERTH BUNDLER - Chart Frontend
 * Renders candlesticks + volume via TradingView lightweight-charts, polling the local API
 */

(function () {
  const POLL_INTERVAL_MS = 5000;

  const container = document.getElementById('chart-container');
  const priceEl = document.getElementById('price-value');
  const volumeEl = document.getElementById('volume-value');
  const tokenBadge = document.getElementById('token-badge');
  const statusDot = document.getElementById('status-dot');

  const chart = LightweightCharts.createChart(container, {
    layout: {
      background: { color: '#0d1117' },
      textColor: '#e6edf3',
    },
    grid: {
      vertLines: { color: '#21262d' },
      horzLines: { color: '#21262d' },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: true,
      borderColor: '#30363d',
    },
    rightPriceScale: {
      borderColor: '#30363d',
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceScaleId: 'right',
  });

  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });
  chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });

  function resize() {
    chart.applyOptions({
      width: container.clientWidth,
      height: container.clientHeight,
    });
  }
  window.addEventListener('resize', resize);
  resize();

  let lastPrice = null;

  function formatPrice(p) {
    if (!p || p <= 0) return '--';
    if (p < 0.0001) return p.toExponential(4);
    return p.toFixed(p < 1 ? 8 : 4);
  }

  function formatVolume(v) {
    if (!v) return '0';
    if (v > 1000) return (v / 1000).toFixed(2) + 'k';
    return v.toFixed(3);
  }

  async function fetchJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async function refresh() {
    try {
      const [current, history] = await Promise.all([
        fetchJSON('/api/current'),
        fetchJSON('/api/history?limit=500'),
      ]);

      statusDot.classList.add('live');
      tokenBadge.textContent = current.tokenSymbol
        ? `${current.tokenSymbol}${current.tokenMint ? ' · ' + current.tokenMint.slice(0, 4) + '…' + current.tokenMint.slice(-4) : ''}`
        : 'no token';

      const candles = history.candles || [];
      if (candles.length > 0) {
        candleSeries.setData(candles.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })));

        volumeSeries.setData(candles.map((c) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)',
        })));

        const totalVolume = candles.reduce((sum, c) => sum + (c.volume || 0), 0);
        volumeEl.textContent = formatVolume(totalVolume);
      }

      const price = current.price;
      priceEl.textContent = formatPrice(price);
      priceEl.classList.remove('up', 'down');
      if (lastPrice !== null && price !== lastPrice) {
        priceEl.classList.add(price > lastPrice ? 'up' : 'down');
      }
      lastPrice = price;

    } catch (err) {
      statusDot.classList.remove('live');
      console.error('Chart refresh failed:', err);
    }
  }

  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
})();
