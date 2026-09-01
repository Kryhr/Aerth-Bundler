/**
 * AERTH BUNDLER - Chart Frontend
 * Renders candlesticks + volume via TradingView lightweight-charts.
 * Live stats (price/multiplier/volume/phase) are handled separately in
 * index.html via Socket.IO - this file only owns the chart itself.
 */

(function () {
  const POLL_INTERVAL_MS = 5000;

  const container = document.getElementById('chart-container');
  if (!container) return;

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
    // Explicit (these are the library defaults, but stated here so panning/
    // zooming is guaranteed on): drag to pan, wheel/pinch to zoom, drag the
    // price axis to zoom price, drag the time axis to zoom time.
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceScaleId: 'right',
    // Candles are plotted in market cap (SOL), a normal-sized number - unlike
    // raw token price (~1e-9), so the default 2-decimal price format works.
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  });

  // With only a handful of candles (or a genuinely flat market), lightweight-
  // charts' default auto-scale zooms into whatever tiny band the visible data
  // occupies - a real 0.16% wiggle can end up rendered as a full-height candle
  // because the axis itself is only ~0.24% tall. Enforce a minimum visible
  // span (~2% of the midpoint) so small real moves stay readable without ever
  // being visually exaggerated into looking like a crash.
  //
  // priceZoomFactor also lets the viewer manually zoom the price axis (see
  // the wheel handler below) - lightweight-charts v4 has no direct "set
  // visible price range" API, so autoscaleInfoProvider doubles as the only
  // lever available to control it: shrinking the returned range makes
  // candles taller (zoomed in), growing it makes them shorter (zoomed out).
  let priceZoomFactor = 1;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8;

  function computeAutoscaleInfo(original) {
    const res = original();
    if (!res || !res.priceRange) return res;
    const { minValue, maxValue } = res.priceRange;
    const mid = (minValue + maxValue) / 2;
    const minHalfSpan = Math.abs(mid) * 0.01;
    const halfSpan = Math.max((maxValue - minValue) / 2, minHalfSpan) * priceZoomFactor;
    return { priceRange: { minValue: mid - halfSpan, maxValue: mid + halfSpan }, margins: res.margins };
  }

  candleSeries.applyOptions({
    autoscaleInfoProvider: computeAutoscaleInfo,
  });

  function refreshPriceScale() {
    // Nudging autoScale off/on forces lightweight-charts to re-invoke
    // autoscaleInfoProvider immediately, rather than waiting for the next
    // incidental repaint - there's no direct "recompute now" API in v4.
    const priceScale = chart.priceScale('right');
    priceScale.applyOptions({ autoScale: false });
    priceScale.applyOptions({ autoScale: true });
  }

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

  // TradingView-style behavior: scrolling while hovering over the price
  // axis (right-hand column of numbers) resizes the candles vertically,
  // instead of the default lightweight-charts behavior where the wheel only
  // ever zooms the time axis regardless of where the cursor is. Listened in
  // the capture phase with stopImmediatePropagation so the chart's own
  // wheel handler (attached to the same container) never sees these events -
  // otherwise both would fire and fight each other.
  container.addEventListener('wheel', (event) => {
    const priceScaleWidth = chart.priceScale('right').width();
    const isOverPriceAxis = event.offsetX > container.clientWidth - priceScaleWidth;
    if (!isOverPriceAxis) return; // let the library's own handler zoom time as normal

    event.preventDefault();
    event.stopImmediatePropagation();

    const zoomStep = event.deltaY < 0 ? 0.9 : 1.1; // scroll up = taller candles (zoom in)
    priceZoomFactor = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, priceZoomFactor * zoomStep));
    refreshPriceScale();
  }, { capture: true, passive: false });

  // Double-click the price axis to reset the manual zoom back to auto-fit -
  // matches lightweight-charts' own native double-click-to-reset gesture,
  // which would otherwise get immediately overridden by our own
  // priceZoomFactor multiplier still being active.
  container.addEventListener('dblclick', (event) => {
    const priceScaleWidth = chart.priceScale('right').width();
    if (event.offsetX <= container.clientWidth - priceScaleWidth) return;
    priceZoomFactor = 1;
    refreshPriceScale();
  });

  // setData() replaces the whole dataset every poll - without capturing and
  // restoring the visible range around it, the chart snaps back to showing
  // the latest data on every single refresh (every 5s), making manual
  // panning/zooming feel broken since any move gets undone almost
  // immediately. Preserve whatever the viewer is currently looking at;
  // only auto-fit the very first time there's data to show.
  let hasFitOnce = false;

  async function refresh() {
    try {
      const res = await fetch('/api/history');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { candles } = await res.json();

      if (candles && candles.length > 0) {
        const preservedRange = hasFitOnce ? chart.timeScale().getVisibleLogicalRange() : null;

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

        if (preservedRange) {
          chart.timeScale().setVisibleLogicalRange(preservedRange);
        } else {
          chart.timeScale().fitContent();
          hasFitOnce = true;
        }
      }
    } catch (err) {
      console.error('Chart refresh failed:', err);
    }
  }

  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
})();
