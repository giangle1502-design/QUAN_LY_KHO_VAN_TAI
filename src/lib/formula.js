// Trường công thức: tính từ các trường khác, vd. [Số lượng (tấn)] * [Đơn giá]
// Hỗ trợ + - * / ( ), số thập phân, hàm SUM (cộng 1 trường của mọi dòng hàng), ROUND, MIN, MAX, ABS.
// Trường phần trăm vào công thức như Excel: 8% = 0,08. Kết quả dạng phần trăm thì 0,08 hiện 8%.
import { norm } from './utils';

const FUNCS = {
  ROUND: (x, d = 0) => { const k = 10 ** d; return Math.round(x * k) / k; },
  MIN: (...a) => Math.min(...a),
  MAX: (...a) => Math.max(...a),
  ABS: (x) => Math.abs(x),
};

function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src || '');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[') {
      const j = s.indexOf(']', i);
      if (j < 0) throw new Error('Thiếu dấu ] trong công thức.');
      out.push({ t: 'var', v: s.slice(i + 1, j).trim() }); i = j + 1; continue;
    }
    const num = s.slice(i).match(/^\d+([.,]\d+)?/);
    if (num) { out.push({ t: 'num', v: Number(num[0].replace(',', '.')) }); i += num[0].length; continue; }
    const id = s.slice(i).match(/^[A-Za-z]+/);
    if (id) { out.push({ t: 'fn', v: id[0].toUpperCase() }); i += id[0].length; continue; }
    if ('+-*/();'.includes(c)) { out.push({ t: c === ';' ? ',' : c }); i++; continue; }
    if (c === ',') { out.push({ t: ',' }); i++; continue; }
    throw new Error(`Ký tự không hợp lệ trong công thức: "${c}"`);
  }
  return out;
}

// Phân tích thành cây để tính nhiều lần (mỗi dòng hàng)
export function parseFormula(src) {
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p];
  const eat = (t) => { if (peek()?.t !== t) throw new Error(`Công thức sai: thiếu "${t}".`); p++; };
  const expr = () => {
    let a = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) { const op = tk[p++].t; a = { op, a, b: term() }; }
    return a;
  };
  const term = () => {
    let a = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) { const op = tk[p++].t; a = { op, a, b: unary() }; }
    return a;
  };
  const unary = () => {
    if (peek()?.t === '-') { p++; return { op: 'neg', a: unary() }; }
    if (peek()?.t === '+') { p++; return unary(); }
    return atom();
  };
  const atom = () => {
    const x = peek();
    if (!x) throw new Error('Công thức chưa hoàn chỉnh.');
    if (x.t === 'num') { p++; return { num: x.v }; }
    if (x.t === 'var') { p++; return { v: x.v }; }
    if (x.t === '(') { p++; const e = expr(); eat(')'); return e; }
    if (x.t === 'fn') {
      p++;
      if (x.v !== 'SUM' && !FUNCS[x.v]) throw new Error(`Không có hàm ${x.v} (dùng SUM, ROUND, MIN, MAX, ABS).`);
      eat('(');
      const args = [];
      if (peek()?.t !== ')') { args.push(expr()); while (peek()?.t === ',') { p++; args.push(expr()); } }
      eat(')');
      if (x.v === 'SUM' && (args.length !== 1 || !args[0].v)) throw new Error('SUM dùng dạng SUM([Tên trường dòng hàng]).');
      return { fn: x.v, args };
    }
    throw new Error('Công thức sai cú pháp.');
  };
  const tree = expr();
  if (p < tk.length) throw new Error('Công thức sai cú pháp.');
  return tree;
}

// Tên trường trong công thức ([...]) → trường
export function fieldResolver(...lists) {
  return (name) => {
    const k = norm(name);
    for (const list of lists) {
      const f = list.find((x) => x.key === name) || list.find((x) => norm(x.label) === k);
      if (f) return f;
    }
    return null;
  };
}
export function refsOf(tree, acc = []) {
  if (!tree) return acc;
  if (tree.v) acc.push(tree.v);
  if (tree.fn === 'SUM') acc.push(`SUM:${tree.args[0].v}`);
  else (tree.args || []).forEach((a) => refsOf(a, acc));
  refsOf(tree.a, acc); refsOf(tree.b, acc);
  return acc;
}

const num = (x) => (x === '' || x == null || Number.isNaN(Number(x)) ? 0 : Number(x));
// getVar(name) → số; sumVar(name) → tổng của trường dòng hàng
export function evalTree(t, getVar, sumVar) {
  if (t.num !== undefined) return t.num;
  if (t.v !== undefined) return getVar(t.v);
  if (t.fn === 'SUM') return sumVar ? sumVar(t.args[0].v) : 0;
  if (t.fn) return FUNCS[t.fn](...t.args.map((a) => evalTree(a, getVar, sumVar)));
  if (t.op === 'neg') return -evalTree(t.a, getVar, sumVar);
  const a = evalTree(t.a, getVar, sumVar);
  const b = evalTree(t.b, getVar, sumVar);
  if (t.op === '+') return a + b;
  if (t.op === '-') return a - b;
  if (t.op === '*') return a * b;
  return b === 0 ? 0 : a / b;
}

// Giá trị 1 trường khi đưa vào công thức (phần trăm = phân số như Excel)
export const varValue = (f, v) => (f?.type === 'percent' || (f?.type === 'formula' && f.resultType === 'percent') ? num(v) / 100 : num(v));

// Tính các trường công thức của 1 bản ghi (nhiều lượt để công thức dùng công thức khác)
// fields: trường của bản ghi; extra: trường ở mức khác (phần chung) để tra tên; rowExtra: giá trị mức khác; lines + lineFields: cho SUM
export function computeFormulas(fields, row, { extraFields = [], rowExtra = {}, lines = null, lineFields = [] } = {}) {
  const fs = fields.filter((f) => f.type === 'formula' && f.formula);
  if (!fs.length) return row;
  const out = { ...row };
  const find = fieldResolver(fields, extraFields);
  const findLine = fieldResolver(lineFields);
  // Trường dùng trong công thức chưa có giá trị (chưa nhập / không được xem) → kết quả để trống
  let missing = false;
  const empty = (v) => v === '' || v == null;
  const getVar = (name) => {
    const f = find(name);
    if (!f) return 0;
    const v = fields.includes(f) ? out[f.key] : rowExtra[f.key];
    if (empty(v)) missing = true;
    return varValue(f, v);
  };
  const sumVar = (name) => {
    const f = findLine(name);
    if (!f || !lines || lines.every((l) => empty(l[f.key]))) { missing = true; return 0; }
    return lines.reduce((s, l) => s + varValue(f, l[f.key]), 0);
  };
  for (let pass = 0; pass < 3; pass++) {
    for (const f of fs) {
      try {
        missing = false;
        const r = evalTree(parseFormula(f.formula), getVar, sumVar) * (f.resultType === 'percent' ? 100 : 1);
        out[f.key] = !missing && Number.isFinite(r) ? Math.round(r * 1e6) / 1e6 : '';
      } catch { out[f.key] = ''; }
    }
  }
  return out;
}

// Đổi [tên trường] ↔ [mã trường] để đổi tên trường không làm hỏng công thức
export function formulaToKeys(src, ...lists) {
  const find = fieldResolver(...lists);
  return String(src || '').replace(/\[([^\]]+)\]/g, (m, name) => { const f = find(name.trim()); return f ? `[${f.key}]` : m; });
}
export function formulaToLabels(src, ...lists) {
  const find = fieldResolver(...lists);
  return String(src || '').replace(/\[([^\]]+)\]/g, (m, name) => { const f = find(name.trim()); return f ? `[${f.label}]` : m; });
}
// Kiểm tra công thức: trả về '' nếu đúng, hoặc lỗi
export function checkFormula(src, lists, lineList) {
  try {
    const tree = parseFormula(src);
    const find = fieldResolver(...lists);
    const findLine = fieldResolver(lineList || []);
    for (const r of refsOf(tree)) {
      if (r.startsWith('SUM:')) { if (!findLine(r.slice(4))) return `SUM: không có trường dòng hàng "${r.slice(4)}".`; } else if (!find(r)) return `Không có trường "${r}".`;
    }
    return '';
  } catch (e) { return e.message; }
}
