/**
 * Extract localStorage data from Chrome/Electron LevelDB backup.
 * Handles both UTF-8 and UTF-16LE encoded values.
 */

const fs = require('fs');
const path = require('path');

const dir = 'F:/CLAUDE_MULTI_APP_RESOURCES/CONFIG/backup-20260210/electron-userData/Local Storage/leveldb';
const outputDir = 'F:/CLAUDE_MULTI_APP_RESOURCES/CONFIG';

const found = {};

/**
 * Extract a UTF-16LE JSON value starting at the given offset.
 * Reads balanced brackets/braces.
 */
function extractUtf16LeJson(data, offset) {
  let end = offset;
  let braceDepth = 0;
  let bracketDepth = 0;

  while (end + 1 < data.length) {
    const lo = data[end];
    const hi = data[end + 1];

    if (hi === 0x00 && lo === 0x5B) bracketDepth++;
    if (hi === 0x00 && lo === 0x5D) bracketDepth--;
    if (hi === 0x00 && lo === 0x7B) braceDepth++;
    if (hi === 0x00 && lo === 0x7D) braceDepth--;

    // Accept any BMP character (below surrogate range)
    if (hi < 0xD8) {
      end += 2;
    } else {
      break;
    }

    // If balanced, we're done
    if (braceDepth === 0 && bracketDepth === 0 && end > offset + 2) {
      break;
    }
  }

  return data.slice(offset, end).toString('utf16le');
}

/**
 * Extract a UTF-8 JSON value starting at the given offset.
 * Reads balanced brackets/braces.
 */
function extractUtf8Json(data, offset) {
  let end = offset;
  let braceDepth = 0;
  let bracketDepth = 0;

  while (end < data.length) {
    const c = data[end];
    if (c === 0x5B) bracketDepth++;
    if (c === 0x5D) bracketDepth--;
    if (c === 0x7B) braceDepth++;
    if (c === 0x7D) braceDepth--;
    end++;

    if (braceDepth === 0 && bracketDepth === 0 && end > offset + 1) {
      break;
    }
  }

  return data.slice(offset, end).toString('utf-8');
}

// Read all LevelDB data files
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ldb') || f.endsWith('.log'));

const KEYS_WE_WANT = [
  'claude-multi-commands',
  'claude-multi-configs',
  'claude-multi-config-groups',
  'claude-multi-config-sections',
  'claude-multi-settings',
  'claude-multi-magic-buttons',
];

for (const f of files) {
  const data = fs.readFileSync(path.join(dir, f));

  for (const key of KEYS_WE_WANT) {
    if (found[key]) continue;

    const keyBytes = Buffer.from(key, 'utf-8');
    // Find all occurrences, try each one (last one is most recent in .log, first in .ldb)
    let pos = 0;
    const indices = [];
    while (pos < data.length) {
      const idx = data.indexOf(keyBytes, pos);
      if (idx === -1) break;
      indices.push(idx);
      pos = idx + 1;
    }

    // Try each occurrence
    for (const idx of indices) {
      if (found[key]) break;

      const afterKey = idx + keyBytes.length;

      // Scan forward looking for JSON start
      for (let probe = afterKey; probe < Math.min(afterKey + 20, data.length - 1); probe++) {
        const b0 = data[probe];
        const b1 = data[probe + 1];

        // UTF-16LE JSON: [ or { followed by 0x00
        if ((b0 === 0x5B || b0 === 0x7B) && b1 === 0x00) {
          const value = extractUtf16LeJson(data, probe);
          try {
            JSON.parse(value);
            found[key] = value;
            console.log(`Found ${key} in ${f} (UTF-16LE, ${value.length} chars)`);
            break;
          } catch {}
        }

        // UTF-8 JSON: [ or { NOT followed by 0x00
        if ((b0 === 0x5B || b0 === 0x7B) && b1 !== 0x00) {
          const value = extractUtf8Json(data, probe);
          try {
            JSON.parse(value);
            found[key] = value;
            console.log(`Found ${key} in ${f} (UTF-8, ${value.length} chars)`);
            break;
          } catch {}
        }
      }
    }
  }
}

// Report
console.log('\n--- Results ---');
for (const key of KEYS_WE_WANT) {
  if (found[key]) {
    const parsed = JSON.parse(found[key]);
    console.log(`  OK: ${key} (${Array.isArray(parsed) ? parsed.length + ' items' : 'object'})`);
  } else {
    console.log(`  MISSING: ${key}`);
  }
}

// Write config files
console.log('\n--- Writing CONFIG files ---');

const mapping = {
  'claude-multi-commands': 'commands.json',
  'claude-multi-configs': 'configs.json',
  'claude-multi-config-groups': 'config-groups.json',
  'claude-multi-config-sections': 'config-sections.json',
  'claude-multi-settings': 'settings.json',
  'claude-multi-magic-buttons': 'magic-buttons.json',
};

for (const [lsKey, fileName] of Object.entries(mapping)) {
  if (found[lsKey]) {
    const parsed = JSON.parse(found[lsKey]);
    fs.writeFileSync(path.join(outputDir, fileName), JSON.stringify(parsed, null, 2));
    console.log(`  Wrote ${fileName}`);
  } else {
    console.log(`  SKIP ${fileName}`);
  }
}

// Config sections was Snappy-compressed in LDB — reconstruct from config references
if (!found['claude-multi-config-sections']) {
  console.log('  Reconstructing config-sections.json from config sectionId references...');
  const configs = JSON.parse(found['claude-multi-configs'] || '[]');
  const sectionIds = [...new Set(configs.map(c => c.sectionId).filter(Boolean))];

  // Known section names from partially-decoded LDB data
  const sectionNames = {
    'mldi7ofpqv1u': 'Raspberry Pis',
    'mldia70x51yu': 'Conductor Dev',
    'mldiaqhkd4hp': 'Servers',
  };

  const sections = sectionIds.map(id => ({
    id,
    name: sectionNames[id] || id,
  }));

  fs.writeFileSync(path.join(outputDir, 'config-sections.json'), JSON.stringify(sections, null, 2));
  console.log(`  Wrote config-sections.json (${sections.length} sections, reconstructed)`);
}

// Write app-meta.json
const appMeta = {
  setupVersion: '1.2.59',
  lastSeenVersion: '1.2.59',
  commandsSeeded: true,
  colorMigrated: true,
};
fs.writeFileSync(path.join(outputDir, 'app-meta.json'), JSON.stringify(appMeta, null, 2));
console.log('  Wrote app-meta.json');

// Copy userData files
console.log('\n--- Copying userData files ---');
const userDataDir = 'F:/CLAUDE_MULTI_APP_RESOURCES/CONFIG/backup-20260210/electron-userData';

for (const file of ['session-state.json', 'window-state.json', 'ssh-credentials.json']) {
  const src = path.join(userDataDir, file);
  const dest = path.join(outputDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  Copied ${file}`);
  }
}

// Write default settings and magic-buttons if not found
if (!found['claude-multi-settings']) {
  const defaults = { defaultModel: 'sonnet', defaultWorkingDirectory: '', terminalFontSize: 14, debugMode: false };
  fs.writeFileSync(path.join(outputDir, 'settings.json'), JSON.stringify(defaults, null, 2));
  console.log('  Wrote settings.json (defaults)');
}
if (!found['claude-multi-magic-buttons']) {
  const defaults = { screenshotColor: '#00FFFF', autoDeleteDays: null };
  fs.writeFileSync(path.join(outputDir, 'magic-buttons.json'), JSON.stringify(defaults, null, 2));
  console.log('  Wrote magic-buttons.json (defaults)');
}

console.log('\n--- Final CONFIG/ contents ---');
const configFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.json'));
for (const f of configFiles) {
  const stat = fs.statSync(path.join(outputDir, f));
  console.log(`  ${f} (${stat.size} bytes)`);
}

console.log('\nDone!');
