var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/probe-clear-bytes.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var dbPath = process.argv[2];
var prefix = process.argv[3] ?? "";
if (!dbPath) {
  console.error("usage: probe <dbPath> [sessionIdPrefix]");
  process.exit(1);
}
var db = new import_better_sqlite3.default(dbPath, { readonly: true, fileMustExist: true });
var sessions = db.prepare(`SELECT sessionId, status, eventCount, byteSize FROM sessions WHERE sessionId LIKE ? ORDER BY startedAt DESC LIMIT 8`).all(`${prefix}%`);
console.log("sessions matching:", sessions);
for (const s of sessions) {
  const rows = db.prepare(`SELECT seq, raw FROM events WHERE sessionId = ? ORDER BY seq`).all(s.sessionId);
  const counts = { "2J": 0, "3J": 0, RIS: 0, altOn: 0, altOff: 0 };
  let last = "";
  for (const r of rows) {
    const str = r.raw.toString("latin1");
    if (str.includes("\x1B[2J")) {
      counts["2J"]++;
      last = `2J@${r.seq}`;
    }
    if (str.includes("\x1B[3J")) {
      counts["3J"]++;
      last = `3J@${r.seq}`;
    }
    if (str.includes("\x1Bc")) {
      counts.RIS++;
      last = `RIS@${r.seq}`;
    }
    if (str.includes("\x1B[?1049h")) counts.altOn++;
    if (str.includes("\x1B[?1049l")) counts.altOff++;
  }
  console.log(`[${s.sessionId}] events=${s.eventCount} status=${s.status} erase:`, JSON.stringify(counts), "lastEraseAt:", last || "-");
}
db.close();
