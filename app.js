const { useState, useEffect } = React;

/* ============ Constants ============ */
const CATEGORIES = [
  { id: 'food', name: 'Food', color: '#E07A5F' },
  { id: 'groceries', name: 'Groceries', color: '#81B29A' },
  { id: 'transport', name: 'Transport', color: '#3D85C6' },
  { id: 'bills', name: 'Bills', color: '#8E7DBE' },
  { id: 'health', name: 'Health & Fitness', color: '#2A9D8F' },
  { id: 'shopping', name: 'Shopping', color: '#F2A541' },
  { id: 'work', name: 'Work', color: '#7A7F87' },
  { id: 'social', name: 'Social & Fun', color: '#D65DB1' },
  { id: 'family', name: 'Family', color: '#C9A227' },
];
const catById = id => CATEGORIES.find(c => c.id === id) || CATEGORIES[0];

// One-tap presets for things work reimburses
const QUICK = [
  { label: 'Parking', category: 'transport', note: 'Parking', claimable: true },
  { label: 'Mobile plan', category: 'bills', note: 'Mobile plan', claimable: true },
];
const CLAIM_RE = /parking|mobile|phone (bill|plan)|postpaid|data plan/i;
const CLAIM_LABEL = { pending: 'To claim', submitted: 'Submitted', received: 'Reimbursed' };
const STORE_KEY = 'spendwise.fresh.v1';

/* ============ Helpers ============ */
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const round2 = n => Math.round(n * 100) / 100;
const sum = arr => round2(arr.reduce((a, b) => a + b, 0));
const rm = n => 'RM ' + (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
const todayISO = () => toISO(new Date());
function addDaysISO(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
function addMonthsISO(iso, n) {
  const d = parseISO(iso);
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d.getDate(), last));
  return toISO(t);
}
const fmtDate = s => parseISO(s).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' });
const fmtDateLong = s => parseISO(s).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = s => parseISO(s).toLocaleDateString('en-MY', { month: 'short', year: 'numeric' });

/* ============ Storage ============ */
const emptyData = () => ({ settings: null, expenses: [], commitments: [], debts: [] });
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...emptyData(), ...JSON.parse(raw) };
  } catch (e) {}
  return emptyData();
}
function persist(d) { try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (e) {} }

/* ============ Pay periods (payday to payday) ============ */
function paydayIn(year, month, payday) {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(payday, last));
}
function periodFor(iso, s) {
  const d = parseISO(iso);
  const first = parseISO(s.firstPayDate);
  if (d < first) {
    return { key: 'pre', label: 'Before first pay', start: null, end: addDaysISO(s.firstPayDate, -1) };
  }
  let start = paydayIn(d.getFullYear(), d.getMonth(), s.payday);
  if (start > d) start = paydayIn(d.getFullYear(), d.getMonth() - 1, s.payday);
  if (start < first) start = first;
  let next = paydayIn(start.getFullYear(), start.getMonth(), s.payday);
  if (next <= start) next = paydayIn(start.getFullYear(), start.getMonth() + 1, s.payday);
  const startISO = toISO(start);
  const endISO = addDaysISO(toISO(next), -1);
  return { key: startISO, start: startISO, end: endISO, label: `${fmtDate(startISO)} – ${fmtDate(endISO)}` };
}

/* ============ Commitments & debts ============ */
const instalmentDates = c => Array.from({ length: c.months }, (_, i) => addMonthsISO(c.startDate, i));
const perMonth = c => round2(c.total / c.months);
const portion = (c, i) => (i === c.months - 1 ? round2(c.total - perMonth(c) * (c.months - 1)) : perMonth(c));

function debtTotal(debt, expenses) {
  return round2(debt.initial + sum(expenses.filter(e => e.fundedBy === debt.id).map(e => e.amount)));
}
function debtBalance(debt, expenses) {
  return round2(debtTotal(debt, expenses) - sum(debt.payments.map(p => p.amount)));
}

function computeStats(data, period) {
  const s = data.settings;
  const inP = dt => periodFor(dt, s).key === period.key;
  const pre = period.key === 'pre';
  const exps = data.expenses.filter(e => inP(e.date));

  // Cash out of your pocket this period (borrowed money and reimbursed claims don't count)
  const cashSpent = sum(exps.filter(e => !e.fundedBy && !(e.claimable && e.claimStatus === 'received')).map(e => e.amount));
  const borrowedSpent = sum(exps.filter(e => e.fundedBy).map(e => e.amount));
  const totalSpent = sum(exps.map(e => e.amount));
  const debtPaid = sum(data.debts.flatMap(d => d.payments.filter(p => inP(p.date)).map(p => p.amount)));

  const dueInstalments = [];
  data.commitments.filter(c => c.mode === 'instalment').forEach(c => {
    instalmentDates(c).forEach((dt, i) => {
      if (!inP(dt)) return;
      const paid = data.expenses.some(e => e.commitmentId === c.id && e.instalment === i);
      dueInstalments.push({ c, i, date: dt, amount: portion(c, i), paid });
    });
  });
  const unpaidDue = sum(dueInstalments.filter(x => !x.paid).map(x => x.amount));

  const debtPlans = data.debts.map(d => {
    const bal = debtBalance(d, data.expenses);
    const paidHere = sum(d.payments.filter(p => inP(p.date)).map(p => p.amount));
    const remaining = Math.max(0, round2(Math.min(d.monthly - paidHere, bal)));
    return { d, bal, paidHere, remaining };
  });
  const plannedDebt = pre ? 0 : sum(debtPlans.map(x => x.remaining));

  const salary = pre ? 0 : s.salary;
  const free = round2(salary - cashSpent - debtPaid - unpaidDue - plannedDebt);

  // Category view: upfront plans (e.g. gym) are spread across their months
  const byCat = {};
  const add = (cat, amt) => { byCat[cat] = round2((byCat[cat] || 0) + amt); };
  exps.forEach(e => {
    const c = e.commitmentId && data.commitments.find(x => x.id === e.commitmentId);
    if (c && c.mode === 'upfront') return;
    add(e.category, e.amount);
  });
  let hasSpread = false;
  data.commitments.filter(c => c.mode === 'upfront').forEach(c => {
    instalmentDates(c).forEach((dt, i) => { if (inP(dt)) { add(c.category, portion(c, i)); hasSpread = true; } });
  });
  const cats = Object.entries(byCat).filter(([, v]) => v > 0)
    .map(([id, amount]) => ({ cat: catById(id), amount })).sort((a, b) => b.amount - a.amount);
  const maxCat = cats.length ? cats[0].amount : 1;

  return { pre, exps, cashSpent, borrowedSpent, totalSpent, debtPaid, dueInstalments, unpaidDue, debtPlans, plannedDebt, salary, free, cats, maxCat, hasSpread };
}

/* ============ Icons ============ */
const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const IHome = () => <Icon><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" /></Icon>;
const IList = () => <Icon><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></Icon>;
const IPlan = () => <Icon><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Icon>;
const IClaim = () => <Icon><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 8h6M9 12h6" /></Icon>;
const IPlus = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>;
const ILeft = () => <Icon><path d="m15 18-6-6 6-6" /></Icon>;
const IRight = () => <Icon><path d="m9 18 6-6-6-6" /></Icon>;
const IClose = () => <Icon><path d="M18 6 6 18M6 6l12 12" /></Icon>;
const IGear = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></Icon>;

/* ============ Small UI pieces ============ */
function Sheet({ title, onClose, children }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IClose /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="toggle-row">
      <div><div>{label}</div>{hint && <small>{hint}</small>}</div>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="switch" />
    </label>
  );
}

function MoneyField({ label, value, onChange, hint, autoFocus }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" inputMode="decimal" placeholder="0.00" autoFocus={autoFocus}
        value={value} onChange={e => onChange(e.target.value.replace(/[^0-9.]/g, ''))} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function CategoryChips({ value, onChange }) {
  return (
    <div className="chips">
      {CATEGORIES.map(c => (
        <button type="button" key={c.id} className={'chip' + (value === c.id ? ' active' : '')} onClick={() => onChange(c.id)}>
          <i style={{ background: c.color }} />{c.name}
        </button>
      ))}
    </div>
  );
}

function ExpenseRow({ e, data, onClick }) {
  const cat = catById(e.category);
  const debt = e.fundedBy && data.debts.find(d => d.id === e.fundedBy);
  return (
    <button className="row" onClick={onClick}>
      <i className="dot lg" style={{ background: cat.color }} />
      <div className="row-main">
        <div>{e.note || cat.name}</div>
        <small>{fmtDate(e.date)} · {cat.name}{debt ? ` · via ${debt.name}` : ''}</small>
      </div>
      <div className="row-end">
        <b>{rm(e.amount)}</b>
        {e.claimable && <span className={'tag ' + (e.claimStatus === 'received' ? 'ok' : 'warn')}>{CLAIM_LABEL[e.claimStatus] || 'To claim'}</span>}
      </div>
    </button>
  );
}

/* ============ Forms ============ */
function ExpenseForm({ initial, debts, onSave, onDelete }) {
  const [f, setF] = useState(() => ({
    amount: initial ? String(initial.amount) : '',
    category: initial?.category || 'food',
    note: initial?.note || '',
    date: initial?.date || todayISO(),
    claimable: !!initial?.claimable,
    fundedBy: initial?.fundedBy || '',
  }));
  const [claimTouched, setClaimTouched] = useState(!!initial);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const amt = parseFloat(f.amount);

  const onNote = v => setF(p => ({ ...p, note: v, claimable: claimTouched ? p.claimable : CLAIM_RE.test(v) }));
  const quick = q => { setF(p => ({ ...p, category: q.category, note: q.note, claimable: q.claimable })); setClaimTouched(true); };

  const submit = e => {
    e.preventDefault();
    if (!(amt > 0)) return;
    if (f.fundedBy === '__new' && !(f.newLender || '').trim()) return;
    onSave({ amount: round2(amt), category: f.category, note: f.note.trim(), date: f.date, claimable: f.claimable,
      fundedBy: f.fundedBy === '__new' ? null : (f.fundedBy || null) },
      f.fundedBy === '__new' ? f.newLender.trim() : null);
  };
  const lenderMissing = f.fundedBy === '__new' && !(f.newLender || '').trim();

  return (
    <form onSubmit={submit}>
      <div className="amount-input">
        <span>RM</span>
        <input inputMode="decimal" placeholder="0.00" autoFocus={!initial} value={f.amount}
          onChange={e => set('amount', e.target.value.replace(/[^0-9.]/g, ''))} />
      </div>
      {!initial && (
        <div className="chips">
          {QUICK.map(q => <button type="button" key={q.label} className="chip ghost" onClick={() => quick(q)}>+ {q.label}</button>)}
        </div>
      )}
      <div className="field-label">Category</div>
      <CategoryChips value={f.category} onChange={v => set('category', v)} />
      <div className="row2">
        <label className="field"><span>Note</span>
          <input className="input" placeholder="Optional" value={f.note} onChange={e => onNote(e.target.value)} />
        </label>
        <label className="field"><span>Date</span>
          <input className="input" type="date" value={f.date} onChange={e => set('date', e.target.value)} />
        </label>
      </div>
      <Toggle label="Claim back from work" hint={f.claimable ? "You'll be reminded until it's reimbursed" : 'For parking, mobile plan and similar'}
        checked={f.claimable} onChange={v => { set('claimable', v); setClaimTouched(true); }} />
      <label className="field"><span>Paid with</span>
        <select className="input" value={f.fundedBy} onChange={e => set('fundedBy', e.target.value)}>
          <option value="">My own money</option>
          {debts.map(d => <option key={d.id} value={d.id}>Borrowed from {d.name}</option>)}
          <option value="__new">Borrowed from someone new…</option>
        </select>
        {f.fundedBy === '__new' && (
          <input className="input" placeholder="Who lent it? e.g. Mom" value={f.newLender || ''}
            onChange={e => set('newLender', e.target.value)} />
        )}
        {f.fundedBy && f.fundedBy !== '__new' && <small>This adds to what you owe {debts.find(d => d.id === f.fundedBy)?.name}.</small>}
      </label>
      <div className="btn-row">
        <button className="btn" disabled={!(amt > 0) || lenderMissing}>{initial ? 'Save changes' : 'Add expense'}</button>
        {onDelete && <button type="button" className="btn danger-text" onClick={onDelete}>Delete</button>}
      </div>
    </form>
  );
}

function CommitmentForm({ initial, debts, onSave, onDelete }) {
  const [f, setF] = useState(() => ({
    name: initial?.name || '',
    total: initial ? String(initial.total) : '',
    months: initial ? String(initial.months) : '',
    startDate: initial?.startDate || todayISO(),
    mode: initial?.mode || 'upfront',
    category: initial?.category || 'health',
    fundedBy: initial?.fundedBy || '',
  }));
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const total = parseFloat(f.total), months = parseInt(f.months, 10);
  const valid = f.name.trim() && total > 0 && months > 0;
  const monthly = valid ? round2(total / months) : 0;

  return (
    <form onSubmit={e => { e.preventDefault(); if (valid) onSave({ ...f, name: f.name.trim(), total: round2(total), months, fundedBy: f.mode === 'upfront' ? (f.fundedBy || null) : null }); }}>
      <label className="field"><span>Name</span>
        <input className="input" placeholder="e.g. Gym membership" value={f.name} onChange={e => set('name', e.target.value)} autoFocus={!initial} />
      </label>
      <div className="row2">
        <MoneyField label="Total (RM)" value={f.total} onChange={v => set('total', v)} />
        <label className="field"><span>Months</span>
          <input className="input" inputMode="numeric" placeholder="6" value={f.months} onChange={e => set('months', e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      <div className="field"><span>How are you paying?</span>
        <div className="seg">
          <button type="button" className={f.mode === 'upfront' ? 'on' : ''} onClick={() => set('mode', 'upfront')}>Paid upfront</button>
          <button type="button" className={f.mode === 'instalment' ? 'on' : ''} onClick={() => set('mode', 'instalment')}>Monthly instalments</button>
        </div>
        {valid && <small>{f.mode === 'upfront'
          ? `Counted as ${rm(monthly)} a month in your category view.`
          : `${months} payments of about ${rm(monthly)}, reserved from each pay period.`}</small>}
      </div>
      <label className="field"><span>{f.mode === 'upfront' ? 'Paid on' : 'First payment'}</span>
        <input className="input" type="date" value={f.startDate} onChange={e => set('startDate', e.target.value)} />
      </label>
      <div className="field-label">Category</div>
      <CategoryChips value={f.category} onChange={v => set('category', v)} />
      {f.mode === 'upfront' && debts.length > 0 && (
        <label className="field"><span>Paid with</span>
          <select className="input" value={f.fundedBy} onChange={e => set('fundedBy', e.target.value)}>
            <option value="">My own money</option>
            {debts.map(d => <option key={d.id} value={d.id}>Borrowed from {d.name}</option>)}
          </select>
        </label>
      )}
      <div className="btn-row">
        <button className="btn" disabled={!valid}>{initial ? 'Save changes' : 'Add commitment'}</button>
        {onDelete && <button type="button" className="btn danger-text" onClick={onDelete}>Remove commitment</button>}
      </div>
    </form>
  );
}

function DebtForm({ initial, onSave, onDelete }) {
  const [name, setName] = useState(initial?.name || 'Mom');
  const [amount, setAmount] = useState(initial ? String(initial.initial) : '');
  const [monthly, setMonthly] = useState(initial ? String(initial.monthly) : '');
  const a = parseFloat(amount || '0'), m = parseFloat(monthly);
  const valid = name.trim() && a >= 0 && m > 0;
  return (
    <form onSubmit={e => { e.preventDefault(); if (valid) onSave({ name: name.trim(), initial: round2(a), monthly: round2(m) }); }}>
      <label className="field"><span>Who do you owe?</span>
        <input className="input" value={name} onChange={e => setName(e.target.value)} />
      </label>
      <MoneyField label="Cash borrowed, not for a logged purchase (RM)" value={amount} onChange={setAmount}
        hint="Usually 0. Purchases you log with 'Paid with: Borrowed from …' are added to this debt automatically." />
      <MoneyField label="Monthly repayment (RM)" value={monthly} onChange={setMonthly} />
      <div className="btn-row">
        <button className="btn" disabled={!valid}>{initial ? 'Save changes' : 'Add debt'}</button>
        {onDelete && <button type="button" className="btn danger-text" onClick={onDelete}>Remove debt</button>}
      </div>
    </form>
  );
}

function PaymentForm({ suggested, onSave }) {
  const [amount, setAmount] = useState(suggested > 0 ? String(suggested) : '');
  const [date, setDate] = useState(todayISO());
  const a = parseFloat(amount);
  return (
    <form onSubmit={e => { e.preventDefault(); if (a > 0) onSave({ amount: round2(a), date }); }}>
      <MoneyField label="Amount (RM)" value={amount} onChange={setAmount} autoFocus />
      <label className="field"><span>Date</span>
        <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} />
      </label>
      <button className="btn" disabled={!(a > 0)}>Record payment</button>
    </form>
  );
}

function PaySettingsFields({ f, set }) {
  return (
    <>
      <MoneyField label="Monthly take-home pay (RM)" value={f.salary} onChange={v => set('salary', v)} />
      <label className="field"><span>First pay date</span>
        <input className="input" type="date" value={f.firstPayDate}
          onChange={e => { const v = e.target.value; set('firstPayDate', v); if (v && !f.paydayTouched) set('payday', String(parseISO(v).getDate())); }} />
        <small>Spending before this date goes into “Before first pay”.</small>
      </label>
      <label className="field"><span>Usual payday (day of month)</span>
        <input className="input" inputMode="numeric" value={f.payday}
          onChange={e => { set('payday', e.target.value.replace(/\D/g, '').slice(0, 2)); set('paydayTouched', true); }} />
        <small>Each period runs from one payday to the day before the next.</small>
      </label>
    </>
  );
}
const settingsValid = f => parseFloat(f.salary) > 0 && f.firstPayDate && +f.payday >= 1 && +f.payday <= 31;
const toSettings = f => ({ salary: round2(parseFloat(f.salary)), firstPayDate: f.firstPayDate, payday: +f.payday });

function Setup({ onDone }) {
  const [f, setF] = useState({ salary: '', firstPayDate: '', payday: '', paydayTouched: false });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <div className="setup">
      <h1>SpendWise</h1>
      <p>Three quick details and you're set. Everything stays on this device.</p>
      <form onSubmit={e => { e.preventDefault(); if (settingsValid(f)) onDone(toSettings(f)); }}>
        <PaySettingsFields f={f} set={set} />
        <button className="btn" disabled={!settingsValid(f)}>Start tracking</button>
      </form>
    </div>
  );
}

function SettingsSheet({ data, onSave, onImport, onReset }) {
  const s = data.settings;
  const [f, setF] = useState({ salary: String(s.salary), firstPayDate: s.firstPayDate, payday: String(s.payday), paydayTouched: true });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `spendwise-backup-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importData = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (!Array.isArray(d.expenses) || !d.settings) throw new Error();
        onImport({ ...emptyData(), ...d });
      } catch (err) { alert("That file doesn't look like a SpendWise backup."); }
    };
    reader.readAsText(file);
  };

  return (
    <div className="stack">
      <form onSubmit={e => { e.preventDefault(); if (settingsValid(f)) onSave(toSettings(f)); }}>
        <PaySettingsFields f={f} set={set} />
        <button className="btn" disabled={!settingsValid(f)}>Save</button>
      </form>
      <div className="btn-row">
        <div className="field-label" style={{ marginBottom: 2 }}>Your data</div>
        <button className="btn secondary" onClick={exportData}>Download backup</button>
        <label className="btn secondary" style={{ textAlign: 'center' }}>
          Restore from backup
          <input type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={importData} />
        </label>
        <button className="btn danger-text" onClick={onReset}>Erase everything</button>
      </div>
    </div>
  );
}

/* ============ Screens ============ */
function Home({ data, period, stats, go, actions }) {
  const s = data.settings;
  const today = todayISO();
  const isCurrent = !stats.pre && today >= period.start && today <= period.end;
  const daysLeft = isCurrent ? Math.round((parseISO(period.end) - parseISO(today)) / 86400000) + 1 : 0;
  const used = stats.salary > 0 ? Math.min(100, Math.max(0, ((stats.salary - stats.free) / stats.salary) * 100)) : 0;
  const pending = data.expenses.filter(e => e.claimable && e.claimStatus === 'pending');
  const recent = [...stats.exps].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const debtLines = stats.pre ? [] : stats.debtPlans.filter(x => x.bal > 0 || x.paidHere > 0);

  return (
    <div className="stack">
      <section className="card hero">
        {stats.pre ? (
          <>
            <div className="eyebrow">Spent before first pay</div>
            <div className="big">{rm(stats.totalSpent)}</div>
            <div className="sub">First salary on {fmtDateLong(s.firstPayDate)}</div>
            {stats.borrowedSpent > 0 && <div className="sub">{rm(stats.borrowedSpent)} of this was borrowed</div>}
          </>
        ) : (
          <>
            <div className="eyebrow">Free to spend</div>
            <div className={'big' + (stats.free < 0 ? ' neg' : '')}>{rm(stats.free)}</div>
            <div className="sub">
              {isCurrent ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left · about ${rm(Math.max(0, stats.free) / daysLeft)} a day` : period.label}
            </div>
            <div className={'meter' + (stats.free < 0 ? ' over' : '')}><span style={{ width: used + '%' }} /></div>
            <div className="kv3">
              <div><small>Pay</small><b>{rm(stats.salary)}</b></div>
              <div><small>Spent</small><b>{rm(stats.cashSpent + stats.debtPaid)}</b></div>
              <div><small>Set aside</small><b>{rm(stats.unpaidDue + stats.plannedDebt)}</b></div>
            </div>
          </>
        )}
      </section>

      {pending.length > 0 && (
        <button className="banner" onClick={() => go('claims')}>
          <div>
            <b>{pending.length} item{pending.length > 1 ? 's' : ''} to claim from work</b>
            <small>{rm(sum(pending.map(e => e.amount)))} waiting to be submitted</small>
          </div>
          <span>›</span>
        </button>
      )}

      {(stats.dueInstalments.length > 0 || debtLines.length > 0) && (
        <section className="card">
          <h4>Due this period</h4>
          {stats.dueInstalments.map(x => (
            <div className="line" key={x.c.id + x.i}>
              <div><div>{x.c.name}</div><small>Payment {x.i + 1} of {x.c.months} · {fmtDate(x.date)}</small></div>
              <div className="line-end">
                <b>{rm(x.amount)}</b>
                {x.paid ? <span className="tag ok">Paid</span>
                  : <button className="mini" onClick={() => actions.payInstalment(x.c.id, x.i)}>Mark paid</button>}
              </div>
            </div>
          ))}
          {debtLines.map(x => (
            <div className="line" key={x.d.id}>
              <div><div>Repay {x.d.name}</div><small>{x.d.monthly > 0 ? `${rm(x.paidHere)} of ${rm(x.d.monthly)} paid` : 'No monthly plan yet'}</small></div>
              <div className="line-end">
                {x.d.monthly <= 0 ? <button className="mini" onClick={() => actions.editDebt(x.d)}>Set plan</button>
                  : x.remaining > 0
                  ? <button className="mini" onClick={() => actions.openPayment(x.d.id, x.remaining)}>Pay {rm(x.remaining)}</button>
                  : <span className="tag ok">Done</span>}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h4>By category</h4>
        {stats.cats.length === 0 ? <p className="empty">Nothing spent yet in this period.</p> : stats.cats.map(({ cat, amount }) => (
          <div className="bar-row" key={cat.id}>
            <div className="bar-label"><span><i className="dot" style={{ background: cat.color }} />{cat.name}</span><b>{rm(amount)}</b></div>
            <div className="bar"><span style={{ width: (amount / stats.maxCat) * 100 + '%', background: cat.color }} /></div>
          </div>
        ))}
        {stats.hasSpread && <small className="note">Plans paid upfront are counted month by month here.</small>}
      </section>

      {recent.length > 0 && (
        <section>
          <div className="sec-head"><h4>Recent</h4><button className="link" onClick={() => go('history')}>See all</button></div>
          <div className="list" style={{ marginTop: 10 }}>
            {recent.map(e => <ExpenseRow key={e.id} e={e} data={data} onClick={() => actions.editExpense(e)} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function History({ data, stats, actions }) {
  const list = [...stats.exps].sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) return <div className="card empty">No expenses in this period yet. Tap + to add one.</div>;
  const groups = [];
  list.forEach(e => {
    const g = groups[groups.length - 1];
    if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] });
  });
  return (
    <div>
      <div className="card" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between' }}>
        <span className="eyebrow">{list.length} entries</span><b>{rm(stats.totalSpent)}</b>
      </div>
      {groups.map(g => (
        <div key={g.date}>
          <div className="day-label">{parseISO(g.date).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
          <div className="list">{g.items.map(e => <ExpenseRow key={e.id} e={e} data={data} onClick={() => actions.editExpense(e)} />)}</div>
        </div>
      ))}
    </div>
  );
}

function CommitmentCard({ c, data, actions }) {
  const dates = instalmentDates(c);
  const today = todayISO();
  let done, next = null;
  if (c.mode === 'instalment') {
    const paid = new Set(data.expenses.filter(e => e.commitmentId === c.id).map(e => e.instalment));
    done = paid.size;
    const ni = dates.findIndex((_, i) => !paid.has(i));
    if (ni !== -1) next = { i: ni, date: dates[ni], amount: portion(c, ni) };
  } else {
    done = dates.filter(d => d <= today).length;
  }
  const endDate = addDaysISO(addMonthsISO(c.startDate, c.months), -1);
  return (
    <div className="card">
      <div className="plan-top">
        <div><h3>{c.name}</h3><small>{catById(c.category).name}</small></div>
        <span className="tag neutral">{c.mode === 'upfront' ? 'Paid upfront' : 'Instalments'}</span>
      </div>
      <div className="plan-amt">{rm(perMonth(c))}<small> / month</small></div>
      <small>{rm(c.total)} over {c.months} months · ends {fmtDateLong(endDate)}</small>
      <div className="meter" style={{ margin: '12px 0 6px' }}><span style={{ width: (done / c.months) * 100 + '%' }} /></div>
      <small>{c.mode === 'upfront' ? `Month ${Math.min(done, c.months)} of ${c.months}` : `${done} of ${c.months} paid`}
        {next ? ` · next ${rm(next.amount)} on ${fmtDate(next.date)}` : ''}</small>
      <div className="plan-actions">
        {next && <button className="mini" onClick={() => actions.payInstalment(c.id, next.i)}>Mark next paid</button>}
        <button className="mini plain" onClick={() => actions.editCommitment(c)}>Edit</button>
      </div>
    </div>
  );
}

function DebtCard({ d, data, actions }) {
  const total = debtTotal(d, data.expenses);
  const bal = debtBalance(d, data.expenses);
  const borrowed = round2(total - d.initial);
  const pct = total > 0 ? ((total - bal) / total) * 100 : 100;
  const monthsLeft = bal > 0 && d.monthly > 0 ? Math.ceil(bal / d.monthly) : 0;
  const payments = [...d.payments].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div className="card">
      <div className="plan-top">
        <div><h3>{d.name}</h3><small>{d.monthly > 0 ? `${rm(d.monthly)} a month` : 'No monthly plan yet'}</small></div>
        {bal <= 0 ? <span className="tag ok">Paid off</span> : monthsLeft > 0 ? <span className="tag neutral">{monthsLeft} month{monthsLeft > 1 ? 's' : ''} left</span> : <button className="mini" onClick={() => actions.editDebt(d)}>Set plan</button>}
      </div>
      <div className="plan-amt">{rm(Math.max(0, bal))}<small> left</small></div>
      <small>
        {rm(total)} total{borrowed > 0 ? ` (incl. ${rm(borrowed)} in expenses)` : ''}
        {monthsLeft > 0 ? ` · clear by ${fmtMonth(addMonthsISO(todayISO(), monthsLeft - 1))}` : ''}
      </small>
      <div className="meter" style={{ margin: '12px 0 0' }}><span style={{ width: pct + '%' }} /></div>
      <div className="plan-actions">
        {bal > 0 && <button className="mini" onClick={() => actions.openPayment(d.id, d.monthly > 0 ? Math.min(d.monthly, bal) : bal)}>Record payment</button>}
        <button className="mini plain" onClick={() => actions.editDebt(d)}>Edit</button>
      </div>
      {payments.length > 0 && (
        <div className="payments">
          {payments.slice(0, 4).map(p => (
            <div key={p.id}>
              <span>{fmtDateLong(p.date)}</span>
              <span>{rm(p.amount)} <button className="mini danger" onClick={() => actions.deletePayment(d.id, p.id)}>✕</button></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Plans({ data, actions }) {
  return (
    <div className="stack">
      <div className="sec-head"><h4>Commitments</h4><button className="mini" onClick={() => actions.editCommitment(null)}>+ Add</button></div>
      {data.commitments.length === 0
        ? <div className="card empty">Memberships, subscriptions or instalment plans, like a 6-month gym membership.</div>
        : data.commitments.map(c => <CommitmentCard key={c.id} c={c} data={data} actions={actions} />)}
      <div className="sec-head" style={{ marginTop: 10 }}><h4>Money I owe</h4><button className="mini" onClick={() => actions.editDebt(null)}>+ Add</button></div>
      {data.debts.length === 0
        ? <div className="card empty">Track what you're paying back to family or friends, with a monthly plan.</div>
        : data.debts.map(d => <DebtCard key={d.id} d={d} data={data} actions={actions} />)}
    </div>
  );
}

function Claims({ data, actions }) {
  const [tab, setTab] = useState('pending');
  const claimable = data.expenses.filter(e => e.claimable);
  const list = claimable.filter(e => (e.claimStatus || 'pending') === tab).sort((a, b) => b.date.localeCompare(a.date));
  const count = st => claimable.filter(e => (e.claimStatus || 'pending') === st).length;
  const nextStatus = { pending: 'submitted', submitted: 'received' };
  const nextLabel = { pending: 'Submitted', submitted: 'Received' };
  return (
    <div className="stack">
      <div className="card">
        <h4>Work reimbursements</h4>
        <p className="sub">Parking and mobile plan costs you've paid yourself. Submit them to your company, then mark them received when the money comes in.</p>
      </div>
      <div className="seg">
        {['pending', 'submitted', 'received'].map(st => (
          <button key={st} className={tab === st ? 'on' : ''} onClick={() => setTab(st)}>{CLAIM_LABEL[st]} ({count(st)})</button>
        ))}
      </div>
      {list.length === 0 ? <div className="card empty">Nothing here.</div> : (
        <>
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div><span className="eyebrow">Total</span><div style={{ fontWeight: 700, fontSize: 20 }}>{rm(sum(list.map(e => e.amount)))}</div></div>
            {nextStatus[tab] && <button className="mini" onClick={() => actions.setClaims(list.map(e => e.id), nextStatus[tab])}>Mark all {nextLabel[tab].toLowerCase()}</button>}
          </div>
          <div className="list">
            {list.map(e => (
              <div className="row" key={e.id}>
                <i className="dot lg" style={{ background: catById(e.category).color }} />
                <div className="row-main"><div>{e.note || catById(e.category).name}</div><small>{fmtDateLong(e.date)}</small></div>
                <div className="row-end">
                  <b>{rm(e.amount)}</b>
                  {nextStatus[tab]
                    ? <button className="mini" onClick={() => actions.setClaims([e.id], nextStatus[tab])}>{nextLabel[tab]}</button>
                    : <button className="mini plain" onClick={() => actions.setClaims([e.id], 'submitted')}>Undo</button>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ============ App ============ */
function App() {
  const [data, setData] = useState(load);
  const [tab, setTab] = useState('home');
  const [periodDate, setPeriodDate] = useState(todayISO());
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => persist(data), [data]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const update = fn => setData(d => fn(JSON.parse(JSON.stringify(d))));
  const close = () => setSheet(null);

  if (!data.settings) {
    return <Setup onDone={s => { setData(d => ({ ...d, settings: s })); setPeriodDate(todayISO()); }} />;
  }

  const period = periodFor(periodDate, data.settings);
  const stats = computeStats(data, period);
  const pendingCount = data.expenses.filter(e => e.claimable && e.claimStatus === 'pending').length;
  const isNowPeriod = periodFor(todayISO(), data.settings).key === period.key;

  // If a debt already has a manually entered amount, ask whether a newly linked purchase is part of it
  const askAbsorb = (debtId, amount) => {
    const debt = data.debts.find(x => x.id === debtId);
    if (!debt || !(debt.initial > 0)) return 0;
    const ok = confirm(`You already entered ${rm(debt.initial)} as owed to ${debt.name}.\n\nIs this ${rm(amount)} part of that amount?\n\nOK: yes, don't count it twice\nCancel: no, it's extra`);
    return ok ? Math.min(debt.initial, amount) : 0;
  };
  const absorbInto = (d, debtId, amt) => {
    if (!amt) return;
    const debt = d.debts.find(x => x.id === debtId);
    if (debt) debt.initial = round2(Math.max(0, debt.initial - amt));
  };

  const actions = {
    editExpense: e => setSheet({ type: 'expense', item: e }),
    saveExpense: (form, id, newLender) => {
      const prev = id ? data.expenses.find(x => x.id === id) : null;
      const absorb = form.fundedBy && (!prev || prev.fundedBy !== form.fundedBy) ? askAbsorb(form.fundedBy, form.amount) : 0;
      const absorbId = form.fundedBy;
      update(d => {
        absorbInto(d, absorbId, absorb);
        if (newLender) {
          const existing = d.debts.find(x => x.name.toLowerCase() === newLender.toLowerCase());
          if (existing) form = { ...form, fundedBy: existing.id };
          else {
            const debt = { id: uid(), name: newLender, initial: 0, monthly: 0, payments: [] };
            d.debts.push(debt);
            form = { ...form, fundedBy: debt.id };
          }
        }
        if (id) {
          const e = d.expenses.find(x => x.id === id);
          const wasClaim = e.claimable;
          Object.assign(e, form);
          if (form.claimable && !wasClaim) e.claimStatus = 'pending';
          if (!form.claimable) delete e.claimStatus;
        } else {
          d.expenses.push({ id: uid(), ...form, ...(form.claimable ? { claimStatus: 'pending' } : {}) });
        }
        return d;
      });
      close();
      setToast(form.claimable && !id ? `Saved. Remember to claim ${rm(form.amount)} back from work.`
        : newLender ? `Saved. Set a monthly repayment for ${newLender} in Plans.` : 'Saved');
    },
    deleteExpense: id => {
      if (!confirm('Delete this expense?')) return;
      update(d => { d.expenses = d.expenses.filter(e => e.id !== id); return d; });
      close();
    },
    payInstalment: (cid, i) => {
      update(d => {
        const c = d.commitments.find(x => x.id === cid);
        const due = instalmentDates(c)[i];
        const today = todayISO();
        d.expenses.push({ id: uid(), amount: portion(c, i), category: c.category, note: `${c.name} (${i + 1}/${c.months})`,
          date: due < today ? today : due, claimable: false, fundedBy: null, commitmentId: cid, instalment: i });
        return d;
      });
      setToast('Payment recorded');
    },
    editCommitment: c => setSheet({ type: 'commitment', item: c }),
    saveCommitment: (form, id) => {
      const prev = id ? data.commitments.find(x => x.id === id) : null;
      const absorb = form.mode === 'upfront' && form.fundedBy && (!prev || prev.fundedBy !== form.fundedBy) ? askAbsorb(form.fundedBy, form.total) : 0;
      update(d => {
        absorbInto(d, form.fundedBy, absorb);
        let c;
        if (id) { c = d.commitments.find(x => x.id === id); Object.assign(c, form); }
        else { c = { id: uid(), ...form }; d.commitments.push(c); }
        if (c.mode === 'upfront') {
          // one real expense for the upfront payment
          d.expenses = d.expenses.filter(e => e.commitmentId !== c.id);
          d.expenses.push({ id: uid(), amount: c.total, category: c.category, note: c.name, date: c.startDate,
            claimable: false, fundedBy: c.fundedBy || null, commitmentId: c.id });
        } else {
          d.expenses = d.expenses.filter(e => !(e.commitmentId === c.id && e.instalment === undefined));
        }
        return d;
      });
      close();
    },
    deleteCommitment: id => {
      if (!confirm('Remove this commitment and the payments logged for it?')) return;
      update(d => {
        d.commitments = d.commitments.filter(c => c.id !== id);
        d.expenses = d.expenses.filter(e => e.commitmentId !== id);
        return d;
      });
      close();
    },
    editDebt: debt => setSheet({ type: 'debt', item: debt }),
    saveDebt: (form, id) => {
      update(d => {
        if (id) Object.assign(d.debts.find(x => x.id === id), form);
        else d.debts.push({ id: uid(), ...form, payments: [] });
        return d;
      });
      close();
    },
    deleteDebt: id => {
      if (!confirm('Remove this debt? Expenses linked to it will be kept as normal spending.')) return;
      update(d => {
        d.debts = d.debts.filter(x => x.id !== id);
        d.expenses.forEach(e => { if (e.fundedBy === id) e.fundedBy = null; });
        d.commitments.forEach(c => { if (c.fundedBy === id) c.fundedBy = null; });
        return d;
      });
      close();
    },
    openPayment: (debtId, suggested) => setSheet({ type: 'payment', debtId, suggested }),
    savePayment: (debtId, p) => {
      update(d => { d.debts.find(x => x.id === debtId).payments.push({ id: uid(), ...p }); return d; });
      close();
      setToast('Repayment recorded');
    },
    deletePayment: (debtId, pid) => {
      if (!confirm('Delete this repayment?')) return;
      update(d => { const debt = d.debts.find(x => x.id === debtId); debt.payments = debt.payments.filter(p => p.id !== pid); return d; });
    },
    setClaims: (ids, status) => {
      update(d => { d.expenses.forEach(e => { if (ids.includes(e.id)) e.claimStatus = status; }); return d; });
      setToast(status === 'received' ? 'Marked as reimbursed' : status === 'submitted' ? 'Marked as submitted' : 'Updated');
    },
  };

  const showPeriodNav = tab === 'home' || tab === 'history';
  const prev = () => { if (period.key !== 'pre') setPeriodDate(addDaysISO(period.start, -1)); };
  const next = () => setPeriodDate(addDaysISO(period.end, 1));

  const sheetEl = (() => {
    if (!sheet) return null;
    if (sheet.type === 'expense') return (
      <Sheet title={sheet.item ? 'Edit expense' : 'New expense'} onClose={close}>
        <ExpenseForm initial={sheet.item} debts={data.debts}
          onSave={(f, lender) => actions.saveExpense(f, sheet.item?.id, lender)}
          onDelete={sheet.item ? () => actions.deleteExpense(sheet.item.id) : null} />
      </Sheet>
    );
    if (sheet.type === 'commitment') return (
      <Sheet title={sheet.item ? 'Edit commitment' : 'New commitment'} onClose={close}>
        <CommitmentForm initial={sheet.item} debts={data.debts}
          onSave={f => actions.saveCommitment(f, sheet.item?.id)}
          onDelete={sheet.item ? () => actions.deleteCommitment(sheet.item.id) : null} />
      </Sheet>
    );
    if (sheet.type === 'debt') return (
      <Sheet title={sheet.item ? 'Edit debt' : 'Money I owe'} onClose={close}>
        <DebtForm initial={sheet.item} onSave={f => actions.saveDebt(f, sheet.item?.id)}
          onDelete={sheet.item ? () => actions.deleteDebt(sheet.item.id) : null} />
      </Sheet>
    );
    if (sheet.type === 'payment') {
      const debt = data.debts.find(d => d.id === sheet.debtId);
      return (
        <Sheet title={`Repay ${debt.name}`} onClose={close}>
          <PaymentForm suggested={sheet.suggested} onSave={p => actions.savePayment(sheet.debtId, p)} />
        </Sheet>
      );
    }
    if (sheet.type === 'settings') return (
      <Sheet title="Settings" onClose={close}>
        <SettingsSheet data={data}
          onSave={s => { update(d => { d.settings = s; return d; }); close(); setToast('Settings saved'); }}
          onImport={d => { setData(d); close(); setToast('Backup restored'); }}
          onReset={() => { if (confirm('Erase all data on this device? Download a backup first if you need it.')) { setData(emptyData()); close(); } }} />
      </Sheet>
    );
    return null;
  })();

  const titles = { plans: 'Plans', claims: 'Claims' };

  return (
    <div className="app">
      <header className="top">
        {showPeriodNav ? (
          <div className="period-nav">
            <button className="icon-btn" onClick={prev} disabled={period.key === 'pre'} aria-label="Previous period"><ILeft /></button>
            <span onClick={() => setPeriodDate(todayISO())} title="Back to this period">{period.label}{isNowPeriod ? '' : ' ↺'}</span>
            <button className="icon-btn" onClick={next} aria-label="Next period"><IRight /></button>
          </div>
        ) : <div className="brand">{titles[tab]}</div>}
        <button className="icon-btn" onClick={() => setSheet({ type: 'settings' })} aria-label="Settings"><IGear /></button>
      </header>

      {tab === 'home' && <Home data={data} period={period} stats={stats} go={setTab} actions={actions} />}
      {tab === 'history' && <History data={data} stats={stats} actions={actions} />}
      {tab === 'plans' && <Plans data={data} actions={actions} />}
      {tab === 'claims' && <Claims data={data} actions={actions} />}

      <nav className="nav">
        <div className="nav-inner">
          <button className={'nav-btn' + (tab === 'home' ? ' on' : '')} onClick={() => setTab('home')}><IHome />Home</button>
          <button className={'nav-btn' + (tab === 'history' ? ' on' : '')} onClick={() => setTab('history')}><IList />History</button>
          <button className="fab" onClick={() => setSheet({ type: 'expense', item: null })} aria-label="Add expense"><IPlus /></button>
          <button className={'nav-btn' + (tab === 'plans' ? ' on' : '')} onClick={() => setTab('plans')}><IPlan />Plans</button>
          <button className={'nav-btn' + (tab === 'claims' ? ' on' : '')} onClick={() => setTab('claims')}>
            <IClaim />Claims{pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
          </button>
        </div>
      </nav>

      {sheetEl}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
