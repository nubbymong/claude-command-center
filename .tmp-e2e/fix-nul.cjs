const fs = require('fs')
const p = 'src/renderer/lib/replay-sanitizer.ts'
let c = fs.readFileSync(p, 'utf8')
const nul = String.fromCharCode(0)
const count = c.split(nul).length - 1
c = c.split(nul).join('\\u0000')
fs.writeFileSync(p, c)
console.log('replaced', count, 'literal NUL(s) with \\u0000 escape notation')
