// Графикът ми — личен планер за работни и лични задачи.
// Всички данни се пазят локално на устройството (localStorage).

import { parseCommand, matchScore } from './voice.js';

const STORAGE_KEY = 'ps-data-v1';
const DAY_SHORT = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DAY_LONG = ['Неделя', 'Понеделник', 'Вторник', 'Сряда', 'Четвъртък', 'Петък', 'Събота'];
const MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
const MONTHS_TITLE = MONTHS.map(m => m[0].toUpperCase() + m.slice(1));
const CATS = { work: 'Работа', personal: 'Лично' };
const PRIORITIES = { high: 'Висок', normal: 'Нормален', low: 'Нисък' };
const DURATIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const PX_PER_MIN = 1.2;
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

// ---------- Помощни функции ----------

const pad = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); };
const todayKey = () => toKey(new Date());
const weekStart = k => { const d = fromKey(k); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return toKey(d); };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

function fmtDur(m) {
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}
function fmtDate(k) {
  const d = fromKey(k);
  return `${DAY_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function fmtShort(k) {
  const d = fromKey(k);
  return `${DAY_SHORT[d.getDay()]} ${d.getDate()}.${pad(d.getMonth() + 1)}`;
}
function relDay(k) {
  const t = todayKey();
  if (k === t) return 'Днес';
  if (k === addDays(t, 1)) return 'Утре';
  if (k === addDays(t, -1)) return 'Вчера';
  return '';
}

// ---------- Данни ----------

function defaultState() {
  return {
    version: 1,
    tasks: [],
    entries: [],
    skips: {},
    weekly: {},
    dayNotes: {},
    notes: [],
    lastEveningReview: null,
    settings: { dayStart: 6, dayEnd: 23, capacityHours: 8, reviewHour: 19 },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaultState();
      return { ...d, ...s, settings: { ...d.settings, ...s.settings } };
    }
  } catch (e) {
    console.error(e);
  }
  return defaultState();
}

let state = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Грешка при запис на данните!');
  }
}

const taskById = id => state.tasks.find(t => t.id === id);
const entryById = id => state.entries.find(e => e.id === id);
const taskOf = e => taskById(e.taskId) || { title: '(изтрита задача)', category: 'personal', recurrence: { type: 'none' } };
const isRecurring = t => t.recurrence && t.recurrence.type !== 'none';
const mapsUrl = place => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
const knownLocations = () => [...new Set(state.tasks.filter(t => !t.archived && t.location).map(t => t.location))].sort((a, b) => a.localeCompare(b, 'bg'));
const locationDatalist = () => `<datalist id="loc-list">${knownLocations().map(l => `<option value="${esc(l)}">`).join('')}</datalist>`;

function recursOn(task, k) {
  const r = task.recurrence;
  if (!r || r.type === 'none') return false;
  if (task.startDate && k < task.startDate) return false;
  const d = fromKey(k), dow = d.getDay();
  switch (r.type) {
    case 'daily': return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': return (r.days || []).includes(dow);
    case 'monthly': return d.getDate() === Number(r.dayOfMonth);
  }
  return false;
}

function recurLabel(r) {
  if (!r) return '';
  switch (r.type) {
    case 'daily': return 'Всеки ден';
    case 'weekdays': return 'Делнични дни';
    case 'weekly': return (r.days || []).length
      ? MON_FIRST.filter(d => r.days.includes(d)).map(d => DAY_SHORT[d]).join(', ')
      : 'Седмично';
    case 'monthly': return `Всеки ${r.dayOfMonth}-ви от месеца`;
  }
  return '';
}

// Повтарящите се задачи се добавят в графика едва когато денят бъде отворен,
// и само за днес и бъдещи дни, така че пропуснатите не се трупат.
function ensureDay(k) {
  if (k < todayKey()) return;
  let changed = false;
  for (const t of state.tasks) {
    if (t.archived || !recursOn(t, k)) continue;
    if (state.skips[`${t.id}|${k}`]) continue;
    if (state.entries.some(e => e.auto && e.taskId === t.id && e.origin === k)) continue;
    state.entries.push({
      id: uid(), taskId: t.id, date: k, origin: k, auto: true,
      start: t.defaultTime || null, duration: t.duration, done: false,
    });
    changed = true;
  }
  if (changed) save();
}

const dayEntries = k => state.entries.filter(e => e.date === k);

function sortEntries(list) {
  const prio = { high: 0, normal: 1, low: 2 };
  return list.slice().sort((a, b) => {
    if (a.start && b.start) return a.start.localeCompare(b.start);
    if (a.start) return -1;
    if (b.start) return 1;
    return (prio[taskOf(a).priority] ?? 1) - (prio[taskOf(b).priority] ?? 1);
  });
}

function minutesByCat(list) {
  return {
    work: sum(list.filter(e => taskOf(e).category === 'work'), e => e.duration),
    personal: sum(list.filter(e => taskOf(e).category !== 'work'), e => e.duration),
  };
}

function setDone(e, done) {
  e.done = done;
  const t = taskById(e.taskId);
  if (t && !isRecurring(t)) t.done = done;
}

function removeEntry(e) {
  if (e.auto) state.skips[`${e.taskId}|${e.origin}`] = true;
  state.entries = state.entries.filter(x => x !== e);
}

function addEntry(task, date, start) {
  const e = {
    id: uid(), taskId: task.id, date, start: start || task.defaultTime || null,
    duration: task.duration, done: false,
  };
  state.entries.push(e);
  return e;
}

// Предстоящо планиране на еднократна задача (днес или по-късно).
const upcomingEntry = t => state.entries.find(e => e.taskId === t.id && e.date >= todayKey() && !e.done);

function eveningPending() {
  const t = todayKey();
  return new Date().getHours() >= state.settings.reviewHour && state.lastEveningReview !== t;
}
function weeklyPending() {
  return !state.weekly[weekStart(todayKey())]?.done;
}

// ---------- UI състояние ----------

const ui = {
  tab: 'day',
  date: todayKey(),
  weekOf: weekStart(todayKey()),
  month: todayKey().slice(0, 7),
  libCat: 'all',
  libSearch: '',
  showDone: false,
  scrolledFor: null,
};
let sheet = null;

const $view = document.getElementById('view');
const $sheet = document.getElementById('sheet-root');

function render() {
  const navTab = ui.tab === 'month' ? 'week' : ui.tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === navTab));
  document.querySelector('#tabs .dot').hidden = !(eveningPending() || weeklyPending());
  const views = { day: viewDay, week: viewWeek, month: viewMonth, tasks: viewTasks, notes: viewNotes, review: viewReview };
  $view.innerHTML = views[ui.tab]();
  if (ui.tab === 'day') autoScroll();
}

function autoScroll() {
  if (ui.scrolledFor === ui.date) return;
  ui.scrolledFor = ui.date;
  const target = document.querySelector('.tl-now') || document.querySelector('.block') ||
    document.querySelector(`.tl-hour[data-h="8"]`);
  if (target) {
    const y = target.getBoundingClientRect().top + window.scrollY - 160;
    window.scrollTo({ top: Math.max(0, y) });
  }
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// ---------- Общи елементи ----------

function capacityBar(list, capMin) {
  const m = minutesByCat(list);
  const total = m.work + m.personal;
  const scale = Math.max(total, capMin) || 1;
  const over = total > capMin;
  return `
    <div class="capacity ${over ? 'over' : ''}">
      <div class="meta">
        <span>Планирано: <b>${fmtDur(total)}</b> от ${fmtDur(capMin)}</span>
        <span>${list.filter(e => e.done).length}/${list.length} готови</span>
      </div>
      <div class="bar"><i class="w" style="width:${m.work / scale * 100}%"></i><i class="p" style="width:${m.personal / scale * 100}%"></i></div>
      ${over ? `<div class="overmsg">Претоварен ден с ${fmtDur(total - capMin)}. Премести нещо, за да е реалистично.</div>` : ''}
    </div>`;
}

function entryItem(e, opts = {}) {
  const t = taskOf(e);
  return `
    <div class="item cat-${t.category} ${e.done ? 'done' : ''}" data-action="open-entry" data-id="${e.id}">
      <button class="check ${e.done ? 'on' : ''}" data-action="toggle-done" data-id="${e.id}" aria-label="Готово">${e.done ? '✓' : ''}</button>
      <div class="body">
        <div class="t">${esc(t.title)}</div>
        <div class="s">
          ${opts.showDate ? `<span>${fmtShort(e.date)}</span>` : ''}
          ${e.start ? `<span>${e.start}</span>` : ''}
          <span>${fmtDur(e.duration)}</span>
          ${isRecurring(t) ? '<span>↻</span>' : ''}
          ${t.priority === 'high' ? '<span class="tag plain">!</span>' : ''}
          ${t.location ? `<span>📍 ${esc(t.location)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// Превключвател Седмица/Месец в горната част на двата изгледа.
const periodSwitch = () => `
  <div class="seg" style="margin-bottom:10px">
    <button class="${ui.tab === 'week' ? 'on' : ''}" data-action="tab" data-tab="week">Седмица</button>
    <button class="${ui.tab === 'month' ? 'on' : ''}" data-action="tab" data-tab="month">Месец</button>
  </div>`;

function focusCard(wk) {
  const goals = (state.weekly[wk]?.goals || []).filter(Boolean);
  if (!goals.length) return '';
  return `<div class="card focus"><b>Фокус за седмицата</b><ol>${goals.map(g => `<li>${esc(g)}</li>`).join('')}</ol></div>`;
}

// ---------- Изглед: Ден ----------

function viewDay() {
  const k = ui.date, t = todayKey();
  ensureDay(k);
  const s = state.settings;
  const list = dayEntries(k);
  const timed = list.filter(e => e.start);
  const untimed = sortEntries(list.filter(e => !e.start));
  const rel = relDay(k);

  let banners = '';
  if (k === t && weeklyPending()) {
    banners += `<button class="banner" data-action="go-review"><span>Направи седмичния преглед, за да планираш седмицата</span>›</button>`;
  }
  if (k === t && eveningPending()) {
    banners += `<button class="banner warn" data-action="go-review"><span>Време е за вечерния преглед (2 мин)</span>›</button>`;
  }

  return `
    <div class="datenav">
      <button class="iconbtn" data-action="day-shift" data-n="-1">‹</button>
      <div class="title"><b>${rel || DAY_LONG[fromKey(k).getDay()]}</b><span>${fmtDate(k)}</span></div>
      <button class="iconbtn" data-action="day-shift" data-n="1">›</button>
    </div>
    ${k !== t ? `<button class="btn small full" style="margin-bottom:12px" data-action="go-today">Към днес</button>` : ''}
    ${banners}
    ${focusCard(weekStart(k))}
    ${capacityBar(list, s.capacityHours * 60)}
    ${untimed.length ? `<h3>Без час (${untimed.length})</h3><div class="untimed">${untimed.map(e => entryItem(e)).join('')}</div>` : ''}
    <h3>График</h3>
    <p class="muted small">Докосни празно място, за да сложиш задача в този час.</p>
    ${timeline(k, timed)}
    <button class="fab" data-action="add" data-date="${k}">+</button>`;
}

function layoutLanes(timed) {
  const items = timed
    .map(e => ({ e, s: toMin(e.start), end: toMin(e.start) + e.duration }))
    .sort((a, b) => a.s - b.s);
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const ends = [];
    for (const it of cluster) {
      let lane = ends.findIndex(x => x <= it.s);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = it.end;
      it.lane = lane;
    }
    cluster.forEach(it => { it.lanes = ends.length; });
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = cluster.length === 1 ? it.end : Math.max(clusterEnd, it.end);
  }
  if (cluster.length) flush();
  return items;
}

function timeline(k, timed) {
  const s = state.settings;
  const startMin = Math.min(s.dayStart * 60, ...timed.map(e => toMin(e.start)));
  const endMin = Math.max(s.dayEnd * 60, ...timed.map(e => toMin(e.start) + e.duration));
  const firstH = Math.floor(startMin / 60), lastH = Math.ceil(endMin / 60);
  const y = m => (m - firstH * 60) * PX_PER_MIN;
  let html = `<div class="timeline" data-action="tl-tap" data-date="${k}" data-first="${firstH}" style="height:${y(lastH * 60) + 10}px">`;
  for (let h = firstH; h <= lastH; h++) {
    html += `<div class="tl-hour" data-h="${h}" style="top:${y(h * 60)}px"><span>${pad(h)}:00</span></div>`;
    if (h < lastH) html += `<div class="tl-half" style="top:${y(h * 60 + 30)}px"></div>`;
  }
  if (k === todayKey()) {
    const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
    if (nm >= firstH * 60 && nm <= lastH * 60) html += `<div class="tl-now" style="top:${y(nm)}px"></div>`;
  }
  for (const it of layoutLanes(timed)) {
    const e = it.e, t = taskOf(e);
    const h = Math.max(e.duration * PX_PER_MIN, 26);
    const left = `calc(52px + (100% - 54px) * ${it.lane} / ${it.lanes})`;
    const width = `calc((100% - 54px) / ${it.lanes} - 3px)`;
    html += `
      <div class="block cat-${t.category} ${e.done ? 'done' : ''}" data-action="open-entry" data-id="${e.id}"
           style="top:${y(it.s)}px;height:${h}px;left:${left};width:${width}">
        <button class="check ${e.done ? 'on' : ''}" data-action="toggle-done" data-id="${e.id}">${e.done ? '✓' : ''}</button>
        <div><div class="bt">${esc(t.title)}</div>${h >= 40 ? `<div class="bs">${e.start}–${fromMin(it.end % 1440)}${t.location ? ` · 📍 ${esc(t.location)}` : ''}</div>` : ''}</div>
      </div>`;
  }
  return html + '</div>';
}

// ---------- Изглед: Седмица ----------

function viewWeek() {
  const wk = ui.weekOf, t = todayKey();
  const end = addDays(wk, 6);
  const d0 = fromKey(wk), d1 = fromKey(end);
  const cap = state.settings.capacityHours * 60;
  let all = [];
  let days = '';
  for (let i = 0; i < 7; i++) {
    const k = addDays(wk, i);
    ensureDay(k);
    const list = sortEntries(dayEntries(k));
    all = all.concat(list);
    const m = minutesByCat(list);
    const total = m.work + m.personal;
    const scale = Math.max(total, cap) || 1;
    days += `
      <div class="card day-card ${k === t ? 'today' : ''}">
        <header>
          <button class="name" data-action="open-day" data-date="${k}">${DAY_LONG[fromKey(k).getDay()]}<span>${fromKey(k).getDate()}.${pad(fromKey(k).getMonth() + 1)} · ${fmtDur(total)}${total > cap ? ' ⚠️' : ''}</span></button>
          <button class="btn small" data-action="add" data-date="${k}">+</button>
        </header>
        <div class="bar"><i class="w" style="width:${m.work / scale * 100}%"></i><i class="p" style="width:${m.personal / scale * 100}%"></i></div>
        ${list.length ? list.map(e => {
          const tk = taskOf(e);
          return `<button class="mini cat-${tk.category} ${e.done ? 'done' : ''}" data-action="open-entry" data-id="${e.id}">
            <i class="pip"></i><span class="tm">${e.start || '—'}</span><span class="ttl">${esc(tk.title)}</span></button>`;
        }).join('') : '<div class="muted small">Нищо планирано</div>'}
      </div>`;
  }
  const done = all.filter(e => e.done).length;
  return `
    ${periodSwitch()}
    <div class="datenav">
      <button class="iconbtn" data-action="week-shift" data-n="-7">‹</button>
      <div class="title"><b>${d0.getDate()} ${MONTHS[d0.getMonth()]} – ${d1.getDate()} ${MONTHS[d1.getMonth()]}</b><span>${done}/${all.length} готови · ${fmtDur(sum(all, e => e.duration))}</span></div>
      <button class="iconbtn" data-action="week-shift" data-n="7">›</button>
    </div>
    ${wk !== weekStart(t) ? `<button class="btn small full" style="margin-bottom:12px" data-action="week-today">Към тази седмица</button>` : ''}
    ${focusCard(wk)}
    ${days}`;
}

// ---------- Изглед: Месец ----------

function viewMonth() {
  const [y, m] = ui.month.split('-').map(Number);
  const first = `${y}-${pad(m)}-01`;
  const t = todayKey();
  const cap = state.settings.capacityHours * 60;
  let k = weekStart(first);
  let cells = MON_FIRST.map(d => `<div class="dow">${DAY_SHORT[d]}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = fromKey(k);
    if (i >= 35 && d.getMonth() !== m - 1) break;
    if (d.getMonth() === m - 1) ensureDay(k);
    const list = dayEntries(k);
    const total = sum(list, e => e.duration);
    const done = list.filter(e => e.done).length;
    const pct = Math.min(1, total / (cap || 1)) * 100;
    cells += `
      <button class="mcell ${d.getMonth() !== m - 1 ? 'out' : ''} ${k === t ? 'today' : ''}" data-action="open-day" data-date="${k}">
        <span>${d.getDate()}</span>
        <span class="cnt">${list.length ? `${done}/${list.length}` : ''}</span>
        <span class="bar"><i class="${total > cap ? '' : 'w'}" style="width:${pct}%;${total > cap ? 'background:var(--danger)' : ''}"></i></span>
      </button>`;
    k = addDays(k, 1);
  }
  return `
    ${periodSwitch()}
    <div class="datenav">
      <button class="iconbtn" data-action="month-shift" data-n="-1">‹</button>
      <div class="title"><b>${MONTHS_TITLE[m - 1]} ${y}</b><span>Докосни ден, за да го отвориш</span></div>
      <button class="iconbtn" data-action="month-shift" data-n="1">›</button>
    </div>
    <div class="month">${cells}</div>`;
}

// ---------- Изглед: Задачи (библиотека) ----------

function libraryRow(t) {
  const up = !isRecurring(t) && upcomingEntry(t);
  return `
    <div class="item cat-${t.category} ${t.done ? 'done' : ''}" data-action="edit-task" data-id="${t.id}">
      <div class="body">
        <div class="t">${esc(t.title)}</div>
        <div class="s">
          <span class="tag">${CATS[t.category]}</span>
          <span>${fmtDur(t.duration)}</span>
          ${isRecurring(t) ? `<span>↻ ${recurLabel(t.recurrence)}${t.defaultTime ? ' · ' + t.defaultTime : ''}</span>` : ''}
          ${up ? `<span>📅 ${fmtShort(up.date)}${up.start ? ' ' + up.start : ''}</span>` : ''}
          ${t.priority === 'high' ? '<span class="tag plain">Висок приоритет</span>' : ''}
          ${t.location ? `<span>📍 ${esc(t.location)}</span>` : ''}
        </div>
      </div>
      ${!t.done ? `<button class="btn small" data-action="schedule" data-id="${t.id}">Планирай</button>` : ''}
    </div>`;
}

function viewTasks() {
  const q = ui.libSearch.trim().toLowerCase();
  const prio = { high: 0, normal: 1, low: 2 };
  const visible = state.tasks
    .filter(t => !t.archived)
    .filter(t => ui.libCat === 'all' || t.category === ui.libCat)
    .filter(t => !q || t.title.toLowerCase().includes(q) || (t.location || '').toLowerCase().includes(q))
    .sort((a, b) => (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1) || a.title.localeCompare(b.title, 'bg'));
  const recurring = visible.filter(isRecurring);
  const open = visible.filter(t => !isRecurring(t) && !t.done);
  const unplanned = open.filter(t => !upcomingEntry(t));
  const planned = open.filter(t => upcomingEntry(t));
  const done = visible.filter(t => !isRecurring(t) && t.done);
  const section = (title, list) => list.length
    ? `<h3>${title} (${list.length})</h3><div class="stack">${list.map(libraryRow).join('')}</div>` : '';

  return `
    <h1>Задачи</h1>
    <input class="search" type="search" id="lib-search" placeholder="Търси по име или място..." value="${esc(ui.libSearch)}">
    <div class="seg" style="margin-bottom:8px">
      ${['all', 'work', 'personal'].map(c => `<button class="${ui.libCat === c ? 'on' : ''}" data-action="lib-cat" data-cat="${c}">${c === 'all' ? 'Всички' : CATS[c]}</button>`).join('')}
    </div>
    ${!state.tasks.length ? `<div class="empty">Тук ще са всички твои задачи.<br>Добави първата с бутона +.<br><br>Повтарящите се (всеки ден, всеки понеделник...) влизат в графика сами.</div>` : ''}
    ${section('Чакат да бъдат планирани', unplanned)}
    ${section('Повтарящи се', recurring)}
    ${section('Планирани', planned)}
    ${done.length ? `<button class="btn small full" style="margin-top:16px" data-action="toggle-show-done">${ui.showDone ? 'Скрий' : 'Покажи'} завършените (${done.length})</button>` : ''}
    ${ui.showDone ? section('Завършени', done) : ''}
    <button class="fab" data-action="new-task">+</button>`;
}

// ---------- Изглед: Бележки ----------

const noteById = id => state.notes.find(n => n.id === id);

function newNote(fields) {
  const n = { id: uid(), title: '', type: 'checklist', text: '', items: [], pinned: false, updatedAt: new Date().toISOString(), ...fields };
  state.notes.push(n);
  return n;
}

const touchNote = n => { n.updatedAt = new Date().toISOString(); };
const noteIsEmpty = n => !n.title.trim() && !n.text.trim() && !n.items.length;

function noteCard(n) {
  const done = n.items.filter(i => i.done).length;
  let body;
  if (n.type === 'text') {
    body = n.text.trim() ? `<div class="note-text">${esc(n.text)}</div>` : '<div class="muted small">Празна бележка</div>';
  } else {
    const open = n.items.filter(i => !i.done);
    body = `
      ${n.items.length ? `<div class="bar" style="height:5px;margin:4px 0 8px"><i class="w" style="width:${done / n.items.length * 100}%"></i></div>` : ''}
      ${open.slice(0, 5).map(i => `
        <div class="ci">
          <button class="check" data-action="note-item-toggle" data-note="${n.id}" data-item="${i.id}"></button>
          <span>${esc(i.text)}</span>
        </div>`).join('')}
      ${open.length > 5 ? `<div class="muted small">+ още ${open.length - 5}</div>` : ''}
      ${!n.items.length ? '<div class="muted small">Празен списък</div>' : ''}
      ${n.items.length && !open.length ? '<div class="muted small">Всичко е отметнато ✓</div>' : ''}`;
  }
  return `
    <div class="card note-card" data-action="open-note" data-id="${n.id}">
      <div class="note-head">
        <b>${n.pinned ? '⭐ ' : ''}${esc(n.title || 'Без заглавие')}</b>
        ${n.type === 'checklist' && n.items.length ? `<span class="muted small">${done}/${n.items.length}</span>` : ''}
      </div>
      ${body}
    </div>`;
}

function viewNotes() {
  const notes = state.notes.slice().sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt));
  return `
    <h1>Бележки</h1>
    ${notes.length ? notes.map(noteCard).join('') : `<div class="empty">Тук пазиш важни неща: списъци за пазар, идеи, пароли за Wi-Fi, подаръци...<br><br>Всяка бележка може да е свободен текст или списък с отметки.<br>Отбележи най-важните със ⭐, за да стоят най-горе.</div>`}
    <button class="fab" data-action="new-note">+</button>`;
}

// ---------- Гласови команди ----------

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;

// Слуша една фраза. Връща false, ако браузърът не поддържа разпознаване на говор.
function listen({ onText, onFinal, onState }) {
  if (!SpeechRec) return false;
  if (recognizer) { recognizer.stop(); return true; }
  const r = new SpeechRec();
  r.lang = 'bg-BG';
  r.interimResults = true;
  r.continuous = false;
  let heard = '';
  r.onresult = ev => {
    heard = [...ev.results].map(res => res[0].transcript).join('');
    onText?.(heard);
  };
  r.onerror = ev => {
    const msg = {
      'not-allowed': 'Няма достъп до микрофона. Разреши го в настройките на браузъра.',
      'service-not-allowed': 'Няма достъп до микрофона. Разреши го в настройките на браузъра.',
      'no-speech': 'Не чух нищо. Опитай пак.',
      'network': 'Разпознаването на говор изисква интернет.',
    }[ev.error] || `Грешка при разпознаване (${ev.error})`;
    onState?.('error', msg);
  };
  r.onend = () => {
    recognizer = null;
    onState?.('idle');
    if (heard) onFinal(heard);
  };
  recognizer = r;
  r.start();
  onState?.('listening');
  return true;
}

function stopListening() {
  if (recognizer) { recognizer.onend = null; recognizer.abort(); recognizer = null; }
}

const VOICE_EXAMPLES = [
  'Добави среща с Иван утре в 10 в офиса за час',
  'Фитнес всеки понеделник и четвъртък в 18 и 30',
  'Отчет за клиента в петък в 3 следобед, работа',
  'Купи подарък за мама',
  'Свърших разходката',
  'Премести отчета за четвъртък в 11',
  'В списък Пазар мляко',
  'Бележка паролата за Wi-Fi е на рутера',
];

function sheetVoice() {
  return `
    <h2>Гласова команда</h2>
    <div class="voice-box">
      <button class="mic-big" id="mic-big" data-action="voice-listen" aria-label="Говори">
        <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
      </button>
      <p id="voice-status" class="muted small">${SpeechRec ? 'Докосни микрофона и кажи команда' : 'Този браузър не разпознава говор. Използвай микрофона на клавиатурата и диктувай в полето.'}</p>
    </div>
    <form id="voice-form">
      <textarea id="voice-text" rows="2" placeholder="...или напиши командата тук"></textarea>
      <button class="btn full" style="margin-top:8px" type="submit">Разбери командата</button>
    </form>
    <div id="voice-result"></div>
    <details>
      <summary>Какво мога да кажа?</summary>
      <ul class="examples">${VOICE_EXAMPLES.map(x => `<li>„${x}“</li>`).join('')}</ul>
      <p class="muted small">Ден: днес, утре, вдругиден, в петък, следващия вторник, на 20-ти, на 5 ноември.<br>
      Час: в 10, в 10 и половина, в 3 следобед, в 9 без четвърт.<br>
      Продължителност: за 20 минути, за час, за час и половина.<br>
      Повторение: всеки ден, всеки делничен ден, всеки вторник и петък, всеки месец на 5-ти.<br>
      Място: „в офиса“, „при зъболекаря“ или „локация ул. Витоша 15“ в края.<br>
      Тип: „работа“ или „лична задача“; „спешно“ = висок приоритет.</p>
    </details>`;
}

// Превръща разбраната команда в конкретно действие с описание за потвърждение.
function planCommand(cmd) {
  const t = todayKey();
  const undone = state.entries.filter(e => !e.done && taskById(e.taskId) && !taskById(e.taskId).archived);
  const best = (query, list) => {
    let top = null, score = 0;
    for (const e of list) {
      const s = matchScore(query, taskOf(e).title) + (e.date === t ? 0.01 : 0);
      if (s > score) { score = s; top = e; }
    }
    return score >= 0.5 ? top : null;
  };
  switch (cmd.kind) {
    case 'add': {
      const category = cmd.category || 'work';
      const when = cmd.recurrence ? null : (cmd.date || (cmd.start ? t : null));
      const parts = [
        cmd.recurrence ? `↻ ${recurLabel({ ...cmd.recurrence, dayOfMonth: cmd.recurrence.dayOfMonth || fromKey(t).getDate() })}` : '',
        when ? `📅 ${relDay(when) || fmtShort(when)}` : '',
        cmd.start ? `🕐 ${cmd.start}` : '',
        `⏱ ${fmtDur(cmd.duration || 30)}`,
        cmd.location ? `📍 ${esc(cmd.location)}` : '',
        cmd.priority === 'high' ? '❗ Висок приоритет' : '',
      ].filter(Boolean);
      return {
        ok: true, kind: 'add', cmd: { ...cmd, category }, when,
        html: `<b>Нова задача: „${esc(cmd.title)}“</b><div class="s">${parts.map(p => `<span>${p}</span>`).join('')}</div>
          ${!when && !cmd.recurrence ? '<div class="muted small">Без дата: отива в списъка със задачи.</div>' : ''}
          <div class="seg" style="margin-top:8px">${Object.entries(CATS).map(([k, l]) => `<button class="${category === k ? 'on' : ''}" data-action="voice-cat" data-cat="${k}">${l}</button>`).join('')}</div>`,
      };
    }
    case 'done': {
      const e = best(cmd.query, undone.filter(x => x.date <= t));
      if (!e) return { ok: false, html: `Не намерих „${esc(cmd.query)}“ сред днешните задачи.` };
      return { ok: true, kind: 'done', entry: e, html: `<b>Отбележи като свършена:</b> „${esc(taskOf(e).title)}“ <span class="muted small">(${fmtShort(e.date)})</span>` };
    }
    case 'move': {
      if (!cmd.date && !cmd.start) return { ok: false, html: 'Кажи и за кога да преместя задачата, напр. „премести отчета за утре в 10“.' };
      const e = best(cmd.query, undone);
      if (!e) return { ok: false, html: `Не намерих задача „${esc(cmd.query)}“ в графика.` };
      const date = cmd.date || e.date;
      return {
        ok: true, kind: 'move', entry: e, date, start: cmd.start || e.start,
        html: `<b>Премести „${esc(taskOf(e).title)}“</b><div class="s"><span>от ${fmtShort(e.date)}${e.start ? ' ' + e.start : ''}</span><span>→ ${relDay(date) || fmtShort(date)}${cmd.start || e.start ? ' ' + (cmd.start || e.start) : ''}</span></div>`,
      };
    }
    case 'list': {
      const lower = cmd.rest.toLowerCase();
      const note = state.notes
        .filter(n => n.title && lower.startsWith(n.title.toLowerCase()))
        .sort((a, b) => b.title.length - a.title.length)[0];
      let title, item;
      if (note) { title = note.title; item = cmd.rest.slice(note.title.length).trim(); }
      else { [title, ...item] = cmd.rest.split(' '); item = item.join(' '); title = title[0].toUpperCase() + title.slice(1); }
      if (!item) return { ok: false, html: 'Кажи и какво да добавя в списъка, напр. „в списък Пазар мляко“.' };
      item = item[0].toUpperCase() + item.slice(1);
      return { ok: true, kind: 'list', note, title, item, html: `<b>Добави „${esc(item)}“</b> в ${note ? '' : 'нов '}списък „${esc(title)}“` };
    }
    case 'note':
      if (!cmd.text) return { ok: false, html: 'Кажи и текста на бележката.' };
      return { ok: true, kind: 'list', note: state.notes.find(n => n.title === 'Бързи бележки'), title: 'Бързи бележки', item: cmd.text, html: `<b>Запиши в „Бързи бележки“:</b> ${esc(cmd.text)}` };
    default:
      return { ok: false, html: 'Не разбрах командата. Виж примерите отдолу.' };
  }
}

function runPlan(p) {
  switch (p.kind) {
    case 'add': {
      const c = p.cmd;
      const rec = c.recurrence ? { ...c.recurrence } : { type: 'none' };
      if (rec.type === 'monthly' && !rec.dayOfMonth) rec.dayOfMonth = fromKey(todayKey()).getDate();
      const t = newTask({
        title: c.title, category: c.category, duration: c.duration || 30,
        priority: c.priority || 'normal', recurrence: rec, location: c.location || '',
        defaultTime: c.recurrence ? (c.start || '') : '', startDate: todayKey(),
      });
      if (p.when) addEntry(t, p.when, c.start);
      return c.recurrence ? 'Повтарящата се задача е добавена' : p.when ? `Добавена за ${relDay(p.when) || fmtShort(p.when)}` : 'Добавена в списъка със задачи';
    }
    case 'done':
      setDone(p.entry, true);
      return 'Браво! ✓';
    case 'move':
      p.entry.date = p.date;
      p.entry.start = p.start;
      return `Преместена за ${fmtShort(p.date)}`;
    case 'list': {
      const n = p.note || newNote({ title: p.title, type: 'checklist' });
      if (n.type === 'text') n.text = (n.text.trim() ? n.text.trimEnd() + '\n' : '') + p.item;
      else n.items.push({ id: uid(), text: p.item, done: false });
      touchNote(n);
      return `Добавено в „${n.title}“`;
    }
  }
}

function showVoiceResult(text) {
  const plan = planCommand(parseCommand(text, todayKey()));
  sheet.plan = plan;
  document.getElementById('voice-result').innerHTML = `
    <div class="card voice-plan ${plan.ok ? '' : 'bad'}">
      ${plan.html}
      ${plan.ok ? '<button class="btn primary full" style="margin-top:10px" data-action="voice-run">✓ Изпълни</button>' : ''}
    </div>`;
}

function setVoiceState(st, msg) {
  const btn = document.getElementById('mic-big');
  const status = document.getElementById('voice-status');
  if (!btn) return;
  btn.classList.toggle('on', st === 'listening');
  if (st === 'listening') status.textContent = 'Слушам...';
  else if (st === 'error') status.textContent = msg;
  else if (status.textContent === 'Слушам...') status.textContent = 'Докосни микрофона и кажи команда';
}

// ---------- Изглед: Преглед ----------

function viewReview() {
  return eveningReview() + weeklyReview() + settingsCard();
}

function eveningReview() {
  const t = todayKey();
  ensureDay(t);
  const today = dayEntries(t);
  const doneToday = today.filter(e => e.done);
  // Пропуснати еднократни задачи от минали дни също идват тук; повтарящите се не се трупат.
  const pending = sortEntries(state.entries.filter(e => {
    if (e.done) return false;
    if (e.date === t) return true;
    if (e.date > t || e.auto) return false;
    const tk = taskById(e.taskId);
    return tk && !tk.archived && !tk.done;
  }));
  const reviewed = state.lastEveningReview === t;
  const m = minutesByCat(doneToday);

  return `
    <h1>Преглед</h1>
    <div class="card">
      <h2>🌙 Вечерен преглед ${reviewed ? '<span class="tag plain">направен</span>' : ''}</h2>
      <div class="stat">
        <div><b>${doneToday.length}/${today.length}</b><span>задачи днес</span></div>
        <div><b>${fmtDur(m.work)}</b><span>работа</span></div>
        <div><b>${fmtDur(m.personal)}</b><span>лично</span></div>
      </div>
      ${pending.length ? `
        <h3>Какво остана (${pending.length})</h3>
        <p class="muted small">Реши за всяко: свърших го, утре, друг ден или отпада. Без чувство за вина.</p>
        <div class="stack">${pending.map(e => {
          const tk = taskOf(e);
          return `
            <div class="item review-item cat-${tk.category}">
              <div class="body"><div class="t">${esc(tk.title)}</div>
                <div class="s">${e.date !== t ? `<span class="tag plain">от ${fmtShort(e.date)}</span>` : ''}${e.start ? `<span>${e.start}</span>` : ''}<span>${fmtDur(e.duration)}</span></div></div>
              <div class="acts">
                <button class="btn small" data-action="toggle-done" data-id="${e.id}">✓ Свърших</button>
                <button class="btn small" data-action="rev-tomorrow" data-id="${e.id}">Утре</button>
                <button class="btn small" data-action="open-entry" data-id="${e.id}">Друг ден</button>
                <button class="btn small danger" data-action="entry-remove" data-id="${e.id}">Отпада</button>
              </div>
            </div>`;
        }).join('')}</div>`
        : `<p class="muted">Всичко за днес е отметнато. Браво!</p>`}
      <label for="day-note">Как мина денят? Едно нещо, с което се гордееш:</label>
      <textarea id="day-note" data-change="day-note">${esc(state.dayNotes[t] || '')}</textarea>
      <button class="btn primary full" style="margin-top:12px" data-action="evening-done">${reviewed ? 'Готово ✓' : 'Приключи деня'}</button>
    </div>`;
}

function weeklyReview() {
  const t = todayKey();
  const wk = weekStart(t), prev = addDays(wk, -7), prevEnd = addDays(wk, -1);
  const w = state.weekly[wk] || {};
  const goals = w.goals || ['', '', ''];
  const last = state.entries.filter(e => e.date >= prev && e.date <= prevEnd);
  const lastDone = last.filter(e => e.done);
  const m = minutesByCat(lastDone);

  const carry = state.entries.filter(e => {
    if (e.done || e.auto || e.date < prev || e.date > prevEnd) return false;
    const tk = taskById(e.taskId);
    return tk && !tk.archived && !tk.done;
  });
  const backlog = state.tasks.filter(tk => !tk.archived && !tk.done && !isRecurring(tk) && !upcomingEntry(tk)
    && !carry.some(e => e.taskId === tk.id));

  const dayOptions = () => {
    let o = '<option value="">Сложи в ден...</option>';
    for (let i = 0; i < 7; i++) {
      const k = addDays(wk, i);
      if (k < t) continue;
      const load = sum(dayEntries(k), e => e.duration);
      o += `<option value="${k}">${fmtShort(k)} (${fmtDur(load)})</option>`;
    }
    return o;
  };

  let loadRows = '';
  const cap = state.settings.capacityHours * 60;
  for (let i = 0; i < 7; i++) {
    const k = addDays(wk, i);
    ensureDay(k);
    const total = sum(dayEntries(k), e => e.duration);
    loadRows += `<button class="mini" data-action="open-day" data-date="${k}"><span class="tm">${DAY_SHORT[fromKey(k).getDay()]}</span>
      <span class="ttl"><span class="bar" style="display:flex"><i class="${total > cap ? '' : 'w'}" style="width:${Math.min(1, total / (cap || 1)) * 100}%;${total > cap ? 'background:var(--danger)' : ''}"></i></span></span>
      <span class="small muted">${fmtDur(total)}</span></button>`;
  }

  return `
    <div class="card">
      <h2>☀️ Седмичен преглед ${w.done ? '<span class="tag plain">направен</span>' : ''}</h2>
      <p class="muted small">Прави го в понеделник сутрин, за да планираш започващата седмица.</p>

      <h3>1. Миналата седмица</h3>
      <div class="stat">
        <div><b>${lastDone.length}/${last.length}</b><span>задачи</span></div>
        <div><b>${fmtDur(m.work)}</b><span>работа</span></div>
        <div><b>${fmtDur(m.personal)}</b><span>лично</span></div>
      </div>

      <h3>2. Недовършено от миналата седмица (${carry.length})</h3>
      ${carry.length ? `<div class="stack">${carry.map(e => `
        <div class="item review-item cat-${taskOf(e).category}">
          <div class="body"><div class="t">${esc(taskOf(e).title)}</div><div class="s"><span>${fmtShort(e.date)}</span><span>${fmtDur(e.duration)}</span></div></div>
          <div class="acts"><select data-change="carry-move" data-id="${e.id}">${dayOptions()}</select>
            <button class="btn small danger" data-action="carry-drop" data-id="${e.id}">Отпада</button></div>
        </div>`).join('')}</div>` : '<p class="muted small">Нищо не е останало.</p>'}

      <h3>3. Фокус: 3 важни неща тази седмица</h3>
      ${[0, 1, 2].map(i => `<input style="margin-bottom:6px" data-change="goal" data-i="${i}" placeholder="${i + 1}." value="${esc(goals[i] || '')}">`).join('')}

      <h3>4. Задачи без дата (${backlog.length})</h3>
      ${backlog.length ? `<div class="stack">${backlog.map(tk => `
        <div class="item review-item cat-${tk.category}">
          <div class="body"><div class="t">${esc(tk.title)}</div><div class="s"><span>${fmtDur(tk.duration)}</span>${tk.priority === 'high' ? '<span class="tag plain">!</span>' : ''}</div></div>
          <div class="acts"><select data-change="backlog-plan" data-id="${tk.id}">${dayOptions()}</select></div>
        </div>`).join('')}</div>` : '<p class="muted small">Всички задачи са планирани.</p>'}

      <h3>5. Натовареност по дни</h3>
      ${loadRows}

      <button class="btn primary full" style="margin-top:14px" data-action="weekly-done">${w.done ? 'Готово ✓' : 'Завърши седмичния преглед'}</button>
    </div>`;
}

function settingsCard() {
  const s = state.settings;
  const num = (key, label, min, max) =>
    `<label>${label}</label><input type="number" inputmode="numeric" min="${min}" max="${max}" data-change="setting" data-key="${key}" value="${s[key]}">`;
  return `
    <div class="card">
      <h2>⚙️ Настройки</h2>
      <div class="row"><div class="grow">${num('dayStart', 'Денят започва (час)', 0, 23)}</div><div class="grow">${num('dayEnd', 'Денят свършва (час)', 1, 24)}</div></div>
      ${num('capacityHours', 'Колко часа задачи реално мога да свърша на ден', 1, 18)}
      ${num('reviewHour', 'Напомняне за вечерен преглед след (час)', 12, 23)}
      <h3>Резервно копие</h3>
      <p class="muted small">Данните са само на това устройство. Сваляй копие от време на време.</p>
      <div class="row">
        <button class="btn grow" data-action="export">Свали копие</button>
        <button class="btn grow" data-action="import">Възстанови</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>`;
}

// ---------- Плъзгащи се панели (sheets) ----------

function openSheet(s) { stopListening(); sheet = s; renderSheet(); }

function closeSheet() {
  const was = sheet;
  sheet = null;
  stopListening();
  $sheet.innerHTML = '';
  if (was?.type === 'note') {
    // Празна бележка не се пази.
    const n = noteById(was.id);
    if (n && noteIsEmpty(n)) state.notes = state.notes.filter(x => x !== n);
    save();
    render();
  }
}

function renderSheet() {
  if (!sheet) return closeSheet();
  const body = { add: sheetAdd, entry: sheetEntry, task: sheetTask, schedule: sheetSchedule, note: sheetNote, voice: sheetVoice }[sheet.type]();
  // При повторно рисуване на същия панел пазим позицията на скрола и не анимираме.
  const old = $sheet.querySelector('.sheet');
  const same = old && $sheet.dataset.key === `${sheet.type}:${sheet.id || ''}`;
  const scroll = same ? old.scrollTop : 0;
  $sheet.dataset.key = `${sheet.type}:${sheet.id || ''}`;
  $sheet.innerHTML = `<div class="backdrop ${same ? 'still' : ''}" data-action="close-sheet"><div class="sheet" data-action="noop"><div class="grip"></div>${body}</div></div>`;
  $sheet.querySelector('.sheet').scrollTop = scroll;
  const auto = $sheet.querySelector('[autofocus]');
  if (auto && !same && !('ontouchstart' in window)) auto.focus();
}

const durationSelect = (name, value) =>
  `<select name="${name}">${DURATIONS.map(d => `<option value="${d}" ${d === value ? 'selected' : ''}>${fmtDur(d)}</option>`).join('')}</select>`;

const catRadios = value =>
  `<div class="seg">${Object.entries(CATS).map(([k, l]) => `<label><input type="radio" name="category" value="${k}" ${value === k ? 'checked' : ''}>${l}</label>`).join('')}</div>`;

function addPickList(q) {
  q = (q || '').trim().toLowerCase();
  const order = tk => isRecurring(tk) ? 2 : (upcomingEntry(tk) ? 1 : 0);
  const list = state.tasks
    .filter(tk => !tk.archived && !tk.done && (!q || tk.title.toLowerCase().includes(q)))
    .sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title, 'bg'));
  if (!list.length) return `<div class="muted small">${q ? 'Няма съвпадения. Създай я отдолу.' : 'Списъкът със задачи е празен.'}</div>`;
  return list.map(tk => {
    const up = !isRecurring(tk) && upcomingEntry(tk);
    return `<button class="item cat-${tk.category}" data-action="add-pick" data-id="${tk.id}">
      <div class="body"><div class="t">${esc(tk.title)}</div>
      <div class="s"><span class="tag">${CATS[tk.category]}</span><span>${fmtDur(tk.duration)}</span>
      ${isRecurring(tk) ? '<span>↻</span>' : ''}${up ? `<span>вече в ${fmtShort(up.date)}</span>` : ''}</div></div>
      <span style="font-size:22px;color:var(--accent)">+</span></button>`;
  }).join('');
}

function sheetAdd() {
  const { date, start } = sheet;
  return `
    <h2>Добави в ${relDay(date) ? relDay(date).toLowerCase() : fmtShort(date)}</h2>
    <label>Час (по избор)</label>
    <input type="time" id="add-time" value="${start || ''}" step="900">
    <label>От списъка със задачи</label>
    <input type="search" id="add-search" placeholder="Търси...">
    <div class="pick-list" id="add-list">${addPickList('')}</div>
    <details ${state.tasks.length ? '' : 'open'}>
      <summary>+ Нова задача</summary>
      <form id="quick-form">
        <label>Заглавие</label>
        <input name="title" required autocomplete="off">
        <label>Категория</label>
        ${catRadios('work')}
        <div class="row">
          <div class="grow"><label>Продължителност</label>${durationSelect('duration', 30)}</div>
          <div class="grow"><label>Място (по избор)</label><input name="location" list="loc-list" autocomplete="off"></div>
        </div>
        ${locationDatalist()}
        <button class="btn primary full" style="margin-top:12px" type="submit">Добави</button>
      </form>
    </details>`;
}

function sheetEntry() {
  const e = entryById(sheet.id);
  if (!e) return '<p>Задачата не е намерена.</p>';
  const t = taskOf(e);
  return `
    <h2>${esc(t.title)}</h2>
    <div class="row wrap" style="margin-bottom:8px">
      <span class="tag cat-${t.category}">${CATS[t.category]}</span>
      ${isRecurring(t) ? `<span class="tag plain">↻ ${recurLabel(t.recurrence)}</span>` : ''}
      <span class="muted small">${fmtDate(e.date)}</span>
    </div>
    ${t.location ? `<a class="btn small full" style="margin-bottom:8px" href="${mapsUrl(t.location)}" target="_blank" rel="noopener">📍 ${esc(t.location)} · Отвори в Карти</a>` : ''}
    ${t.notes ? `<p class="muted small" style="white-space:pre-wrap">${esc(t.notes)}</p>` : ''}
    <button class="btn ${e.done ? '' : 'primary'} full" data-action="toggle-done" data-id="${e.id}">${e.done ? 'Отбележи като несвършена' : '✓ Свърших'}</button>
    <form id="entry-form">
      <div class="row">
        <div class="grow"><label>Час</label><input type="time" name="start" value="${e.start || ''}" step="900"></div>
        <div class="grow"><label>Продължителност</label>${durationSelect('duration', e.duration)}</div>
      </div>
      <div class="row" style="margin-top:8px">
        <button type="button" class="btn small grow" data-action="entry-nudge" data-n="-15">−15 мин</button>
        <button type="button" class="btn small grow" data-action="entry-nudge" data-n="15">+15 мин</button>
        <button type="button" class="btn small grow" data-action="entry-notime">Без час</button>
      </div>
      <button class="btn primary full" style="margin-top:12px" type="submit">Запази</button>
    </form>
    <h3>Премести</h3>
    <div class="row">
      <button class="btn small grow" data-action="entry-shift" data-n="1">Утре</button>
      <button class="btn small grow" data-action="entry-shift" data-n="7">След седмица</button>
    </div>
    <div class="row" style="margin-top:8px">
      <input type="date" id="move-date" class="grow" value="${e.date}">
      <button class="btn small" data-action="entry-move">Премести</button>
    </div>
    <div class="actions">
      <button class="btn" data-action="edit-task" data-id="${e.taskId}">Редактирай задачата</button>
      <button class="btn danger" data-action="entry-remove" data-id="${e.id}">Махни от деня</button>
    </div>`;
}

function sheetTask() {
  const t = sheet.id ? taskById(sheet.id) : null;
  const v = t || { title: '', category: 'work', duration: 30, priority: 'normal', recurrence: { type: 'none', days: [], dayOfMonth: 1 }, defaultTime: '', notes: '', location: '' };
  const r = v.recurrence || { type: 'none' };
  const rtypes = { none: 'Еднократна', daily: 'Всеки ден', weekdays: 'Делнични дни (Пн–Пт)', weekly: 'В определени дни от седмицата', monthly: 'Веднъж месечно' };
  return `
    <h2>${t ? 'Редактирай задача' : 'Нова задача'}</h2>
    <form id="task-form">
      <label>Заглавие</label>
      <input name="title" required autocomplete="off" value="${esc(v.title)}" ${t ? '' : 'autofocus'}>
      <label>Категория</label>
      ${catRadios(v.category)}
      <div class="row">
        <div class="grow"><label>Продължителност</label>${durationSelect('duration', v.duration)}</div>
        <div class="grow"><label>Приоритет</label><select name="priority">${Object.entries(PRIORITIES).map(([k, l]) => `<option value="${k}" ${v.priority === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <label>Място (по избор)</label>
      <div class="row">
        <input name="location" class="grow" list="loc-list" autocomplete="off" placeholder="напр. Офис, Фитнес, ул. Витоша 15" value="${esc(v.location || '')}">
        ${v.location ? `<a class="btn small" href="${mapsUrl(v.location)}" target="_blank" rel="noopener">Карти</a>` : ''}
      </div>
      ${locationDatalist()}
      <label>Повторение</label>
      <select name="rtype" data-change="rtype">${Object.entries(rtypes).map(([k, l]) => `<option value="${k}" ${r.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div id="r-weekly" ${r.type === 'weekly' ? '' : 'hidden'}>
        <label>В кои дни</label>
        <div class="days">${MON_FIRST.map(d => `<label><input type="checkbox" name="rdays" value="${d}" ${(r.days || []).includes(d) ? 'checked' : ''}>${DAY_SHORT[d]}</label>`).join('')}</div>
      </div>
      <div id="r-monthly" ${r.type === 'monthly' ? '' : 'hidden'}>
        <label>На кое число</label>
        <input type="number" name="rdom" min="1" max="31" value="${r.dayOfMonth || 1}">
      </div>
      <div id="r-time" ${r.type === 'none' ? 'hidden' : ''}>
        <label>Обичаен час (по избор, слага я директно в графика)</label>
        <input type="time" name="defaultTime" value="${v.defaultTime || ''}" step="900">
      </div>
      <label>Бележки</label>
      <textarea name="notes">${esc(v.notes || '')}</textarea>
      <div class="actions">
        ${t ? `<button type="button" class="btn danger" data-action="delete-task" data-id="${t.id}">Изтрий</button>` : ''}
        <button type="submit" class="btn primary">Запази</button>
      </div>
    </form>`;
}

function sheetSchedule() {
  const t = taskById(sheet.id);
  const tk = todayKey();
  return `
    <h2>Планирай: ${esc(t.title)}</h2>
    <form id="schedule-form">
      <label>Ден</label>
      <div class="seg" style="margin-bottom:8px">
        <button type="button" data-action="sched-day" data-date="${tk}">Днес</button>
        <button type="button" data-action="sched-day" data-date="${addDays(tk, 1)}">Утре</button>
        <button type="button" data-action="sched-day" data-date="${addDays(weekStart(tk), 7)}">Следв. Пн</button>
      </div>
      <input type="date" name="date" value="${sheet.date || tk}" required>
      <label>Час (по избор)</label>
      <input type="time" name="start" value="${t.defaultTime || ''}" step="900">
      <button class="btn primary full" style="margin-top:14px" type="submit">Сложи в графика</button>
    </form>`;
}

function sheetNote() {
  const n = noteById(sheet.id);
  if (!n) return '<p>Бележката не е намерена.</p>';
  const open = n.items.filter(i => !i.done), done = n.items.filter(i => i.done);
  const row = i => `
    <div class="ci ${i.done ? 'done' : ''}">
      <button class="check ${i.done ? 'on' : ''}" data-action="note-item-toggle" data-note="${n.id}" data-item="${i.id}">${i.done ? '✓' : ''}</button>
      <input class="ci-text" data-item="${i.id}" value="${esc(i.text)}">
      <button class="iconbtn x" data-action="note-item-del" data-item="${i.id}" aria-label="Изтрий">×</button>
    </div>`;
  return `
    <input class="note-title" data-note-field="title" placeholder="Заглавие" value="${esc(n.title)}" autocomplete="off" ${n.title ? '' : 'autofocus'}>
    <div class="seg" style="margin:10px 0">
      <button class="${n.type === 'checklist' ? 'on' : ''}" data-action="note-type" data-type="checklist">☑ Списък с отметки</button>
      <button class="${n.type === 'text' ? 'on' : ''}" data-action="note-type" data-type="text">¶ Текст</button>
    </div>
    ${n.type === 'text' ? `
      <textarea class="note-body" data-note-field="text" rows="12" placeholder="Пиши тук...">${esc(n.text)}</textarea>
      <button class="btn small full" style="margin-top:8px" data-action="note-dictate">🎤 Диктувай текст</button>
    ` : `
      ${n.items.length ? `<div class="muted small" style="margin-bottom:6px">${done.length}/${n.items.length} отметнати</div>` : ''}
      <div class="checklist">${open.map(row).join('')}</div>
      <form id="item-form" class="row" style="margin-top:8px">
        <input id="new-item" class="grow" placeholder="Нова точка..." autocomplete="off" enterkeyhint="enter">
        <button class="btn" type="submit" aria-label="Добави">+</button>
        <button class="btn" type="button" data-action="note-dictate" aria-label="Диктувай">🎤</button>
      </form>
      ${done.length ? `
        <h3>Отметнати (${done.length})</h3>
        <div class="checklist">${done.map(row).join('')}</div>
        <button class="btn small full" style="margin-top:8px" data-action="note-clear-done">Изчисти отметнатите</button>` : ''}
    `}
    <div class="actions">
      <button class="btn" data-action="note-pin">${n.pinned ? '☆ Не е важна' : '⭐ Важна'}</button>
      <button class="btn danger" data-action="note-delete">Изтрий</button>
    </div>`;
}

// ---------- Действия ----------

function nav(tab) { ui.tab = tab; closeSheet(); render(); window.scrollTo({ top: 0 }); }

const actions = {
  'noop': () => {},
  'tab': el => {
    // Повторно докосване на „Ден“ връща към днес.
    if (el.dataset.tab === 'day') {
      if (ui.tab === 'day') ui.date = todayKey();
      ui.scrolledFor = null;
    }
    nav(el.dataset.tab);
  },
  'close-sheet': () => closeSheet(),
  'go-review': () => nav('review'),
  'go-today': () => { ui.date = todayKey(); render(); },
  'day-shift': el => { ui.date = addDays(ui.date, Number(el.dataset.n)); render(); },
  'week-shift': el => { ui.weekOf = addDays(ui.weekOf, Number(el.dataset.n)); render(); },
  'week-today': () => { ui.weekOf = weekStart(todayKey()); render(); },
  'month-shift': el => {
    const [y, m] = ui.month.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(el.dataset.n), 1);
    ui.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    render();
  },
  'open-day': el => { ui.date = el.dataset.date; ui.scrolledFor = null; nav('day'); },
  'add': el => openSheet({ type: 'add', date: el.dataset.date, start: null }),
  'tl-tap': (el, ev) => {
    const rect = el.getBoundingClientRect();
    const min = Number(el.dataset.first) * 60 + (ev.clientY - rect.top) / PX_PER_MIN;
    const snapped = Math.max(0, Math.min(23 * 60 + 45, Math.floor(min / 15) * 15));
    openSheet({ type: 'add', date: el.dataset.date, start: fromMin(snapped) });
  },
  'add-pick': el => {
    const t = taskById(el.dataset.id);
    const time = document.getElementById('add-time')?.value || null;
    addEntry(t, sheet.date, time);
    save(); closeSheet(); render();
    toast(`„${t.title}“ е добавена`);
  },
  'open-entry': el => openSheet({ type: 'entry', id: el.dataset.id }),
  'toggle-done': el => {
    const e = entryById(el.dataset.id);
    if (!e) return;
    setDone(e, !e.done);
    save(); render();
    if (sheet?.type === 'entry') closeSheet();
    if (e.done) toast('Браво! ✓');
  },
  'entry-nudge': el => {
    const input = document.querySelector('#entry-form [name=start]');
    const cur = input.value ? toMin(input.value) : 9 * 60;
    input.value = fromMin(Math.max(0, Math.min(23 * 60 + 45, cur + Number(el.dataset.n))));
  },
  'entry-notime': () => { document.querySelector('#entry-form [name=start]').value = ''; },
  'entry-shift': el => {
    const e = entryById(sheet.id);
    e.date = addDays(e.date, Number(el.dataset.n));
    save(); closeSheet(); render();
    toast(`Преместена за ${fmtShort(e.date)}`);
  },
  'entry-move': () => {
    const v = document.getElementById('move-date').value;
    if (!v) return;
    const e = entryById(sheet.id);
    e.date = v;
    save(); closeSheet(); render();
    toast(`Преместена за ${fmtShort(v)}`);
  },
  'entry-remove': el => {
    const e = entryById(el.dataset.id);
    if (!e) return;
    removeEntry(e);
    save(); closeSheet(); render();
    toast('Махната от графика');
  },
  'rev-tomorrow': el => {
    const e = entryById(el.dataset.id);
    e.date = addDays(todayKey(), 1);
    save(); render();
    toast('Преместена за утре');
  },
  'evening-done': () => {
    const note = document.getElementById('day-note');
    if (note) state.dayNotes[todayKey()] = note.value;
    state.lastEveningReview = todayKey();
    save(); render();
    toast('Денят е приключен. Почивай си! 🌙');
  },
  'carry-drop': el => {
    const e = entryById(el.dataset.id);
    const t = taskById(e.taskId);
    if (t && !isRecurring(t) && confirm(`Да отпадне ли „${t.title}“ изцяло?`)) t.archived = true;
    removeEntry(e);
    save(); render();
  },
  'weekly-done': () => {
    const wk = weekStart(todayKey());
    state.weekly[wk] = { ...(state.weekly[wk] || {}), done: true };
    save(); render();
    toast('Седмицата е планирана! ☀️');
  },
  'new-task': () => openSheet({ type: 'task', id: null }),
  'new-note': () => { const n = newNote({}); openSheet({ type: 'note', id: n.id }); },
  'open-note': el => openSheet({ type: 'note', id: el.dataset.id }),
  'note-item-toggle': el => {
    const n = noteById(el.dataset.note);
    const i = n?.items.find(x => x.id === el.dataset.item);
    if (!i) return;
    i.done = !i.done;
    touchNote(n); save();
    if (sheet?.type === 'note') renderSheet(); else render();
  },
  'note-item-del': el => {
    const n = noteById(sheet.id);
    n.items = n.items.filter(x => x.id !== el.dataset.item);
    touchNote(n); save(); renderSheet();
  },
  'note-clear-done': () => {
    const n = noteById(sheet.id);
    n.items = n.items.filter(x => !x.done);
    touchNote(n); save(); renderSheet();
  },
  'note-type': el => {
    const n = noteById(sheet.id);
    const type = el.dataset.type;
    if (type === n.type) return;
    // При смяна на вида запазваме съдържанието: редовете стават точки и обратно.
    if (type === 'checklist' && !n.items.length && n.text.trim()) {
      n.items = n.text.split('\n').map(x => x.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean).map(text => ({ id: uid(), text, done: false }));
    } else if (type === 'text' && !n.text.trim() && n.items.length) {
      n.text = n.items.map(i => (i.done ? '✓ ' : '') + i.text).join('\n');
    }
    n.type = type;
    touchNote(n); save(); renderSheet();
  },
  'note-pin': () => {
    const n = noteById(sheet.id);
    n.pinned = !n.pinned;
    touchNote(n); save(); renderSheet();
  },
  'note-delete': () => {
    const n = noteById(sheet.id);
    if (!noteIsEmpty(n) && !confirm(`Да изтрия ли бележката „${n.title || 'Без заглавие'}“?`)) return;
    state.notes = state.notes.filter(x => x !== n);
    save(); closeSheet(); render();
  },
  'note-dictate': el => {
    const n = noteById(sheet.id);
    const ok = listen({
      onState: (st, msg) => {
        el.classList.toggle('listening', st === 'listening');
        if (st === 'error') toast(msg);
      },
      onFinal: text => {
        text = text.trim();
        if (!text) return;
        text = text[0].toUpperCase() + text.slice(1);
        if (n.type === 'text') n.text = (n.text.trim() ? n.text.trimEnd() + '\n' : '') + text;
        else n.items.push({ id: uid(), text, done: false });
        touchNote(n); save(); renderSheet();
      },
    });
    if (!ok) toast('Използвай микрофона на клавиатурата');
  },
  'voice': () => openSheet({ type: 'voice' }),
  'voice-listen': () => {
    const box = document.getElementById('voice-text');
    const ok = listen({
      onText: text => { box.value = text; },
      onFinal: text => showVoiceResult(text),
      onState: setVoiceState,
    });
    if (!ok) box.focus();
  },
  'voice-cat': el => {
    if (sheet?.plan?.kind !== 'add') return;
    sheet.plan.cmd.category = el.dataset.cat;
    el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
  },
  'voice-run': () => {
    const msg = runPlan(sheet.plan);
    save(); closeSheet(); render();
    toast(msg);
  },
  'edit-task': el => openSheet({ type: 'task', id: el.dataset.id }),
  'delete-task': el => {
    const t = taskById(el.dataset.id);
    if (!confirm(`Да изтрия ли „${t.title}“? Бъдещите ѝ места в графика също ще изчезнат.`)) return;
    t.archived = true;
    const tk = todayKey();
    state.entries = state.entries.filter(e => !(e.taskId === t.id && e.date >= tk && !e.done));
    save(); closeSheet(); render();
  },
  'schedule': el => openSheet({ type: 'schedule', id: el.dataset.id }),
  'sched-day': el => { document.querySelector('#schedule-form [name=date]').value = el.dataset.date; },
  'lib-cat': el => { ui.libCat = el.dataset.cat; render(); },
  'toggle-show-done': () => { ui.showDone = !ui.showDone; render(); },
  'export': () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grafik-kopie-${todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  },
  'import': () => document.getElementById('import-file').click(),
};

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    ev.stopPropagation();
    fn(el, ev);
  }
});

// Промени в полета (select, input, textarea)
document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.id === 'import-file') return importFile(el.files[0]);
  if (el.classList.contains('ci-text') && !el.value.trim() && sheet?.type === 'note') {
    // Изтрит текст на точка = изтрита точка.
    const n = noteById(sheet.id);
    n.items = n.items.filter(x => x.id !== el.dataset.item);
    save(); return renderSheet();
  }
  const kind = el.dataset.change;
  if (!kind) return;
  const wk = weekStart(todayKey());
  switch (kind) {
    case 'rtype': {
      document.getElementById('r-weekly').hidden = el.value !== 'weekly';
      document.getElementById('r-monthly').hidden = el.value !== 'monthly';
      document.getElementById('r-time').hidden = el.value === 'none';
      return;
    }
    case 'day-note':
      state.dayNotes[todayKey()] = el.value;
      return save();
    case 'goal': {
      const w = state.weekly[wk] = state.weekly[wk] || {};
      w.goals = w.goals || ['', '', ''];
      w.goals[Number(el.dataset.i)] = el.value.trim();
      return save();
    }
    case 'carry-move': {
      if (!el.value) return;
      entryById(el.dataset.id).date = el.value;
      save(); render();
      return toast(`Преместена за ${fmtShort(el.value)}`);
    }
    case 'backlog-plan': {
      if (!el.value) return;
      const t = taskById(el.dataset.id);
      addEntry(t, el.value, null);
      save(); render();
      return toast(`Планирана за ${fmtShort(el.value)}`);
    }
    case 'setting': {
      const v = Number(el.value);
      if (!Number.isFinite(v)) return;
      state.settings[el.dataset.key] = v;
      if (state.settings.dayEnd <= state.settings.dayStart) state.settings.dayEnd = Math.min(24, state.settings.dayStart + 1);
      return save();
    }
  }
});

document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset.noteField && sheet?.type === 'note') {
    const n = noteById(sheet.id);
    n[el.dataset.noteField] = el.value;
    touchNote(n); save();
    return;
  }
  if (el.classList.contains('ci-text') && sheet?.type === 'note') {
    const n = noteById(sheet.id);
    const i = n.items.find(x => x.id === el.dataset.item);
    if (i) { i.text = el.value; touchNote(n); save(); }
    return;
  }
  if (ev.target.id === 'add-search') {
    document.getElementById('add-list').innerHTML = addPickList(ev.target.value);
  } else if (ev.target.id === 'lib-search') {
    ui.libSearch = ev.target.value;
    const pos = ev.target.selectionStart;
    render();
    const input = document.getElementById('lib-search');
    input.focus();
    input.setSelectionRange(pos, pos);
  }
});

document.addEventListener('submit', ev => {
  ev.preventDefault();
  const form = ev.target;
  const f = new FormData(form);
  if (form.id === 'quick-form') {
    const title = String(f.get('title')).trim();
    if (!title) return;
    const t = newTask({ title, category: f.get('category') || 'work', duration: Number(f.get('duration')), location: String(f.get('location') || '').trim() });
    addEntry(t, sheet.date, document.getElementById('add-time').value || null);
    save(); closeSheet(); render();
    toast(`„${title}“ е добавена`);
  } else if (form.id === 'voice-form') {
    const text = document.getElementById('voice-text').value;
    if (text.trim()) showVoiceResult(text);
  } else if (form.id === 'item-form') {
    const input = document.getElementById('new-item');
    const text = input.value.trim();
    if (!text) return;
    const n = noteById(sheet.id);
    n.items.push({ id: uid(), text, done: false });
    touchNote(n); save(); renderSheet();
    document.getElementById('new-item').focus();
  } else if (form.id === 'entry-form') {
    const e = entryById(sheet.id);
    e.start = f.get('start') || null;
    e.duration = Number(f.get('duration'));
    save(); closeSheet(); render();
  } else if (form.id === 'task-form') {
    saveTaskForm(f);
  } else if (form.id === 'schedule-form') {
    const t = taskById(sheet.id);
    const date = f.get('date');
    addEntry(t, date, f.get('start') || null);
    save(); closeSheet(); render();
    toast(`Планирана за ${fmtShort(date)}`);
  }
});

function newTask(fields) {
  const t = {
    id: uid(), title: '', category: 'work', duration: 30, priority: 'normal',
    recurrence: { type: 'none' }, defaultTime: '', notes: '', location: '', done: false, archived: false,
    createdAt: todayKey(), ...fields,
  };
  state.tasks.push(t);
  return t;
}

function saveTaskForm(f) {
  const title = String(f.get('title')).trim();
  if (!title) return;
  const rtype = f.get('rtype');
  const recurrence = { type: rtype };
  if (rtype === 'weekly') {
    recurrence.days = f.getAll('rdays').map(Number);
    if (!recurrence.days.length) return toast('Избери поне един ден от седмицата');
  }
  if (rtype === 'monthly') recurrence.dayOfMonth = Math.max(1, Math.min(31, Number(f.get('rdom')) || 1));
  const fields = {
    title,
    category: f.get('category') || 'work',
    duration: Number(f.get('duration')),
    priority: f.get('priority'),
    recurrence,
    defaultTime: rtype === 'none' ? '' : (f.get('defaultTime') || ''),
    notes: String(f.get('notes') || ''),
    location: String(f.get('location') || '').trim(),
  };
  const existing = sheet.id ? taskById(sheet.id) : null;
  if (existing) {
    const scheduleChanged = JSON.stringify(existing.recurrence) !== JSON.stringify(recurrence)
      || existing.defaultTime !== fields.defaultTime || existing.duration !== fields.duration;
    Object.assign(existing, fields);
    if (scheduleChanged) {
      // Пресъздай бъдещите повторения по новите правила.
      const tk = todayKey();
      state.entries = state.entries.filter(e => !(e.taskId === existing.id && e.auto && !e.done && e.origin >= tk));
      for (const key of Object.keys(state.skips)) {
        if (key.startsWith(existing.id + '|') && key.split('|')[1] >= tk) delete state.skips[key];
      }
    }
    toast('Запазено');
  } else {
    newTask({ ...fields, startDate: todayKey() });
    toast(isRecurring(fields) ? 'Повтарящата се задача ще влиза в графика сама' : 'Задачата е добавена в списъка');
  }
  save(); closeSheet(); render();
}

async function importFile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.tasks) || !Array.isArray(data.entries)) throw new Error('bad');
    if (!confirm('Това ще замени всички текущи данни с тези от копието. Продължаваш ли?')) return;
    const d = defaultState();
    state = { ...d, ...data, settings: { ...d.settings, ...data.settings } };
    save(); render();
    toast('Данните са възстановени');
  } catch {
    toast('Файлът не е валидно копие');
  }
}

// ---------- Старт ----------

render();

// Обновявай линията „сега“ и напомнянията, когато приложението се отвори отново.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !sheet) render();
});
setInterval(() => { if (!sheet && ui.tab === 'day' && document.visibilityState === 'visible') render(); }, 60_000);

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
