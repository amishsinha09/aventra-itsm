// Small declarative validator. Unknown keys are dropped (mass-assignment protection).
import { bad } from './http.js';

export const str = (opts = {}) => ({ kind: 'str', ...opts });
export const int = (opts = {}) => ({ kind: 'int', ...opts });
export const bool = (opts = {}) => ({ kind: 'bool', ...opts });
export const oneOf = (values, opts = {}) => ({ kind: 'enum', values, ...opts });
export const date = (opts = {}) => ({ kind: 'date', ...opts });
export const obj = (opts = {}) => ({ kind: 'obj', ...opts });
export const arr = (of, opts = {}) => ({ kind: 'arr', of, ...opts });
export const email = (opts = {}) => ({ kind: 'email', ...opts });

function check(name, rule, v) {
  if (v === undefined || v === null || v === '') {
    if (rule.required) return { err: `${name} is required` };
    return { val: v === '' && rule.kind === 'str' ? '' : (v === undefined ? undefined : null) };
  }
  switch (rule.kind) {
    case 'str': case 'email': {
      if (typeof v !== 'string') return { err: `${name} must be text` };
      const s = v.trim();
      const max = rule.max ?? 10000;
      if (s.length > max) return { err: `${name} must be at most ${max} characters` };
      if (rule.min && s.length < rule.min) return { err: `${name} must be at least ${rule.min} characters` };
      if (rule.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { err: `${name} must be a valid email` };
      return { val: rule.kind === 'email' ? s.toLowerCase() : s };
    }
    case 'int': {
      const n = typeof v === 'string' && /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
      if (!Number.isInteger(n)) return { err: `${name} must be a whole number` };
      if (rule.min !== undefined && n < rule.min) return { err: `${name} must be ≥ ${rule.min}` };
      if (rule.max !== undefined && n > rule.max) return { err: `${name} must be ≤ ${rule.max}` };
      return { val: n };
    }
    case 'bool':
      if (typeof v === 'boolean') return { val: v };
      if (v === 'true' || v === 'false') return { val: v === 'true' };
      return { err: `${name} must be true or false` };
    case 'enum':
      if (!rule.values.includes(v)) return { err: `${name} must be one of: ${rule.values.join(', ')}` };
      return { val: v };
    case 'date': {
      const d = new Date(v);
      if (isNaN(d)) return { err: `${name} must be a date` };
      return { val: d };
    }
    case 'obj':
      if (typeof v !== 'object' || Array.isArray(v)) return { err: `${name} must be an object` };
      if (JSON.stringify(v).length > (rule.maxBytes ?? 20000)) return { err: `${name} is too large` };
      return { val: v };
    case 'arr': {
      if (!Array.isArray(v)) return { err: `${name} must be a list` };
      if (v.length > (rule.max ?? 500)) return { err: `${name} has too many items` };
      const out = [];
      for (const [i, x] of v.entries()) {
        const r = check(`${name}[${i}]`, rule.of, x);
        if (r.err) return r;
        out.push(r.val);
      }
      return { val: out };
    }
    default: return { err: `unknown rule for ${name}` };
  }
}

export function validate(schema, input = {}, { partial = false } = {}) {
  if (typeof input !== 'object' || input === null) throw bad('Body must be a JSON object');
  const out = {}; const errors = {};
  for (const [k, rule] of Object.entries(schema)) {
    if (partial && !(k in input)) continue;
    const r = check(k, partial ? { ...rule, required: false } : rule, input[k]);
    if (r.err) errors[k] = r.err;
    else if (r.val !== undefined) out[k] = r.val;
    else if (rule.default !== undefined && !partial) out[k] = rule.default;
  }
  if (Object.keys(errors).length) throw bad(Object.values(errors)[0], errors);
  return out;
}
