'use strict';

const dayMs = 86400000;
const kstMs = 9 * 3600000;
const referenceCache = new Map();

function previousKstDay(now) {
  const midnight = Math.floor((now + kstMs) / dayMs) * dayMs - kstMs;
  return {start: (midnight - dayMs) / 1000, end: midnight / 1000};
}

function previousExtreme(name, field, now) {
  const {start, end} = previousKstDay(now);
  const key = name + '/' + field + '/' + start;
  const current = referenceCache.get(key);
  if (current && (!current.retryAt || now < current.retryAt)) return current;
  if (socket.readyState !== WebSocket.OPEN) return {label: '연결 대기'};
  const item = {label: '조회 중'};
  referenceCache.set(key, item);
  for (const [oldKey, old] of referenceCache) {
    if (old.end && old.end < end) referenceCache.delete(oldKey);
  }
  item.end = end;
  rpc('public/get_tradingview_chart_data', {
    instrument_name: name, start_timestamp: start, end_timestamp: end - 1, period: 3600
  }).then(result => {
    const candles = Array.isArray(result) ? result : result?.candles;
    if (!Array.isArray(candles)) throw new Error('캔들 응답 형식 오류');
    const values = candles.map(bar => positive(bar[field])).filter(Number.isFinite);
    item.value = values.length ? (field === 'high' ? Math.max(...values) : Math.min(...values)) : NaN;
    item.label = values.length ? money(item.value) : '전일 체결 없음';
  }).catch(() => {
    item.label = '조회 실패 · 재시도 대기';
    item.retryAt = Date.now() + 60000;
  });
  return item;
}

function rootBetween(low, high, fn) {
  let left = fn(low);
  const right = fn(high);
  if (![left, right].every(Number.isFinite) || (left === 0 && right === 0) || left * right > 0) return NaN;
  if (left === 0) return low;
  if (right === 0) return high;
  for (let iteration = 0; iteration < 40; iteration++) {
    const mid = (low + high) / 2;
    const value = fn(mid);
    if (value === 0) return mid;
    if (Math.sign(value) === Math.sign(left)) {
      low = mid;
      left = value;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

function drawPremiumChart(data) {
  const chart = el('premium-chart');
  const summary = el('premium-summary');
  const demo = el('chart-demo').checked;
  const {now, expiry, contracts} = data;
  const strike = demo ? 60000 : data.strike;
  const index = demo ? 60000 : data.index;
  const years = demo ? 3 / 365 : Math.max(0, data.years);
  const forward = demo ? index : data.call?.forward;
  const putForward = demo ? index : data.put?.forward;
  const callIv = (demo ? .65 : data.call?.iv) + data.shift;
  const putIv = (demo ? .65 : data.put?.iv) + data.shift;

  if ((!demo && (!data.freshPair || now >= data.settlement))
      || ![strike, index, years, forward, putForward, callIv, putIv].every(Number.isFinite)
      || Math.min(index, forward, putForward, callIv, putIv) <= 0) {
    chart.innerHTML = '<text x="480" y="180" fill="#a7bbd9" text-anchor="middle">유효한 콜·풋 시세와 IV·포워드가 필요합니다</text>';
    summary.textContent = 'Derive 실시간 수신을 기다리거나 예시 차트 보기를 선택하세요.';
    return;
  }

  const selected = type => [...contracts].find(([, item]) =>
    item.expiry === expiry && item.strike === strike && item.type === type)?.[0];
  const callRef = demo ? {value: 1750, label: '$1,750'} : previousExtreme(selected('C'), 'high', now);
  const putRef = demo ? {value: 1150, label: '$1,150'} : previousExtreme(selected('P'), 'low', now);
  const min = Math.min(index * .88, strike * .91);
  const max = Math.max(index * 1.12, strike * 1.09);
  const call = x => black76('C', forward * x / index, strike, callIv, years);
  const put = x => black76('P', putForward * x / index, strike, putIv, years);
  const half = x => (call(x) + put(x)) / 2;
  const prices = Array.from({length: 121}, (_, i) => min + (max - min) * i / 120);
  const peak = Math.max(1, call(max), put(min), callRef.value || 0, putRef.value || 0);
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const step = magnitude * (peak / magnitude > 5 ? 1 : .5);
  const ceiling = Math.ceil(peak * 1.04 / step) * step;
  const x = price => 78 + 860 * (price - min) / (max - min);
  const y = premium => 318 - 298 * premium / ceiling;
  const grid = [];
  for (let i = 0; i <= 7; i++) {
    const v = min + (max - min) * i / 7;
    grid.push('<path d="M' + x(v) + ' 20V318"/><text x="' + x(v) + '" y="338" text-anchor="middle">' + money(Math.round(v)) + '</text>');
  }
  for (let i = 0; i <= Math.round(ceiling / step); i++) {
    const v = i * step;
    grid.push('<path d="M78 ' + y(v) + 'H938"/><text x="69" y="' + (y(v) + 4) + '" text-anchor="end">' + money(v) + '</text>');
  }

  const line = (fn, color, dash = '') => {
    const points = prices.map(price => x(price).toFixed(1) + ',' + y(fn(price)).toFixed(1)).join(' ');
    return '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-dasharray="' + dash + '"/>';
  };
  const crossing = rootBetween(min, max, v => call(v) - put(v));
  const breakout = rootBetween(min, max, v => call(v) - callRef.value);
  const breakdown = rootBetween(min, max, v => put(v) - putRef.value);
  const marker = (price, premium, color, symbol, label) => Number.isFinite(price)
    ? '<text x="' + x(price) + '" y="' + (y(premium) + 6) + '" text-anchor="middle" font-size="20" fill="' + color + '"><title>' + label + ' · BTC ' + money(price) + ' · 옵션 ' + money(premium) + '</title>' + symbol + '</text>' : '';

  chart.innerHTML = '<g fill="#a7bbd9" font-size="12" style="font-variant-numeric:tabular-nums"><style>#premium-chart path{stroke:#29394e}</style>'
    + grid.join('') + '<text x="508" y="362" text-anchor="middle">시나리오 BTC 가격 (USD) →</text></g>'
    + (Number.isFinite(callRef.value) ? line(() => callRef.value, '#2dd4bf', '7 5') : '')
    + (Number.isFinite(putRef.value) ? line(() => putRef.value, '#fb7185', '7 5') : '')
    + line(half, '#fbbf24', '4 6') + line(call, '#34d399') + line(put, '#fb7185')
    + marker(crossing, call(crossing), '#f8fafc', '◆', '콜·풋 교차')
    + marker(breakout, callRef.value, '#34d399', '▲', '콜 전일고가 상향 돌파')
    + marker(breakdown, putRef.value, '#fb7185', '▼', '풋 전일저가 하향 이탈');

  summary.textContent = (demo ? '가상 데이터 · ' : '실시간 입력 기반 모델 · ')
    + '행사가 ' + money(strike)
    + (Number.isFinite(crossing) ? ' · 교차 BTC ' + money(crossing) + ' / 프리미엄 ' + money(call(crossing)) : ' · 표시 구간 내 교차 없음')
    + ' · 콜 전일고가 ' + callRef.label + (Number.isFinite(breakout) ? ' (BTC ' + money(breakout) + ')' : '')
    + ' · 풋 전일저가 ' + putRef.label + (Number.isFinite(breakdown) ? ' (BTC ' + money(breakdown) + ')' : '');
}
