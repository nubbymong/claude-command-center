// Cleanup empty/tiny session files that pollute /resume
// Only removes .jsonl files with 0 user messages and < 5KB
const fs = require('fs');
const path = require('path');
const os = require('os');

const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const dirs = fs.readdirSync(projectsDir);
let totalRemoved = 0;

for (const dir of dirs) {
  const fullDir = path.join(projectsDir, dir);
  if (!fs.statSync(fullDir).isDirectory()) continue;

  const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
  for (const f of files) {
    const fp = path.join(fullDir, f);
    const stat = fs.statSync(fp);

    // Skip files > 5KB (likely have real content)
    if (stat.size > 5000) continue;

    // Count user messages
    let userCount = 0;
    let hasRealContent = false;
    const content = fs.readFileSync(fp, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user') {
          // Check if it's a real user message (not just /resume or /exit)
          const msg = obj.message && obj.message.content;
          let text = '';
          if (typeof msg === 'string') text = msg;
          else if (Array.isArray(msg)) {
            const t = msg.find(c => c.type === 'text');
            if (t) text = t.text || '';
          }
          // Skip system-generated messages
          if (text.includes('<command-name>') || text.includes('<local-command')) continue;
          userCount++;
        }
        if (obj.type === 'assistant') hasRealContent = true;
      } catch {}
    }

    if (userCount === 0 && !hasRealContent) {
      console.log('Removing: ' + dir + '/' + f + ' (' + stat.size + ' bytes)');
      fs.unlinkSync(fp);
      totalRemoved++;
    }
  }
}

console.log('\nRemoved ' + totalRemoved + ' empty session files');
