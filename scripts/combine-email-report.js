#!/usr/bin/env node
/**
 * combine-email-report.js (yellow highlight for "+ --> Failing")
 * --------------------------------------------------------------
 * - Finds per-suite HTMLs in Temp (both *_latest.html and *_YYYYMMDD_HHMMSS.html)
 * - Parses folder/API execution rows (tolerates badges/spans)
 * - Aggregates totals and renders combined report (same structure as before)
 * - NEW: If any assertion name includes "+ --> Failing" (or "+ --&gt; Failing"),
 *        the corresponding API row is rendered with a yellow background.
 *
 * NOTE: No DOM structure changes—only conditional inline style on <tr>.
 */

const fs = require("fs");
const path = require("path");

// ---- Paths (edit if your root moved) ----
const ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, "..");
const TEMP_ROOT = path.join(ROOT, "Temp");
const EMAIL_ROOT = path.join(ROOT, "EmailReports");

// ---- Helpers ----
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = n => Number.isFinite(n) ? n.toLocaleString() : (n == null ? '—' : String(n));
const pctStr = (num, den) => den > 0 ? Math.round((num / den) * 100) + "%" : "0%";
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Find per-suite HTMLs under Temp ----
function findSuiteHtmls(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...findSuiteHtmls(p));
    else if (/_latest\.html$/i.test(name) || /_\d{8}_\d{6}\.html$/i.test(name)) out.push(p);
  }
  return out;
}

// ---- Meta & suite-apis extractors ----
function extractParent(htmlText) {
  return (htmlText.match(/<meta name="suite-parent" content="([^"]+)"/i) || [])[1] || "Parent";
}
function extractModule(htmlText) {
  return (htmlText.match(/<meta name="suite-module" content="([^"]+)"/i) || [])[1] || "Module";
}
function extractSuiteApis(htmlText) {
  // <script type="application/json" id="suite-apis">["Api A","Api B", ...]</script>
  const m = htmlText.match(/<script[^>]*id=["']suite-apis["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.map(s => String(s || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ---- Parse executed rows (folder/API summary) ----
function parseSuiteRows(htmlText) {
  const parent = extractParent(htmlText);
  const module = extractModule(htmlText);
  const re = /<tr[^>]*>\s*<td>(.*?)<\/td>\s*<td[^>]*>(?:<span[^>]*>)?(\d+)(?:<\/span>)?<\/td>\s*<td[^>]*>(?:<span[^>]*>)?(\d+)(?:<\/span>)?<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+(?:\.\d+)?)\s*%?\s*<\/td>\s*<td[^>]*>([\d,\.]+)\s*<\/td>\s*<\/tr>/gi;

  const rows = [];
  let m;
  while ((m = re.exec(htmlText))) {
    // First cell may contain a trailing badge; strip tags/badge & trailing counter
    let cell = m[1].replace(/<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>.*?<\/span>/gi, "");
    let api = cell.replace(/<[^>]*>/g, "").trim();
    api = api.replace(/\s+\d+$/, "");

    rows.push({
      parent,
      module,
      api,
      pass: Number(m[2]),
      fail: Number(m[3]),
      total: Number(m[4]),
      passPct: Number(m[5]),
      avg: Number(String(m[6]).replace(/,/g, ""))
    });
  }
  return rows;
}

// ---- Soft-fail detector ("+ --> Failing") ----
/**
 * Returns a Set of API names (strings) that had at least one soft assertion
 * title ending with "+ --> Failing" (or the HTML-escaped "+ --&gt; Failing")
 * in the provided per-suite HTML text.
 *
 * Strategy:
 * - Get the list of APIs from <script id="suite-apis"> if present; otherwise
 *   fall back to APIs discovered in the folder summary rows.
 * - For each API, find its <summary><b>API</b>… block and scan that section
 *   up to the next <details or end of doc for "+ --> Failing" occurrences.
 */
function detectSoftFailApis(htmlText, fallbackRows) {
  const apis = extractSuiteApis(htmlText);
  const apiList = apis.length ? apis : Array.from(new Set((fallbackRows || []).map(r => r.api).filter(Boolean)));
  const flagged = new Set();

  const SOFT = /(\+\s*-->\s*Failing|\+\s*--&gt;\s*Failing)/i;

  for (const api of apiList) {
    if (!api) continue;

    const apiRe = new RegExp(`<summary[^>]*>\\s*<b>\\s*${escapeRegExp(api)}\\s*<\\/b>[\\s\\S]*?<\\/summary>`, "i");
    const startMatch = htmlText.match(apiRe);

    if (!startMatch) {
      // As a fallback, do a crude proximity search by API name:
      const roughIdx = htmlText.toLowerCase().indexOf(`<b>${api.toLowerCase()}</b>`);
      if (roughIdx === -1) continue;

      const chunk = htmlText.slice(roughIdx, Math.min(htmlText.length, roughIdx + 30000)); // 30k chars window
      if (SOFT.test(chunk)) flagged.add(api);
      continue;
    }

    // Find the enclosing <details> section for this API summary
    const startIdx = startMatch.index || 0;
    // Look backwards to a preceding <details and forwards to next </details>
    const prevDetailsIdx = htmlText.lastIndexOf("<details", startIdx);
    const endDetailsIdx = htmlText.indexOf("</details>", startIdx);
    const section = htmlText.slice(prevDetailsIdx >= 0 ? prevDetailsIdx : startIdx,
                                   endDetailsIdx >= 0 ? endDetailsIdx : Math.min(htmlText.length, startIdx + 30000));

    if (SOFT.test(section)) flagged.add(api);
  }

  return flagged;
}

// ---- Aggregation ----
function aggregateApiStatsFromRows(rows) {
  const keyMap = new Map(); // key => {passSum, failSum, totalSum}
  for (const r of rows) {
    const key = `${r.parent}|${r.module}|${r.api}`;
    const cur = keyMap.get(key) || { passSum: 0, failSum: 0, totalSum: 0 };
    cur.passSum += r.pass || 0;
    cur.failSum += r.fail || 0;
    cur.totalSum += r.total || 0;
    keyMap.set(key, cur);
  }
  const unique = keyMap.size;
  let passed = 0;
  for (const v of keyMap.values()) if (v.totalSum > 0 && v.failSum === 0) passed += 1;
  const failed = Math.max(0, unique - passed);
  const rate = pctStr(passed, unique);
  return { unique, passed, failed, rate };
}
function aggregateCaseStats(rows) {
  let pass = 0, fail = 0, total = 0;
  for (const r of rows) {
    pass += r.pass || 0;
    fail += r.fail || 0;
    total += r.total || ((r.pass || 0) + (r.fail || 0));
  }
  const rate = pctStr(pass, total);
  return { total, pass, fail, rate };
}

// ---- Tile renderers (structure unchanged) ----
function tile(label, value, bg, border) {
  return [
    '<div class="tile" style="background:', bg, ';border:1px solid ', border, ';">',
    '<div class="lab">', esc(label), '</div>',
    '<div class="val">', esc(fmt(value)), '</div>',
    '</div>'
  ].join('');
}
function tilesAPIs(unique, passed, failed, rate) {
  return [
    '<div class="tiles">',
    tile('Unique APIs', unique, '#EFE9FF', '#D6CCFF'),
    tile('Passed APIs', passed, '#ECFDF5', '#BBF7D0'),
    tile('Failed APIs', failed, '#FFF1F2', '#FECDD3'),
    tile('Pass API %', rate, '#FEFCE8', '#FDE68A'),
    '</div>'
  ].join('');
}
function tilesCASES(total, pass, fail, rate) {
  return [
    '<div class="tiles">',
    tile('Total Test Cases', total, '#EFF6FF', '#DBEAFE'),
    tile('Passed Test Cases', pass, '#ECFDF5', '#BBF7D0'),
    tile('Failed Test Cases', fail, '#FFF1F2', '#FECDD3'),
    tile('Pass Test Case %', rate, '#FEFCE8', '#FDE68A'),
    '</div>'
  ].join('');
}

// ---- CSS (same DOM, light tweaks) ----
const FINAL_CSS = `
:root{--ink:#0f172a;--line:#e5e7eb;}
*{box-sizing:border-box}
body{font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial;background:#f8fafc;color:var(--ink);margin:0}
.wrap{max-width:1400px;margin:0 auto;padding:18px}
.header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
h1{margin:0 0 8px 0}
.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.actions button{padding:6px 10px;border:1px solid #dbeafe;background:#eff6ff;border-radius:8px;cursor:pointer}
.kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin:10px 0;position:sticky;top:.5rem;z-index:5}
.kpi h2{margin:0 0 10px 0;font-size:18px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px;margin:10px 0}
.tile{border-radius:12px;padding:14px}
.tile .lab{font-size:12px;color:#475569;margin-bottom:4px}
.tile .val{font-size:24px;font-weight:700}
.section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px;margin:14px 0}
.section h3{margin:6px 0 12px 0}
.section .controls{display:flex;gap:8px;flex-wrap:wrap}
details{border:1px solid var(--line);border-radius:10px;background:#f8fafc;margin:10px 0}
summary{padding:10px 12px;cursor:pointer;font-weight:600;list-style:none}
summary::-webkit-details-marker{display:none}
table{border-collapse:collapse;width:100%;overflow:auto;display:block}
thead,tbody,tr{display:table;width:100%;table-layout:fixed}
th,td{border:1px solid var(--line);padding:8px;text-align:left;word-wrap:break-word}
th{background:#f1f5f9}
.footer{color:#64748b;font-size:12px;margin-top:18px}
@media (max-width: 1024px){ .tiles{grid-template-columns:repeat(2,minmax(160px,1fr))} .tile .val{font-size:22px} }
@media (max-width: 640px){ .tiles{grid-template-columns:1fr} .wrap{padding:12px} .kpi{padding:12px} .tile{padding:12px} .tile .val{font-size:20px} }
@media print {.actions{display:none} table{display:table} thead,tbody,tr{display:table-row} }
`;

// ---- Build everything ----
(function main() {
  const picked = findSuiteHtmls(TEMP_ROOT);
  if (!picked.length) {
    console.log("[combine] No per-suite HTML files found in Temp.");
    return;
  }

  const allRows = [];
  const grandUniqueSet = new Set();             // union by parent|api
  const uniqueByParent = new Map();             // parent -> Set(api)
  const softFailKeySet = new Set();             // parent|module|api keys with "+ --> Failing" seen
  const softFailByParent = new Map();           // parent -> Set(api) (for convenience)

  // Parse all suite files
  for (const file of picked) {
    const html = fs.readFileSync(file, "utf8");

    const rows = parseSuiteRows(html);
    allRows.push(...rows);

    const parent = extractParent(html);
    const module = extractModule(html);

    // Determine which APIs in THIS file had "+ --> Failing"
    const softApis = detectSoftFailApis(html, rows);

    // Record into sets
    if (!softFailByParent.has(parent)) softFailByParent.set(parent, new Set());
    const setForParent = softFailByParent.get(parent);
    for (const api of softApis) setForParent.add(api);

    for (const r of rows) {
      const key = `${r.parent}|${r.module}|${r.api}`;
      if (softApis.has(r.api)) softFailKeySet.add(key);
    }

    // Unique (by parent|name) for correct counting
    const apis = extractSuiteApis(html);
    const apiList = apis.length ? apis : Array.from(new Set(rows.map(r => r.api).filter(Boolean)));
    if (!uniqueByParent.has(parent)) uniqueByParent.set(parent, new Set());
    const pset = uniqueByParent.get(parent);
    for (const a of apiList) {
      const name = String(a || "").trim();
      if (!name) continue;
      pset.add(name);
      grandUniqueSet.add(`${parent}|${name}`);
    }
  }

  // Group rows by parent for rendering
  const rowsByParent = {};
  for (const r of allRows) {
    if (!rowsByParent[r.parent]) rowsByParent[r.parent] = [];
    rowsByParent[r.parent].push(r);
  }

  // ---- GRAND tiles
  const grandApiRows = aggregateApiStatsFromRows(allRows);
  const grandUnique = grandUniqueSet.size || grandApiRows.unique;
  const grandPassed = grandApiRows.passed;
  const grandFailed = Math.max(0, grandUnique - grandPassed);
  const grandApiDisp = { unique: grandUnique, passed: grandPassed, failed: grandFailed, rate: pctStr(grandPassed, grandUnique) };
  const grandCase = aggregateCaseStats(allRows);

  // ---- PARENT sections
  const parentSections = Object.keys(rowsByParent).sort().map(parent => {
    const rows = rowsByParent[parent];

    const pApiRows = aggregateApiStatsFromRows(rows);
    const pUnique = (uniqueByParent.get(parent) || new Set()).size || pApiRows.unique;
    const pPassed = pApiRows.passed;
    const pFailed = Math.max(0, pUnique - pPassed);
    const pApiDisp = { unique: pUnique, passed: pPassed, failed: pFailed, rate: pctStr(pPassed, pUnique) };
    const pCase = aggregateCaseStats(rows);

    // by module (to render your details blocks/tables)
    const byModule = {};
    for (const r of rows) {
      if (!byModule[r.module]) byModule[r.module] = [];
      byModule[r.module].push(r);
    }

    const modulesHtml = Object.keys(byModule).sort().map(module => {
      const modRows = byModule[module];

      const tableBody = modRows.map(r => {
        const key = `${r.parent}|${module}|${r.api}`;
        const isSoft = softFailKeySet.has(key);
        const rowStyle = isSoft ? ' style="background:#FFF7C2"' : ''; // pale yellow

        return [
          `<tr${rowStyle}>`,
          `<td>${esc(r.api)}</td>`,
          `<td style="text-align:right">${fmt(r.pass)}</td>`,
          `<td style="text-align:right">${fmt(r.fail)}</td>`,
          `<td style="text-align:right">${fmt(r.total)}</td>`,
          `<td style="text-align:right">${Number.isFinite(r.passPct) ? (r.passPct + "%") : "0%"}</td>`,
          `<td style="text-align:right">${fmt(r.avg)}</td>`,
          `</tr>`
        ].join("");
      }).join("");

      return [
        '<details>',
        '<summary>', esc(module), '</summary>',
        '<div style="padding:8px 12px 12px">',
        '<table>',
        '<thead><tr>',
        '<th>API / Folder</th><th style="text-align:right">Pass</th><th style="text-align:right">Fail</th>',
        '<th style="text-align:right">Total</th><th style="text-align:right">Pass %</th><th style="text-align:right">Avg (ms)</th>',
        '</tr></thead>',
        '<tbody>', tableBody, '</tbody>',
        '</table>',
        '</div>',
        '</details>'
      ].join('');
    }).join("");

    const pid = slug(parent);
    const apiTiles = tilesAPIs(pApiDisp.unique, pApiDisp.passed, pApiDisp.failed, pApiDisp.rate);
    const caseTiles = tilesCASES(pCase.total, pCase.pass, pCase.fail, pCase.rate);

    return [
      '<section class="section" id="', pid, '">',
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">',
      '<h3>', esc(parent), ' Summary — Test Cases</h3>',
      '<div class="controls">',
      '<button data-parent="', pid, '" class="px">Expand</button>',
      '<button data-parent="', pid, '" class="pc">Collapse</button>',
      '</div>',
      '</div>',
      apiTiles,
      caseTiles,
      modulesHtml,
      '</section>'
    ].join('');
  }).join("");

  // ---- Final HTML
  const dateStr = today();
  const outDir = path.join(EMAIL_ROOT, dateStr);
  fs.mkdirSync(outDir, { recursive: true });

  const totalTiles =
    tilesAPIs(grandApiDisp.unique, grandApiDisp.passed, grandApiDisp.failed, grandApiDisp.rate) +
    tilesCASES(grandCase.total, grandCase.pass, grandCase.fail, grandCase.rate);

  const FINAL_HTML = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Digital API Automation — Combined Report</title>',
    '<style>', FINAL_CSS, '</style></head><body>',
    '<div class="wrap">',
    '<div class="header">',
    '<h1>Digital API Automation</h1>',
    '<div class="actions">',
    '<button id="expandAll">Expand all</button>',
    '<button id="collapseAll">Collapse all</button>',
    '<button onclick="window.print()">Print as PDF</button>',
    '</div>',
    '</div>',

    '<div class="kpi">',
    '<h2>Total Summary — Test Cases</h2>',
    totalTiles,
    '</div>',

    parentSections,

    '<div class="footer">Generated on ', esc(dateStr), '</div>',
    '</div>',
    '<script>',
    'document.getElementById("expandAll").addEventListener("click",()=>{document.querySelectorAll("details").forEach(d=>d.open=true);});',
    'document.getElementById("collapseAll").addEventListener("click",()=>{document.querySelectorAll("details").forEach(d=>d.open=false);});',
    'document.addEventListener("click",e=>{',
    'const t=e.target;',
    'if(t.classList.contains("px")){',
    'const id=t.getAttribute("data-parent");',
    'document.querySelectorAll("#"+CSS.escape(id)+" details").forEach(d=>d.open=true);',
    '}',
    'if(t.classList.contains("pc")){',
    'const id=t.getAttribute("data-parent");',
    'document.querySelectorAll("#"+CSS.escape(id)+" details").forEach(d=>d.open=false);',
    '}',
    '});',
    '</script>',
    '</body></html>'
  ].join('');

  fs.writeFileSync(path.join(outDir, "Digital Api Automation Report.html"), FINAL_HTML, "utf8");

  // ---- Email bodies (unchanged layout)
  const EMAIL_CSS = [
    'body{font:14px Segoe UI,Arial,sans-serif;color:#111}',
    'h1{font-size:18px;margin:0 0 10px 0}',
    'h2{font-size:16px;margin:16px 0 8px 0}',
    'table{border-collapse:collapse;width:100%}',
    'th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}',
    'th{background:#f3f4f6}'
  ].join('');

  function emailSection(title, apiStats, caseStats) {
    return [
      '<h2>', esc(title), '</h2>',
      '<table><tbody>',
      '<tr><td><b>Unique APIs</b></td><td>', fmt(apiStats.unique), '</td></tr>',
      '<tr><td><b>Passed APIs</b></td><td>', fmt(apiStats.passed), '</td></tr>',
      '<tr><td><b>Failed APIs</b></td><td>', fmt(apiStats.failed), '</td></tr>',
      '<tr><td><b>Pass API %</b></td><td>', esc(apiStats.rate), '</td></tr>',
      '</tbody></table>',
      '<br/>',
      '<table><tbody>',
      '<tr><td><b>Total Test Cases</b></td><td>', fmt(caseStats.total), '</td></tr>',
      '<tr><td><b>Passed Test Cases</b></td><td>', fmt(caseStats.pass), '</td></tr>',
      '<tr><td><b>Failed Test Cases</b></td><td>', fmt(caseStats.fail), '</td></tr>',
      '<tr><td><b>Pass Test Case %</b></td><td>', esc(caseStats.rate), '</td></tr>',
      '</tbody></table>'
    ].join('');
  }

  const emailTop =
    '<h1>Digital API Automation</h1>' +
    emailSection("Total Summary — Test Cases", grandApiDisp, grandCase) +
    Object.keys(rowsByParent).sort().map(parent => {
      const rows = rowsByParent[parent];
      const pApiRows = aggregateApiStatsFromRows(rows);
      const pUnique = (uniqueByParent.get(parent) || new Set()).size || pApiRows.unique;
      const pPassed = pApiRows.passed;
      const pFailed = Math.max(0, pUnique - pPassed);
      const pApiDisp = { unique: pUnique, passed: pPassed, failed: pFailed, rate: pctStr(pPassed, pUnique) };
      const pCase = aggregateCaseStats(rows);
      return emailSection(parent + " Summary — Test Cases", pApiDisp, pCase);
    }).join('');

  const EMAIL_HTML = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    EMAIL_CSS,
    '</style></head><body>',
    emailTop,
    '</body></html>'
  ].join('');

  fs.writeFileSync(path.join(outDir, "EmailBody.html"), EMAIL_HTML, "utf8");
  fs.writeFileSync(path.join(outDir, "EmailBody_Inline.html"), EMAIL_HTML, "utf8");

  console.log("Final + Email written ->", outDir);
})();

































// --------------------------------------------------------------------------------------------------

// #!/usr/bin/env node
// /**
//  * combine-email-report.js (patched)
//  * ---------------------------------
//  * Same HTML structure and layout as your working version, but robust to:
//  *  - _latest.html and *_YYYYMMDD_HHMMSS.html in Temp (discovery)
//  *  - <span> badges inside Pass/Fail cells (parsing)
//  *  - optional % and commas/decimals in numeric cells (parsing)
//  *  - trailing badge counts appended to API name cell (cleanup)
//  *  - grand UNIQUE counts across different parents (parent|api)
//  * Also adds small responsive tweaks to CSS (no DOM changes).
//  */

// const fs = require("fs");
// const path = require("path");

// // ---- Paths ----
// const ROOT = "C:\\\\Users\\\\user\\\\Documents\\\\NewManCollectionList";
// const TEMP_ROOT = path.join(ROOT, "Temp");
// const EMAIL_ROOT = path.join(ROOT, "EmailReports");

// // ---- Helpers ----
// const today = () => new Date().toISOString().slice(0, 10);
// const esc = s => String(s ?? '')
//   .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
//   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// const fmt = n => Number.isFinite(n) ? n.toLocaleString() : (n == null ? '—' : String(n));
// const pctStr = (num, den) => den > 0 ? Math.round((num / den) * 100) + "%" : "0%";
// const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// // ---- Find per-suite HTMLs under Temp ----
// // Include both *_latest.html and *_YYYYMMDD_HHMMSS.html
// function findSuiteHtmls(dir) {
//   const out = [];
//   if (!fs.existsSync(dir)) return out;
//   for (const name of fs.readdirSync(dir)) {
//     const p = path.join(dir, name);
//     const st = fs.statSync(p);
//     if (st.isDirectory()) out.push(...findSuiteHtmls(p));
//     else if (/_latest\.html$/i.test(name) || /_\d{8}_\d{6}\.html$/i.test(name)) out.push(p);
//   }
//   return out;
// }

// // ---- Meta & suite-apis extractors ----
// function extractParent(htmlText) {
//   return (htmlText.match(/<meta name="suite-parent" content="([^"]+)"/i) || [])[1] || "Parent";
// }
// function extractModule(htmlText) {
//   return (htmlText.match(/<meta name="suite-module" content="([^"]+)"/i) || [])[1] || "Module";
// }
// function extractSuiteApis(htmlText) {
//   // <script type="application/json" id="suite-apis">["Api A","Api B", ...]</script>
//   const m = htmlText.match(/<script[^>]*id=["']suite-apis["'][^>]*>([\s\S]*?)<\/script>/i);
//   if (!m) return [];
//   try {
//     const arr = JSON.parse(m[1]);
//     return Array.isArray(arr) ? arr.map(s => String(s || "").trim()).filter(Boolean) : [];
//   } catch {
//     return [];
//   }
// }

// // ---- Parse executed rows for pass/fail/totals ----
// // Accepts: <span> badges inside numbers, optional %, commas/decimals in the last cell
// // and rows with/without class attribute.
// function parseSuiteRows(htmlText) {
//   const parent = extractParent(htmlText);
//   const module = extractModule(htmlText);

//   const re = /<tr[^>]*>\s*<td>(.*?)<\/td>\s*<td[^>]*>(?:<span[^>]*>)?(\d+)(?:<\/span>)?<\/td>\s*<td[^>]*>(?:<span[^>]*>)?(\d+)(?:<\/span>)?<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+(?:\.\d+)?)\s*%?\s*<\/td>\s*<td[^>]*>([\d,\.]+)\s*<\/td>\s*<\/tr>/gi;


//   const rows = [];
//   let m;
//   while ((m = re.exec(htmlText))) {
//     // First cell may contain a trailing "badge" number; also may contain nested spans.
//     let cell = m[1].replace(/<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>.*?<\/span>/gi, "");
//     let api = cell.replace(/<[^>]*>/g, "").trim();
//     // Drop trailing count (e.g., "... 7" appended in the first cell)
//     api = api.replace(/\s+\d+$/, "");

//     rows.push({
//       parent,
//       module,
//       api,
//       pass: Number(m[2]),
//       fail: Number(m[3]),
//       total: Number(m[4]),
//       passPct: Number(m[5]),
//       avg: Number(String(m[6]).replace(/,/g, "")) // handle "1,540" etc.
//     });
//   }
//   return rows;
// }

// // ---- Aggregation ----
// /** API tiles from executed rows */
// function aggregateApiStatsFromRows(rows) {
//   const keyMap = new Map(); // key => {passSum, failSum, totalSum}
//   for (const r of rows) {
//     const key = `${r.parent}|${r.module}|${r.api}`;
//     const cur = keyMap.get(key) || { passSum: 0, failSum: 0, totalSum: 0 };
//     cur.passSum += r.pass || 0;
//     cur.failSum += r.fail || 0;
//     cur.totalSum += r.total || 0;
//     keyMap.set(key, cur);
//   }
//   const unique = keyMap.size;
//   let passed = 0;
//   for (const v of keyMap.values()) if (v.totalSum > 0 && v.failSum === 0) passed += 1;
//   const failed = Math.max(0, unique - passed);
//   const rate = pctStr(passed, unique);
//   return { unique, passed, failed, rate };
// }

// /** Case tiles: straight sums */
// function aggregateCaseStats(rows) {
//   let pass = 0, fail = 0, total = 0;
//   for (const r of rows) {
//     pass += r.pass || 0;
//     fail += r.fail || 0;
//     total += r.total || ((r.pass || 0) + (r.fail || 0));
//   }
//   const rate = pctStr(pass, total);
//   return { total, pass, fail, rate };
// }

// // ---- Tile renderers (HTML structure unchanged) ----
// function tile(label, value, bg, border) {
//   return [
//     '<div class="tile" style="background:', bg, ';border:1px solid ', border, ';">',
//     '<div class="lab">', esc(label), '</div>',
//     '<div class="val">', esc(fmt(value)), '</div>',
//     '</div>'
//   ].join('');
// }
// function tilesAPIs(unique, passed, failed, rate) {
//   return [
//     '<div class="tiles">',
//     tile('Unique APIs', unique, '#EFE9FF', '#D6CCFF'),
//     tile('Passed APIs', passed, '#ECFDF5', '#BBF7D0'),
//     tile('Failed APIs', failed, '#FFF1F2', '#FECDD3'),
//     tile('Pass API %', rate, '#FEFCE8', '#FDE68A'),
//     '</div>'
//   ].join('');
// }
// function tilesCASES(total, pass, fail, rate) {
//   return [
//     '<div class="tiles">',
//     tile('Total Test Cases', total, '#EFF6FF', '#DBEAFE'),
//     tile('Passed Test Cases', pass, '#ECFDF5', '#BBF7D0'),
//     tile('Failed Test Cases', fail, '#FFF1F2', '#FECDD3'),
//     tile('Pass Test Case %', rate, '#FEFCE8', '#FDE68A'),
//     '</div>'
//   ].join('');
// }

// // ---- CSS (responsive, same DOM) ----
// const FINAL_CSS = `
// :root{--ink:#0f172a;--line:#e5e7eb;}
// *{box-sizing:border-box}
// body{font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial;background:#f8fafc;color:var(--ink);margin:0}
// .wrap{max-width:1400px;margin:0 auto;padding:18px}
// .header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
// h1{margin:0 0 8px 0}
// .actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
// .actions button{padding:6px 10px;border:1px solid #dbeafe;background:#eff6ff;border-radius:8px;cursor:pointer}
// .kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin:10px 0;position:sticky;top:.5rem;z-index:5}
// .kpi h2{margin:0 0 10px 0;font-size:18px}
// .tiles{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px;margin:10px 0}
// .tile{border-radius:12px;padding:14px}
// .tile .lab{font-size:12px;color:#475569;margin-bottom:4px}
// .tile .val{font-size:24px;font-weight:700}
// .section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px;margin:14px 0}
// .section h3{margin:6px 0 12px 0}
// .section .controls{display:flex;gap:8px;flex-wrap:wrap}
// details{border:1px solid var(--line);border-radius:10px;background:#f8fafc;margin:10px 0}
// summary{padding:10px 12px;cursor:pointer;font-weight:600;list-style:none}
// summary::-webkit-details-marker{display:none}
// table{border-collapse:collapse;width:100%;overflow:auto;display:block}
// thead,tbody,tr{display:table;width:100%;table-layout:fixed}
// th,td{border:1px solid var(--line);padding:8px;text-align:left;word-wrap:break-word}
// th{background:#f1f5f9}
// .footer{color:#64748b;font-size:12px;margin-top:18px}
// @media (max-width: 1024px){ .tiles{grid-template-columns:repeat(2,minmax(160px,1fr))} .tile .val{font-size:22px} }
// @media (max-width: 640px){ .tiles{grid-template-columns:1fr} .wrap{padding:12px} .kpi{padding:12px} .tile{padding:12px} .tile .val{font-size:20px} }
// @media print {.actions{display:none} table{display:table} thead,tbody,tr{display:table-row} }
// `;

// // ---- Build everything ----
// (function main() {
//   const picked = findSuiteHtmls(TEMP_ROOT);
//   if (!picked.length) {
//     console.log("[combine] No per-suite HTML files found in Temp.");
//     return;
//   }

//   // Parse all suites
//   const allRows = [];
//   const grandUniqueSet = new Set();   // union by parent|api (prevents cross-parent collisions)
//   const uniqueByParent = new Map();   // parent -> Set(api)

//   for (const file of picked) {
//     const html = fs.readFileSync(file, "utf8");
//     const rows = parseSuiteRows(html);
//     allRows.push(...rows);

//     const parent = extractParent(html);
//     const apis = extractSuiteApis(html);
//     const apiList = apis.length ? apis : Array.from(new Set(rows.map(r => r.api).filter(Boolean)));

//     if (!uniqueByParent.has(parent)) uniqueByParent.set(parent, new Set());
//     const pset = uniqueByParent.get(parent);
//     for (const a of apiList) {
//       const name = String(a || "").trim();
//       if (!name) continue;
//       pset.add(name);
//       grandUniqueSet.add(`${parent}|${name}`);
//     }
//   }

//   // Group rows by parent for rendering tables & case sums
//   const rowsByParent = {};
//   for (const r of allRows) {
//     if (!rowsByParent[r.parent]) rowsByParent[r.parent] = [];
//     rowsByParent[r.parent].push(r);
//   }

//   // ---- GRAND tiles: Unique via union (parent|api), Passed via executed rows
//   const grandApiRows = aggregateApiStatsFromRows(allRows);
//   const grandUnique = grandUniqueSet.size || grandApiRows.unique;
//   const grandPassed = grandApiRows.passed;
//   const grandFailed = Math.max(0, grandUnique - grandPassed);
//   const grandApiDisp = { unique: grandUnique, passed: grandPassed, failed: grandFailed, rate: pctStr(grandPassed, grandUnique) };

//   const grandCase = aggregateCaseStats(allRows);

//   // ---- PARENT sections ----
//   const parentSections = Object.keys(rowsByParent).sort().map(parent => {
//     const rows = rowsByParent[parent];

//     const pApiRows = aggregateApiStatsFromRows(rows);
//     const pUnique = (uniqueByParent.get(parent) || new Set()).size || pApiRows.unique;
//     const pPassed = pApiRows.passed;
//     const pFailed = Math.max(0, pUnique - pPassed);
//     const pApiDisp = { unique: pUnique, passed: pPassed, failed: pFailed, rate: pctStr(pPassed, pUnique) };

//     const pCase = aggregateCaseStats(rows);

//     // Group by module (for tables)
//     const byModule = {};
//     for (const r of rows) {
//       if (!byModule[r.module]) byModule[r.module] = [];
//       byModule[r.module].push(r);
//     }

//     const modulesHtml = Object.keys(byModule).sort().map(module => {
//       const modRows = byModule[module];
//       const tableBody = modRows.map(r => (
//         `<tr>
//           <td>${esc(r.api)}</td>
//           <td style="text-align:right">${fmt(r.pass)}</td>
//           <td style="text-align:right">${fmt(r.fail)}</td>
//           <td style="text-align:right">${fmt(r.total)}</td>
//           <td style="text-align:right">${Number.isFinite(r.passPct) ? (r.passPct + "%") : "0%"}</td>
//           <td style="text-align:right">${fmt(r.avg)}</td>
//         </tr>`
//       )).join("");

//       return [
//         '<details>',
//         '<summary>', esc(module), '</summary>',
//         '<div style="padding:8px 12px 12px">',
//         '<table>',
//         '<thead><tr>',
//         '<th>API / Folder</th><th style="text-align:right">Pass</th><th style="text-align:right">Fail</th>',
//         '<th style="text-align:right">Total</th><th style="text-align:right">Pass %</th><th style="text-align:right">Avg (ms)</th>',
//         '</tr></thead>',
//         '<tbody>', tableBody, '</tbody>',
//         '</table>',
//         '</div>',
//         '</details>'
//       ].join('');
//     }).join("");

//     const pid = slug(parent);
//     const apiTiles = tilesAPIs(pApiDisp.unique, pApiDisp.passed, pApiDisp.failed, pApiDisp.rate);
//     const caseTiles = tilesCASES(pCase.total, pCase.pass, pCase.fail, pCase.rate);

//     return [
//       '<section class="section" id="', pid, '">',
//       '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">',
//       '<h3>', esc(parent), ' Summary — Test Cases</h3>',
//       '<div class="controls">',
//       '<button data-parent="', pid, '" class="px">Expand</button>',
//       '<button data-parent="', pid, '" class="pc">Collapse</button>',
//       '</div>',
//       '</div>',
//       apiTiles,
//       caseTiles,
//       modulesHtml,
//       '</section>'
//     ].join('');
//   }).join("");

//   // ---- Final HTML (structure unchanged) ----
//   const dateStr = today();
//   const outDir = path.join(EMAIL_ROOT, dateStr);
//   fs.mkdirSync(outDir, { recursive: true });

//   const totalTiles =
//     tilesAPIs(grandApiDisp.unique, grandApiDisp.passed, grandApiDisp.failed, grandApiDisp.rate) +
//     tilesCASES(grandCase.total, grandCase.pass, grandCase.fail, grandCase.rate);

//   const FINAL_HTML = [
//     '<!doctype html><html><head><meta charset="utf-8">',
//     '<meta name="viewport" content="width=device-width, initial-scale=1">',
//     '<title>Digital API Automation — Combined Report</title>',
//     '<style>', FINAL_CSS, '</style></head><body>',
//     '<div class="wrap">',
//     '<div class="header">',
//     '<h1>Digital API Automation</h1>',
//     '<div class="actions">',
//     '<button id="expandAll">Expand all</button>',
//     '<button id="collapseAll">Collapse all</button>',
//     '<button onclick="window.print()">Print as PDF</button>',
//     '</div>',
//     '</div>',

//     '<div class="kpi">',
//     '<h2>Total Summary — Test Cases</h2>',
//     totalTiles,
//     '</div>',

//     parentSections,

//     '<div class="footer">Generated on ', esc(dateStr), '</div>',
//     '</div>',
//     '<script>',
//     'document.getElementById("expandAll").addEventListener("click",()=>{document.querySelectorAll("details").forEach(d=>d.open=true);});',
//     'document.getElementById("collapseAll").addEventListener("click",()=>{document.querySelectorAll("details").forEach(d=>d.open=false);});',
//     'document.addEventListener("click",e=>{',
//     'const t=e.target;',
//     'if(t.classList.contains("px")){',
//     'const id=t.getAttribute("data-parent");',
//     'document.querySelectorAll("#"+CSS.escape(id)+" details").forEach(d=>d.open=true);',
//     '}',
//     'if(t.classList.contains("pc")){',
//     'const id=t.getAttribute("data-parent");',
//     'document.querySelectorAll("#"+CSS.escape(id)+" details").forEach(d=>d.open=false);',
//     '}',
//     '});',
//     '</script>',
//     '</body></html>'
//   ].join('');

//   fs.writeFileSync(path.join(outDir, "Digital Api Automation Report.html"), FINAL_HTML, "utf8");

//   // ---- Email bodies (unchanged) ----
//   const EMAIL_CSS = [
//     'body{font:14px Segoe UI,Arial,sans-serif;color:#111}',
//     'h1{font-size:18px;margin:0 0 10px 0}',
//     'h2{font-size:16px;margin:16px 0 8px 0}',
//     'table{border-collapse:collapse;width:100%}',
//     'th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}',
//     'th{background:#f3f4f6}'
//   ].join('');

//   function emailSection(title, apiStats, caseStats) {
//     return [
//       '<h2>', esc(title), '</h2>',
//       '<table><tbody>',
//       '<tr><td><b>Unique APIs</b></td><td>', fmt(apiStats.unique), '</td></tr>',
//       '<tr><td><b>Passed APIs</b></td><td>', fmt(apiStats.passed), '</td></tr>',
//       '<tr><td><b>Failed APIs</b></td><td>', fmt(apiStats.failed), '</td></tr>',
//       '<tr><td><b>Pass API %</b></td><td>', esc(apiStats.rate), '</td></tr>',
//       '</tbody></table>',
//       '<br/>',
//       '<table><tbody>',
//       '<tr><td><b>Total Test Cases</b></td><td>', fmt(caseStats.total), '</td></tr>',
//       '<tr><td><b>Passed Test Cases</b></td><td>', fmt(caseStats.pass), '</td></tr>',
//       '<tr><td><b>Failed Test Cases</b></td><td>', fmt(caseStats.fail), '</td></tr>',
//       '<tr><td><b>Pass Test Case %</b></td><td>', esc(caseStats.rate), '</td></tr>',
//       '</tbody></table>'
//     ].join('');
//   }

//   const emailTop =
//     '<h1>Digital API Automation</h1>' +
//     emailSection("Total Summary — Test Cases", grandApiDisp, grandCase) +
//     Object.keys(rowsByParent).sort().map(parent => {
//       const rows = rowsByParent[parent];
//       const pApiRows = aggregateApiStatsFromRows(rows);
//       const pUnique = (uniqueByParent.get(parent) || new Set()).size || pApiRows.unique;
//       const pPassed = pApiRows.passed;
//       const pFailed = Math.max(0, pUnique - pPassed);
//       const pApiDisp = { unique: pUnique, passed: pPassed, failed: pFailed, rate: pctStr(pPassed, pUnique) };
//       const pCase = aggregateCaseStats(rows);
//       return emailSection(parent + " Summary — Test Cases", pApiDisp, pCase);
//     }).join('');

//   const EMAIL_HTML = [
//     '<!doctype html><html><head><meta charset="utf-8"><style>',
//     EMAIL_CSS,
//     '</style></head><body>',
//     emailTop,
//     '</body></html>'
//   ].join('');

//   fs.writeFileSync(path.join(outDir, "EmailBody.html"), EMAIL_HTML, "utf8");
//   fs.writeFileSync(path.join(outDir, "EmailBody_Inline.html"), EMAIL_HTML, "utf8");

//   console.log("Final + Email written ->", outDir);
// })();











