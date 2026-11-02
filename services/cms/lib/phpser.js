// Minimal PHP unserialize (byte-length aware). Returns undefined on failure.
function unserialize(input) {
  const buf = Buffer.from(input, 'utf8');
  let i = 0;
  const until = (ch) => {
    const j = buf.indexOf(ch, i);
    if (j < 0) throw new Error('unexpected end');
    const s = buf.toString('latin1', i, j);
    i = j + 1;
    return s;
  };
  const expect = (ch) => {
    if (buf[i] !== ch.charCodeAt(0)) throw new Error('expected ' + ch + ' at ' + i);
    i++;
  };
  function parse() {
    const t = String.fromCharCode(buf[i]);
    if (t === 'N') { i += 2; return null; }
    i += 2;
    switch (t) {
      case 'b': return until(';') === '1';
      case 'i': return Number(until(';'));
      case 'd': return Number(until(';'));
      case 's': {
        const len = Number(until(':'));
        expect('"');
        const s = buf.toString('utf8', i, i + len);
        i += len;
        expect('"'); expect(';');
        return s;
      }
      case 'a': {
        const n = Number(until(':'));
        expect('{');
        const obj = {};
        const keys = [];
        for (let k = 0; k < n; k++) {
          const key = parse();
          keys.push(key);
          obj[key] = parse();
        }
        expect('}');
        if (keys.every((k, idx) => k === idx)) return keys.map((k) => obj[k]);
        return obj;
      }
      case 'O': case 'C': {
        const nl = Number(until(':'));
        expect('"');
        const cls = buf.toString('utf8', i, i + nl);
        i += nl;
        expect('"'); expect(':');
        const n = Number(until(':'));
        expect('{');
        if (t === 'C') { const raw = buf.toString('utf8', i, i + n); i += n; expect('}'); return { __class: cls, raw }; }
        const obj = { __class: cls };
        for (let k = 0; k < n; k++) {
          const key = String(parse()).replace(/^\0[^\0]*\0/, '');
          obj[key] = parse();
        }
        expect('}');
        return obj;
      }
      default: throw new Error('unknown type ' + t);
    }
  }
  try { return parse(); } catch { return undefined; }
}

function maybeUnserialize(v) {
  if (typeof v !== 'string') return v;
  if (!/^(?:[aOCsibd]:|N;)/.test(v)) return v;
  const r = unserialize(v);
  return r === undefined ? v : r;
}

function serialize(v) {
  if (v === null || v === undefined) return 'N;';
  if (typeof v === 'boolean') return `b:${v ? 1 : 0};`;
  if (typeof v === 'number') return Number.isInteger(v) ? `i:${v};` : `d:${v};`;
  if (typeof v === 'string') return `s:${Buffer.byteLength(v, 'utf8')}:"${v}";`;
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
  return `a:${entries.length}:{${entries.map(([k, x]) => (typeof k === 'number' || /^(0|-?[1-9]\d*)$/.test(k) ? `i:${k};` : serialize(String(k))) + serialize(x)).join('')}}`;
}

module.exports = { unserialize, maybeUnserialize, serialize };
