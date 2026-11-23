'use strict';

const el = id => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
const clock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium'
});
const money = value => Number.isFinite(value) ? '$' + usd.format(value) : '—';
const valueOf = value => value == null || value === '' ? NaN : Number(value);
const positive = value => valueOf(value) > 0 ? Number(value) : NaN;
const namePattern = /^BTC-(\d{8})-(\d+(?:\.\d+)?)-([CP])$/;
const maxAge = 30000;
const ticks = new Map();
let socket;
let requests = new Map();
let requestId = 0;
let retry = 1000;
let revision = 0;
let contracts = new Map();
let settlement = NaN;
let subscriptions = [];
let lastStream = 0;
let message = '연결 중';
let lastFrame = 0;
let lastCatalog = 0;

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      requests.delete(id);
      reject(new Error(method + ' 응답 시간 초과'));
    }, 10000);
    requests.set(id, {resolve, reject, timeout});
    try {
      socket.send(JSON.stringify({jsonrpc: '2.0', id, method, params}));
    } catch (error) {
      clearTimeout(timeout);
      requests.delete(id);
      reject(error);
    }
  });
}

function dateFor(expiry) {
  return Date.parse(expiry.slice(0, 4) + '-' + expiry.slice(4, 6) + '-' + expiry.slice(6) + 'T08:00:00Z');
}

function addTick(name, data) {
  if (!contracts.has(name) || name.split('-')[1] !== el('expiry').value || !data) return;
  const t = valueOf(data.t ?? data.timestamp);
  if (!Number.isFinite(t) || t < (ticks.get(name)?.t ?? 0)) return;
  const pricing = data.option_pricing ?? data.op ?? data.o ?? {};
  ticks.set(name, {
    t, bid: positive(data.b ?? data.best_bid_price),
    ask: positive(data.a ?? data.best_ask_price),
    mark: positive(data.M ?? data.mark_price),
    index: positive(data.I ?? data.index_price),
    iv: positive(pricing.i ?? pricing.iv),
    forward: positive(pricing.f ?? pricing.forward_price),
    oi: valueOf(data.stats?.oi ?? data.stats?.open_interest)
  });
}

async function catalog() {
  const result = await rpc('public/get_all_live_instruments');
  const names = Array.isArray(result) ? result : result.instruments ?? result.instrument_names;
  if (!Array.isArray(names)) throw new Error('활성 계약 조회 응답 형식 오류');
  const next = new Map();
  for (const item of names) {
    const name = typeof item === 'string' ? item : item.instrument_name;
    const match = name?.match(namePattern);
    if (match) next.set(name, {expiry: match[1], strike: Number(match[2]), type: match[3]});
  }
  const dates = [...new Set([...next.values()].map(item => item.expiry))]
    .filter(date => dateFor(date) > Date.now()).sort();
  if (!dates.length) throw new Error('현재 BTC 옵션 만기를 찾을 수 없습니다');
  const oldExpiry = el('expiry').value;
  const before = [...contracts.keys()].filter(name => name.split('-')[1] === oldExpiry).sort().join(',');
  contracts = next;
  lastCatalog = Date.now();
  el('expiry').replaceChildren(...dates.map(date => new Option(clock.format(dateFor(date)), date)));
  if (dates.includes(oldExpiry)) el('expiry').value = oldExpiry;
  const after = [...contracts.keys()].filter(name => name.split('-')[1] === el('expiry').value).sort().join(',');
  if (!subscriptions.length || before !== after) await selectExpiry();
}

async function selectExpiry() {
  const version = ++revision;
  const expiry = el('expiry').value;
  const options = [...contracts].filter(([, item]) => item.expiry === expiry);
  ticks.clear();
  lastStream = 0;
  settlement = dateFor(expiry);
  message = '옵션 체인 조회 중';
  const previousStrike = el('strike').value;
  const typesByStrike = new Map();
  for (const [, item] of options) {
    if (!typesByStrike.has(item.strike)) typesByStrike.set(item.strike, new Set());
    typesByStrike.get(item.strike).add(item.type);
  }
  const paired = [...typesByStrike].filter(([, types]) => types.size === 2).map(([strike]) => strike).sort((a, b) => a - b);
  el('strike').replaceChildren(new Option('자동 · ATM', ''), ...paired.map(k => new Option(money(k), k)));
  if (paired.includes(Number(previousStrike))) el('strike').value = previousStrike;
  const old = subscriptions;
  subscriptions = [];
  if (old.length) await rpc('unsubscribe', {channels: old});
  if (version !== revision) return;
  subscriptions = options.map(([name]) => 'ticker_slim.' + name + '.1000');
  const ack = await rpc('subscribe', {channels: subscriptions});
  if (version !== revision) return;
  const errors = Object.values(ack.status ?? {}).filter(s => !['ok', 'already subscribed'].includes(s)).length;
  message = errors ? '일부 계약 구독 오류 (' + errors + '건)' : '시세 수신 대기';
  const [result, instrument] = await Promise.all([
    rpc('public/get_tickers', {currency: 'BTC', instrument_type: 'option', expiry_date: expiry}),
    rpc('public/get_instrument', {instrument_name: options[0][0]}).catch(() => null)
  ]);
  if (version !== revision) return;
  const exactExpiry = positive((instrument?.instrument ?? instrument)?.option_details?.expiry);
  if (Number.isFinite(exactExpiry)) settlement = exactExpiry < 1e12 ? exactExpiry * 1000 : exactExpiry;
  const map = result.tickers ?? result;
  for (const [name, data] of Object.entries(map)) addTick(name, data);
  message = errors ? '일부 계약 구독 오류 (' + errors + '건)' : '스냅샷 수신 · 실시간 갱신 대기';
  retry = 1000;
}

function connect() {
  message = 'Derive 연결 중';
  const conn = new WebSocket('wss://api.derive.xyz/v3/ws');
  socket = conn;
  lastFrame = Date.now();
  conn.onopen = () => catalog().catch(error => reconnect(error, conn));
  conn.onmessage = event => {
    lastFrame = Date.now();
    if (event.data === 'pong') return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.method === 'subscription') {
      const name = frame.params?.channel?.split('.').slice(1, -1).join('.');
      if (!subscriptions.includes(frame.params?.channel) || !contracts.has(name)) return;
      addTick(name, frame.params.data);
      if (ticks.has(name)) lastStream = Date.now();
      return;
    }
    const pending = requests.get(frame.id);
    if (!pending) return;
    requests.delete(frame.id);
    clearTimeout(pending.timeout);
    if (frame.error) pending.reject(new Error(frame.error.message || 'Derive API 오류'));
    else pending.resolve(frame.result);
  };
  conn.onerror = () => reconnect(new Error('Derive WebSocket 연결 오류'), conn);
  conn.onclose = () => {
    ++revision;
    for (const pending of requests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('연결 종료'));
    }
    requests.clear();
    subscriptions = [];
    lastStream = 0;
    message += ' · 자동 재연결 대기';
    setTimeout(connect, retry + Math.random() * 500);
    retry = Math.min(30000, retry * 2);
  };
}

function reconnect(error, conn = socket) {
  if (conn !== socket || conn.readyState >= WebSocket.CLOSING) return;
  message = error.message;
  conn.close();
}

function normal(x) {
  const z = Math.abs(x);
  const u = 1 / (1 + .2316419 * z);
  const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI)
    * u * (.319381530 + u * (-.356563782 + u * (1.781477937 + u * (-1.821255978 + u * 1.330274429))));
  return x < 0 ? tail : 1 - tail;
}

function black76(type, forward, strike, iv, years) {
  if (![forward, strike, iv, years].every(Number.isFinite) || forward <= 0 || strike <= 0 || iv <= 0) return NaN;
  const sign = type === 'C' ? 1 : -1;
  if (years <= 0) return Math.max(sign * (forward - strike), 0);
  const volTime = iv * Math.sqrt(years);
  const d1 = Math.log(forward / strike) / volTime + volTime / 2;
  return Math.max(0, sign * (forward * normal(sign * d1) - strike * normal(sign * (d1 - volTime))));
}

function quoteCells(tick) {
  return [
    money(tick?.bid), money(tick?.ask), money(tick?.mark),
    Number.isFinite(tick?.iv) ? usd.format(tick.iv * 100) + '%' : '—',
    Number.isFinite(tick?.oi) ? usd.format(tick.oi) : '—'
  ];
}

function render() {
  const now = Date.now();
  const expiry = el('expiry').value;
  const rows = new Map();
  let newest = null;
  for (const [name, option] of contracts) {
    if (option.expiry !== expiry) continue;
    const tick = ticks.get(name);
    if (!rows.has(option.strike)) rows.set(option.strike, {});
    if (!tick || now >= settlement || now - tick.t > maxAge || tick.t - now > maxAge || socket.readyState !== WebSocket.OPEN) continue;
    rows.get(option.strike)[option.type] = tick;
    if (Number.isFinite(tick.index) && (!newest || tick.t > newest.t)) newest = tick;
  }
  const strikes = [...rows.keys()].sort((a, b) => a - b);
  const atm = newest ? strikes.filter(k => rows.get(k).C && rows.get(k).P)
    .reduce((best, k) => Math.abs(k - newest.index) < Math.abs(best - newest.index) ? k : best, Infinity) : Infinity;
  const strike = Number(el('strike').value) || atm;
  const {C: call, P: put} = rows.get(strike) ?? {};
  const freshPair = call && put && Math.abs(call.t - put.t) <= 5000;
  const move = Number(el('move').value) / 100;
  const shift = Number(el('vol').value) / 100;
  const hours = Number(el('hours').value);
  const years = (settlement - now - Math.max(hours, 0) * 3600000) / (365 * 86400000);
  const fair = (type, tick) => freshPair && now < settlement
    ? black76(type, tick.forward * (1 + move), strike, tick.iv + shift, years) : NaN;
  const midpoint = tick => tick?.ask >= tick?.bid ? (tick.ask + tick.bid) / 2 : NaN;
  const askSum = freshPair && now < settlement ? call.ask + put.ask : NaN;
  const values = [
    ['BTC 지수', money(newest?.index)], ['기준 행사가', money(strike)],
    ['남은 시간', Number.isFinite(settlement) ? usd.format(Math.max(0, settlement - now) / 3600000) + '시간' : '—'],
    ['콜 − 풋 Mark', money(freshPair ? call.mark - put.mark : NaN)],
    ['콜 − 풋 중간가', money(freshPair ? midpoint(call) - midpoint(put) : NaN)],
    ['스트래들 Mark 합', money(freshPair ? call.mark + put.mark : NaN)],
    ['스트래들 Ask 합', money(askSum)],
    ['만기 손익분기점', Number.isFinite(askSum) ? money(strike - askSum) + ' / ' + money(strike + askSum) : '—'],
    ['시나리오 콜 / 풋', money(fair('C', call)) + ' / ' + money(fair('P', put))]
  ];
  el('metrics').innerHTML = values.map(([label, val]) => '<div class="metric">' + label + '<strong>' + val + '</strong></div>').join('');
  el('chain').innerHTML = strikes.map(k => {
    const row = rows.get(k);
    return '<tr' + (k === strike ? ' class="atm"' : '') + '>' + [money(k), ...quoteCells(row.C), ...quoteCells(row.P)].map(cell => '<td>' + cell + '</td>').join('') + '</tr>';
  }).join('');
  el('status').textContent = newest
    ? (now - lastStream < 15000 ? '실시간 구독' : message) + ' · 마지막 거래소 시세 ' + clock.format(newest.t)
    : message + ' · 유효 시세 없음';
  drawPremiumChart({
    now, strike, index: newest?.index, call, put, freshPair,
    expiry, shift, years, settlement, contracts
  });
  el('caption').textContent = freshPair
    ? '콜 ' + clock.format(call.t) + ' · 풋 ' + clock.format(put.t) + ' · Ask는 호가 기준, Mark는 거래소 평가가격'
    : '동일 만기·행사가이며 시세 시각 차이가 5초 이내인 콜·풋이 필요합니다. 30초가 지난 시세는 숨깁니다.';
}

el('expiry').addEventListener('change', () => {
  if (socket.readyState === WebSocket.OPEN) selectExpiry().catch(error => reconnect(error));
});
for (const id of ['strike', 'move', 'vol', 'hours', 'chart-demo']) el(id).addEventListener('input', render);
connect();
setInterval(render, 1000);
setInterval(() => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastFrame > 60000) {
    reconnect(new Error('시세 연결 응답 없음'));
    return;
  }
  socket.send('ping');
  if (Date.now() - lastCatalog > 300000 || Date.now() >= settlement) {
    catalog().catch(error => reconnect(error));
  }
}, 20000);
