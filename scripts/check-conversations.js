const fs = require('fs');
const path = require('path');
const os = require('os');
const d = path.join(os.homedir(), '.claude', 'projects', 'F--rune-bok');
const files = fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).map(f => {
  const fp = path.join(d, f);
  const st = fs.statSync(fp);
  let first = '', ver = '', uc = 0;
  const lines = fs.readFileSync(fp, 'utf-8').split('\n');
  for (const ln of lines) {
    if (ln.trim() === '') continue;
    try {
      const o = JSON.parse(ln);
      if (o.version && ver === '') ver = o.version;
      if (o.type === 'user') {
        uc++;
        if (first === '') {
          const m = o.message && o.message.content;
          if (typeof m === 'string') first = m.slice(0, 80);
          else if (Array.isArray(m)) {
            const t = m.find(c => c.type === 'text');
            if (t) first = (t.text || '').slice(0, 80);
          }
        }
      }
    } catch {}
  }
  return { n: f.replace('.jsonl', ''), mt: st.mtime, sz: st.size, first, ver, uc };
}).sort((a, b) => b.mt - a.mt);

console.log('Most recent 15 conversations in F--rune-bok:\n');
files.slice(0, 15).forEach((f, i) => {
  const h = ((Date.now() - f.mt.getTime()) / 3600000).toFixed(1);
  console.log((i + 1) + '. ' + f.n.slice(0, 8) + '... v' + f.ver + ' | ' + h + 'h ago | ' + Math.round(f.sz / 1024) + 'KB | ' + f.uc + ' user msgs');
  if (f.first) console.log('   ' + f.first.replace(/<[^>]+>/g, '').trim().slice(0, 100));
});
