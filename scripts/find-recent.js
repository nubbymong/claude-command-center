const fs = require('fs');
const path = require('path');
const os = require('os');
const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const fiveMinAgo = Date.now() - 5 * 60 * 1000;
const dirs = fs.readdirSync(projectsDir);
let found = 0;
for (const dir of dirs) {
  const fullDir = path.join(projectsDir, dir);
  if (fs.statSync(fullDir).isFile()) continue;
  const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
  for (const f of files) {
    const fp = path.join(fullDir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs > fiveMinAgo) {
      found++;
      let uc = 0, first = '', cwd = '';
      const lines = fs.readFileSync(fp, 'utf-8').split('\n');
      for (const ln of lines) {
        if (ln.trim() === '') continue;
        try {
          const o = JSON.parse(ln);
          if (o.cwd && cwd === '') cwd = o.cwd;
          if (o.type === 'user') {
            uc++;
            if (first === '') {
              const m = o.message && o.message.content;
              if (typeof m === 'string') first = m.slice(0, 120);
              else if (Array.isArray(m)) {
                const t = m.find(c => c.type === 'text');
                if (t) first = (t.text || '').replace(/<[^>]+>/g, '').trim().slice(0, 120);
              }
            }
          }
        } catch {}
      }
      const ago = Math.round((Date.now() - stat.mtimeMs) / 1000);
      console.log(dir + '/' + f.slice(0, 8) + '...');
      console.log('  ' + ago + 's ago | ' + stat.size + ' bytes | ' + uc + ' user msgs | cwd=' + cwd);
      if (first) console.log('  First: ' + first);
      console.log();
    }
  }
}
if (found === 0) console.log('No conversation files modified in the last 5 minutes');
