// Разбиране на гласови (или написани) команди на български.
// parseCommand връща структура; самото изпълнение е в app.js.

const L = '(?<![\\p{L}\\d])';
const R = '(?![\\p{L}\\d])';
const rx = (src, flags = 'iu') => new RegExp(`${L}(?:${src})${R}`, flags);

const DAYS = {
  'понеделник': 1, 'вторник': 2, 'сряда': 3, 'четвъртък': 4, 'петък': 5, 'събота': 6, 'неделя': 0,
};
const DAY_RX = Object.keys(DAYS).join('|');
const MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];

const NUMBERS = {
  'един': 1, 'една': 1, 'едно': 1, 'два': 2, 'две': 2, 'три': 3, 'четири': 4, 'пет': 5, 'шест': 6,
  'седем': 7, 'осем': 8, 'девет': 9, 'десет': 10, 'единайсет': 11, 'единадесет': 11,
  'дванайсет': 12, 'дванадесет': 12, 'тринайсет': 13, 'тринадесет': 13, 'четиринайсет': 14,
  'четиринадесет': 14, 'петнайсет': 15, 'петнадесет': 15, 'шестнайсет': 16, 'шестнадесет': 16,
  'седемнайсет': 17, 'седемнадесет': 17, 'осемнайсет': 18, 'осемнадесет': 18,
  'деветнайсет': 19, 'деветнадесет': 19, 'двайсет': 20, 'двадесет': 20, 'трийсет': 30,
  'тридесет': 30, 'четирийсет': 40, 'четиридесет': 40, 'петдесет': 50,
  'първи': 1, 'втори': 2, 'трети': 3, 'четвърти': 4, 'пети': 5, 'шести': 6, 'седми': 7,
  'осми': 8, 'девети': 9, 'десети': 10,
};

const pad = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); };

function wordsToDigits(s) {
  s = s.replace(rx(Object.keys(NUMBERS).sort((a, b) => b.length - a.length).join('|'), 'giu'),
    w => String(NUMBERS[w.toLowerCase()]));
  // „двайсет и едно“ → 21, „четирийсет и пет“ → 45
  return s.replace(/(?<!\d)(20|30|40|50) и ([1-9])(?!\d)/g, (m, a, b) =>
    (a === '20' && Number(b) > 3) ? m : String(Number(a) + Number(b)));
}

// Изважда първото съвпадение от текста и връща го (или null).
function take(state, re) {
  const m = state.s.match(re);
  if (!m) return null;
  state.s = (state.s.slice(0, m.index) + ' ' + state.s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return m;
}

function nextDow(today, dow, allowToday) {
  const d0 = fromKey(today).getDay();
  let diff = (dow - d0 + 7) % 7;
  if (diff === 0 && !allowToday) diff = 7;
  return addDays(today, diff);
}

function extractRecurrence(st) {
  if (take(st, rx('всеки делничен ден|всеки делник|всеки работен ден|в делнични(?:те)? дни|през делничните дни|от понеделник до петък'))) {
    return { type: 'weekdays' };
  }
  if (take(st, rx('всеки ден|всяка сутрин|всяка вечер|ежедневно|всеки следобед'))) return { type: 'daily' };
  let m = take(st, rx('всеки месец(?: на (\\d{1,2})(?:-?(?:ви|ри|ти|ми|и))?)?|ежемесечно(?: на (\\d{1,2})(?:-?(?:ви|ри|ти|ми|и))?)?'));
  if (m) return { type: 'monthly', dayOfMonth: Number(m[1] || m[2]) || null };
  const dayList = `(?:всеки |всяка )?(?:${DAY_RX})`;
  m = take(st, rx(`(?:всеки|всяка) (?:${DAY_RX})(?:(?:\\s*,\\s*|\\s+и\\s+)${dayList})*`));
  if (m) {
    const days = [...m[0].toLowerCase().matchAll(new RegExp(DAY_RX, 'g'))].map(x => DAYS[x[0]]);
    return { type: 'weekly', days: [...new Set(days)] };
  }
  return null;
}

function extractDate(st, today) {
  if (take(st, rx('вдругиден'))) return addDays(today, 2);
  if (take(st, rx('утре'))) return addDays(today, 1);
  if (take(st, rx('днес|тази вечер|довечера|тази сутрин'))) return today;
  if (take(st, rx('следващата седмица|другата седмица'))) return nextDow(today, 1, false);
  let m = take(st, rx(`(?:(?:в|във|на|този|тази|следващия|следващата|другия|другата) )?(${DAY_RX})`));
  if (m) {
    const word = m[0].toLowerCase();
    let k = nextDow(today, DAYS[m[1].toLowerCase()], /^(този|тази)/.test(word));
    // „следващия петък“ = петъкът от следващата седмица, ако този още предстои
    const sunday = addDays(today, 6 - (fromKey(today).getDay() + 6) % 7);
    if (/^(следващ|друг)/.test(word) && k <= sunday) k = addDays(k, 7);
    return k;
  }
  m = take(st, rx(`(?:на )?(\\d{1,2})(?:-?(?:ви|ри|ти|ми|и))?(?: (${MONTHS.join('|')}))`));
  if (!m) m = take(st, rx('на (\\d{1,2})(?:-?(?:ви|ри|ти|ми|и))'));
  if (!m) m = take(st, rx('на (\\d{1,2})\\.(\\d{1,2})\\.?'));
  if (m) {
    const t = fromKey(today);
    const day = Number(m[1]);
    let month = t.getMonth();
    if (m[2]) month = isNaN(Number(m[2])) ? MONTHS.indexOf(m[2].toLowerCase()) : Number(m[2]) - 1;
    let d = new Date(t.getFullYear(), month, day);
    if (toKey(d) < today) d = m[2] ? new Date(t.getFullYear() + 1, month, day) : new Date(t.getFullYear(), month + 1, day);
    if (day >= 1 && day <= 31) return toKey(d);
  }
  return null;
}

function extractTime(st) {
  const m = take(st, rx(
    '(?:в|във|към|около|от) (\\d{1,2})(?:[:.](\\d{2})| и (половина|четвърт|\\d{1,2})(?: минути)?| без (четвърт|\\d{1,2}))?(?: часа?)?' +
    '(?: (сутринта|сутрин|следобед|следобяд|вечерта|вечер|на обяд|през нощта))?'));
  if (!m) {
    const n = take(st, rx('на обяд|по обяд'));
    return n ? '12:00' : null;
  }
  let h = Number(m[1]);
  let min = 0;
  if (m[2]) min = Number(m[2]);
  else if (m[3]) min = m[3] === 'половина' ? 30 : m[3] === 'четвърт' ? 15 : Number(m[3]);
  if (m[4]) { h -= 1; min = 60 - (m[4] === 'четвърт' ? 15 : Number(m[4])); }
  const part = (m[5] || '').toLowerCase();
  if (/следоб|вечер/.test(part) && h < 12) h += 12;
  else if (!part && h >= 1 && h <= 5) h += 12; // „в 3“ най-често е следобед
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function extractDuration(st) {
  let m = take(st, rx('за (\\d+) ?(?:минути|минута|мин)'));
  if (m) return Number(m[1]);
  if (take(st, rx('за половин час'))) return 30;
  m = take(st, rx('за (\\d+ )?час(?:а|ове)?( и половина)?'));
  if (m) return (Number(m[1]) || 1) * 60 + (m[2] ? 30 : 0);
  return null;
}

function extractCategory(st) {
  if (take(st, rx('(?:работна|служебна) задача|за работа$|по работа$|работна$|работа$|служебно$'))) return 'work';
  if (take(st, rx('лична задача|лично$|лична$|за мен$'))) return 'personal';
  return null;
}

function extractLocation(st) {
  let m = take(st, rx('(?:локация|място|адрес)[: ]+(.+)$'));
  if (!m) m = take(st, rx('(?:в|във|при|на адрес) ((?![\\d])[\\p{L}].*)$'));
  return m ? m[1].trim() : null;
}

function cleanTitle(s) {
  s = s.replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '');
  s = s.replace(new RegExp(`^(?:задача(?:та)?|да)${R}\\s*`, 'iu'), '');
  s = s.replace(new RegExp(`\\s+(?:в|във|на|за|и|от|към)$`, 'iu'), '');
  s = s.trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

// Разбира подробностите на задача: дата, час, продължителност, повторение, място.
export function parseTaskDetails(text, today) {
  const st = { s: wordsToDigits(text) };
  const priority = take(st, rx('спешно|важно|с висок приоритет|приоритетно')) ? 'high' : null;
  const recurrence = extractRecurrence(st);
  const date = recurrence ? null : extractDate(st, today);
  const start = extractTime(st);
  const duration = extractDuration(st);
  const category = extractCategory(st);
  const location = extractLocation(st);
  return { title: cleanTitle(st.s), date, start, duration, category, location, recurrence, priority };
}

export function parseCommand(raw, today) {
  const text = raw.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  if (!text) return { kind: 'empty' };
  let m;

  if ((m = text.match(new RegExp(`^(?:свърших|приключих|направих|изпълних|отметни|готово|готова|готов)${R}[\\s,:]*(.*)$`, 'iu')))) {
    return { kind: 'done', query: m[1].replace(/^(?:с|със)\s+/iu, '').trim() };
  }
  if ((m = text.match(new RegExp(`^(?:премести|отложи|измести|прехвърли)${R}\\s*(.*)$`, 'iu')))) {
    const d = parseTaskDetails(m[1].replace(new RegExp(`${L}за${R}\\s+(?=утре|вдругиден|днес|понеделник|вторник|сряда|четвъртък|петък|събота|неделя|следващ)`, 'iu'), ''), today);
    return { kind: 'move', query: d.title, date: d.date, start: d.start };
  }
  if ((m = text.match(new RegExp(`^(?:добави|запиши|сложи)?\\s*(?:в|към) (?:списък(?:а)?|бележка(?:та)?|бележките)${R}\\s*(.*)$`, 'iu')))) {
    return { kind: 'list', rest: m[1].trim() };
  }
  if ((m = text.match(new RegExp(`^(?:нова бележка|бележка|запиши бележка|запомни)${R}[\\s,:]*(.*)$`, 'iu')))) {
    return { kind: 'note', text: cleanTitle(m[1]) };
  }
  m = text.match(new RegExp(`^(?:добави|запиши|създай|сложи|планирай|нова задача|напомни ми(?: да)?)${R}[\\s,:]*(.*)$`, 'iu'));
  const details = parseTaskDetails(m ? m[1] : text, today);
  if (!details.title) return { kind: 'unknown' };
  return { kind: 'add', ...details };
}

// Колко добре заявката съвпада със заглавие (0..1), толерантно към окончания.
export function matchScore(query, title) {
  const stem = w => w.slice(0, Math.max(3, Math.min(5, w.length - 1)));
  const words = s => s.toLowerCase().split(/[^\p{L}\d]+/u).filter(w => w.length >= 3);
  const q = words(query);
  if (!q.length) return 0;
  const t = words(title).map(stem);
  const hits = q.filter(w => t.some(x => x.startsWith(stem(w)) || stem(w).startsWith(x))).length;
  return hits / q.length;
}
