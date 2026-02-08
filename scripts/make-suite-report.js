#!/usr/bin/env node
/**
 * make-business-summary.js — FINAL (tiles + single combined report, no trends)
 *
 * 1) Build per-suite HTML to OLD path (<output-html>) with inline expand + modals
 * 2) Save temp copy per Parent/Module:
 *      C:\Users\user\Documents\NewManCollectionList\Temp\<Parent>\<Module>_latest.html
 *    …and embed a hidden JSON list of that suite’s API names for the combiner.
 * 3) Combine ALL *_latest.html temps into ONE final file (overwrite):
 *      C:\Users\user\Documents\NewManCollectionList\EmailReports\Digital Api Automation Report.html
 *    Includes:
 *      - Header KPI tiles: Total / Passed / Failed / Pass % / Unique APIs
 *      - Summary bar chart: Total / Passed / Failed
 */

const fs = require("fs");
const path = require("path");

// ===== Root Paths =====
const ROOT       = process.env.PROJECT_ROOT || path.resolve(__dirname, "..");
const TEMP_ROOT  = path.join(ROOT, "Temp");
const EMAIL_ROOT = path.join(ROOT, "EmailReports");

// ===== Args =====
const [, , inFile, outFile, titleArg, slaArg] = process.argv;
if (!inFile || !outFile) {
  console.error("Usage: node make-business-summary.js <input-json> <output-html> [title] [slaMs]");
  process.exit(1);
}
const TITLE  = titleArg || "Digital API Automation";
const SLA_MS = Number.isFinite(parseInt(slaArg, 10)) ? parseInt(slaArg, 10) : 1000;

// ===== Load Newman JSON =====
let data;
try { data = JSON.parse(fs.readFileSync(inFile, "utf8")); }
catch (e) { console.error("❌ Failed to read/parse input JSON:", inFile, e.message); process.exit(1); }

const execs      = data?.run?.executions || [];
const collection = data?.collection || {};
const startedAt  = data?.run?.timings?.started || data?.timestamp || new Date().toISOString();

// ===== Helpers =====
const avg  = a => a.length ? Math.round(a.reduce((x,y)=>x+y,0)/a.length) : 0;
const fmt  = n => Number.isFinite(n) ? n.toLocaleString() : (n==null?'—':String(n));
const esc  = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const idfy = s => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
const pretty = s => String(s||'').replace(/^SC_\d+_/,'').replace(/_/g,' ').trim() || 'Untitled';

function deriveParentFromPath(p){
  const segs = String(path.resolve(p)).split(/[\\/]+/);
  const i = segs.findIndex(x => /newmancollectionlist/i.test(x));
  return (i>=0 && segs[i+1]) ? segs[i+1] : "Misc";
}
function deriveModuleFromPath(p){
  const segs = String(path.resolve(p)).split(/[\\/]+/);
  const i = segs.findIndex(x => /newmancollectionlist/i.test(x));
  return (i>=0 && segs[i+2]) ? segs[i+2] : (collection?.info?.name?.split("-").pop()?.trim() || "Module");
}
const SUITE_PARENT = deriveParentFromPath(outFile);
const SUITE_MODULE = deriveModuleFromPath(outFile);

// Request/Response helpers
function buildUrl(u) {
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (u.raw) return u.raw;
  const proto = u.protocol ? u.protocol + '://' : '';
  const host  = Array.isArray(u.host) ? u.host.join('.') : (u.host||'');
  const pth   = Array.isArray(u.path) ? '/' + u.path.join('/') : (u.path?('/'+u.path):'');
  return proto + host + pth;
}
function headersToObj(h) {
  if (!h) return {};
  let arr = [];
  if (Array.isArray(h)) arr = h;
  else if (Array.isArray(h.members)) arr = h.members;
  else if (Array.isArray(h.header)) arr = h.header;
  else if (Array.isArray(h.headers)) arr = h.headers;
  const out = {};
  for (const it of arr) {
    if (!it || it.disabled) continue;
    const k = it.key ?? it.name;
    if (!k) continue;
    const v = it.value ?? it.val ?? it.description ?? '';
    out[String(k)] = String(v);
  }
  return out;
}
function bodyFromRequest(b) {
  if (!b) return '';
  const mode = b.mode || (b.raw ? 'raw' : null);
  if (mode === 'raw') return String(b.raw ?? '');
  if (mode === 'urlencoded') return (b.urlencoded||[]).map(p=>`${p.key}=${p.value}`).join('&');
  if (mode === 'formdata') return (b.formdata||[]).map(p=>`${p.key}=${p.value}`).join('\n');
  try { return JSON.stringify(b[mode] ?? b); } catch { return String(b); }
}
function parseJsonOrText(body) {
  if (body == null) return '';
  if (typeof body === 'object') return body;
  const str = String(body).trim();
  if (!str) return '';
  try { return JSON.parse(str); } catch { return str; }
}
function respBody(res) {
  if (!res) return '';
  if (typeof res.text === 'string') return res.text;
  if (typeof res.body === 'string') return res.body;
  if (res.stream && Array.isArray(res.stream.data)) {
    try { return Buffer.from(res.stream.data).toString('utf8'); } catch {}
  }
  return '';
}

// ===== Build test cases =====
const testCases = execs.map(ex => {
  const assertions = ex?.assertions || [];
  const total  = assertions.length;
  const failed = assertions.filter(a=>a.error).length;
  const passed = total - failed;

  const statusCode = ex?.response?.code ?? '';
  const respMs     = Number.isFinite(ex?.response?.responseTime) ? ex.response.responseTime : null;

  const checks = assertions.map(a=>({
    name: a.assertion || a.error?.test || a.error?.name || 'Assertion',
    ok: !a.error,
    message: a.error ? String(a.error?.message||a.error?.stack||'').trim() : 'OK'
  }));
  const isSkip = checks.some(c => /\bskip\b/i.test(c.name) || /\bskip\b/i.test(c.message));
  let result;
  if (!ex)           result = 'Not Run';
  else if (isSkip)   result = 'Skipped';
  else if (failed>0) result = 'Fail';
  else               result = 'Pass';

  // group by first path segment in item name
  const group = (ex?.item?.name || 'Request').split('/')[0] || 'Ungrouped';
  const api   = ex?.item?.name || 'Request';

  const req  = ex?.request || {};
  const res  = ex?.response || {};
  const reqObj = {
    method : req.method || '',
    url    : buildUrl(req.url),
    headers: headersToObj(req.header || req.headers || req),
    body   : parseJsonOrText(bodyFromRequest(req.body))
  };
  const resObj = {
    code   : res.code ?? '',
    status : res.status ?? '',
    headers: headersToObj(res.header),
    body   : parseJsonOrText(respBody(res))
  };
  const reqB64 = Buffer.from(JSON.stringify(reqObj),'utf8').toString('base64');
  const resB64 = Buffer.from(JSON.stringify(resObj),'utf8').toString('base64');

  return {
    id: idfy(`${api}-${(ex?.cursor?.iteration ?? 0)+1}`),
    group, api,
    iteration: (ex?.cursor?.iteration ?? 0)+1,
    tcId: 'TC' + String((ex?.cursor?.iteration ?? 0)+1).padStart(3,'0'),
    result, checksPassed: passed, checksFailed: failed, checksTotal: total,
    statusCode, respMs, checks, reqB64, resB64
  };
});

// ===== Aggregations =====
const considered = testCases.filter(tc => tc.result==='Pass' || tc.result==='Fail');
const totalCases = considered.length;
const passedCases= considered.filter(t=>t.result==='Pass').length;
const failedCases= considered.filter(t=>t.result==='Fail').length;
const passPct    = totalCases?Math.round(100*passedCases/totalCases):0;
const withinSLA  = considered.filter(t=>Number.isFinite(t.respMs)&&t.respMs<=SLA_MS).length;
const withinPct  = totalCases?Math.round(100*withinSLA/totalCases):0;

// Folders
const byFolder = new Map();
for (const tc of considered) {
  const g = tc.group || 'Ungrouped';
  const a = byFolder.get(g) || { group:g, total:0, pass:0, fail:0, resp:[], apis:[] };
  a.total++; if (tc.result==='Pass') a.pass++; else a.fail++;
  if (Number.isFinite(tc.respMs)) a.resp.push(tc.respMs);
  a.apis.push(tc);
  byFolder.set(g,a);
}
const folderRows = Array.from(byFolder.values()).map(r => ({
  group:r.group, pretty:pretty(r.group),
  total:r.total, pass:r.pass, fail:r.fail,
  passPct: r.total ? Math.round(100*r.pass/r.total) : 0,
  avgMs: avg(r.resp),
  apis: r.apis
})).sort((a,b)=>a.pretty.localeCompare(b.pretty));

// Folder -> API -> cases for inline list, and suite-unique APIs
const folderToApiMap = new Map();
const suiteApiSet = new Set();
for (const tc of considered) {
  const g = tc.group || 'Ungrouped';
  const api = tc.api || 'Request';
  suiteApiSet.add(pretty(api));
  const entry = folderToApiMap.get(g) || new Map();
  const cases = entry.get(api) || [];
  cases.push(tc);
  entry.set(api, cases);
  folderToApiMap.set(g, entry);
}
function buildApiSummaryForFolder(folderName){
  const executedMap = folderToApiMap.get(folderName) || new Map();
  return [...executedMap.entries()].map(([api, cases])=>{
    const pass = cases.filter(c=>c.result==='Pass').length;
    const fail = cases.filter(c=>c.result==='Fail').length;
    const tot  = pass + fail;
    const pct  = tot ? Math.round(100*pass/tot) : 0;
    return { api, pretty: pretty(api), pass, fail, tot, pct };
  });
}
const API_SUMMARY = Object.fromEntries(
  folderRows.map(fr => [fr.group, buildApiSummaryForFolder(fr.group)])
);

// ===== Per-suite HTML =====
const css = `
:root{
  --bg:#f7f8fc; --card:#fff; --text:#0f172a; --muted:#6b7280; --line:#e5e7eb;
  --ok:#166534; --ng:#991b1b; --accent:#3b82f6;
}
*{box-sizing:border-box}
body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;background:var(--bg);color:var(--text)}
h1{margin:0 0 6px;font-size:34px}
small{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin:16px 0}
@media(max-width:1200px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:760px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.kpi b{display:block;font-size:28px}
.kpi span{color:var(--muted)}
.card{border:1px solid var(--line);border-radius:16px;padding:16px;margin:16px 0;background:var(--card)}
.canvas-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
@media(max-width:1100px){.canvas-row{grid-template-columns:1fr}}
.chart-box{border:1px solid var(--line);border-radius:16px;padding:10px;background:#fff}
table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden}
th,td{border-bottom:1px solid var(--line);padding:12px 14px;text-align:left;vertical-align:top}
th{background:#f3f4f6}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
.badge.pass{background:#dcfce7;color:var(--ok)}
.badge.fail{background:#fee2e2;color:var(--ng)}
/* Inline expand card */
tr.subrow td{background:#f9fafb;border-top:none;padding:0}
.expand-card{
  background:#fff;border:1px solid var(--line);border-radius:16px;
  margin:10px 0;padding:12px 16px;box-shadow:0 1px 3px rgba(0,0,0,.05)
}
.api-chip{
  display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);
  border-radius:999px;padding:6px 10px;margin:6px 8px 0 0;background:#fdfdfd
}
.api-chip b{font-weight:600}
.api-chip .muted{font-size:12px;color:var(--muted)}
/* Details + modal */
details{margin:10px 0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
summary{cursor:pointer;padding:12px 14px;background:#f8fafc;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
summary button{margin-left:auto}
.block{padding:12px;border-top:1px solid var(--line)}
.muted{color:var(--muted)}
.modal{position:fixed;inset:0;display:none}
.modal.show{display:block}
.modal .backdrop{position:absolute;inset:0;background:rgba(0,0,0,.35)}
.modal .dialog{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  width:min(940px,92vw);max-height:85vh;background:#fff;border-radius:14px;
  border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.2);
  display:flex;flex-direction:column;overflow:hidden
}
.modal .head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}
.modal .head h4{margin:0;font-size:16px}
.modal .head .x{border:none;background:transparent;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}
.modal .body{padding:12px;overflow:auto}
.modal pre{white-space:pre-wrap;word-wrap:break-word;background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:12px;margin:0}
`;

const html = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="suite-parent" content="${esc(SUITE_PARENT)}"/>
<meta name="suite-module" content="${esc(SUITE_MODULE)}"/>
<title>${esc(TITLE)}</title>
<style>${css}</style>
</head>
<body>
  <h1>${esc(TITLE)}</h1>
  <small>Generated: ${new Date(startedAt).toLocaleString()}</small>

  <div class="kpis">
    <div class="kpi"><b>${fmt(passPct)}%</b><span>Pass Rate</span></div>
    <div class="kpi"><b>${fmt(totalCases)}</b><span>Total Test Cases</span></div>
    <div class="kpi"><b>${fmt(passedCases)}</b><span>Passed</span></div>
    <div class="kpi"><b>${fmt(failedCases)}</b><span>Failed</span></div>
    <div class="kpi"><b>${fmt(withinPct)}%</b><span>Within SLA (${fmt(SLA_MS)} ms)</span></div>
  </div>

  <div class="card">
    <div class="canvas-row">
      <div class="chart-box"><canvas id="barPass"></canvas></div>
      <div class="chart-box"><canvas id="barResp"></canvas></div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px">Consolidated by <b>Folder</b></h3>
    <table id="tbl">
      <thead>
        <tr>
          <th>Folder</th>
          <th>Passed</th>
          <th>Failed</th>
          <th>Total</th>
          <th>Pass %</th>
          <th>Avg Resp (ms)</th>
        </tr>
      </thead>
      <tbody>
        ${folderRows.map(r => {
          const fid = 'folder-' + idfy(r.group);
          return `
            <tr class="clickable" data-row="${fid}" data-folder="${esc(r.group)}">
              <td>${esc(r.pretty)} <span class="badge">${r.apis.length}</span></td>
              <td><span class="badge pass">${fmt(r.pass)}</span></td>
              <td><span class="badge fail">${fmt(r.fail)}</span></td>
              <td>${fmt(r.total)}</td>
              <td>${fmt(r.passPct)}%</td>
              <td>${fmt(r.avgMs)}</td>
            </tr>
            <tr class="subrow" id="sub-${fid}" style="display:none">
              <td colspan="6">
                <div class="expand-card" id="box-${fid}">
                  <span class="muted">Loading…</span>
                </div>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px">Folder-wise Execution Details (APIs & Checks)</h3>
    ${
      folderRows.length
        ? folderRows.map(fr => {
            const apimap = fr.apis.reduce((m,tc)=>{ (m[tc.api]=m[tc.api]||[]).push(tc); return m; },{});
            const apiNames = Object.keys(apimap).sort((a,b)=>pretty(a).localeCompare(pretty(b)));
            return (
              '<details id="folder-'+idfy(fr.group)+'">' +
                '<summary><b>' + esc(pretty(fr.group)) + '</b> — ' + apiNames.length + ' API(s)</summary>' +
                apiNames.map(apiName => {
                  const cases = (apimap[apiName] || []).sort((a,b)=>a.iteration-b.iteration);
                  const passCnt = cases.filter(c=>c.result==='Pass').length;
                  const failCnt = cases.filter(c=>c.result==='Fail').length;
                  return (
                    '<details id="api-' + idfy(fr.group + '-' + apiName) + '" style="margin:8px 12px">' +
                      '<summary><b>'+esc(pretty(apiName))+'</b> — ' + cases.length + ' case(s) · '+
                        '<span class="badge pass">'+passCnt+'</span> '+
                        '<span class="badge fail">'+failCnt+'</span></summary>' +
                      cases.map(tc =>
                        '<div class="block" id="'+tc.id+'">' +
                          '<div>' +
                            '<span class="badge ' + (tc.result==='Pass' ? 'pass' : 'fail') + '">' + tc.result.toUpperCase() + '</span> ' +
                            '<b>' + tc.tcId + '-' + esc(pretty(apiName)) + '</b> ' +
                            (tc.statusCode ? '· <b>Status:</b> ' + tc.statusCode + ' ' : '') +
                            (Number.isFinite(tc.respMs) ? '· <b>Resp:</b> ' + fmt(tc.respMs) + ' ms ' : '') +
                            '<button class="btn-mini" data-open="req" data-for="' + tc.id + '">View Request</button>' +
                            ' <button class="btn-mini" data-open="res" data-for="' + tc.id + '">View Response</button>' +
                          '</div>' +
                          '<script type="application/json" id="payload-req-' + tc.id + '">' + tc.reqB64 + '</script>' +
                          '<script type="application/json" id="payload-res-' + tc.id + '">' + tc.resB64 + '</script>' +
                          '<div><b>Checks:</b> ' + fmt(tc.checksPassed) + ' / ' + fmt(tc.checksTotal) + '</div>' +
                          (
                            tc.checks.length
                              ? ('<table class="checks"><thead><tr><th>#</th><th>Assertion</th><th>Status</th><th>Message</th></tr></thead><tbody>'+
                                  tc.checks.map((c,i)=>'<tr class="'+(c.ok?'ok':'ng')+'"><td>'+ (i+1) +'</td><td>'+esc(c.name)+'</td><td>'+(c.ok?'PASS':'FAIL')+'</td><td>'+esc(c.ok?'OK':c.message)+'</td></tr>').join('')+
                                 '</tbody></table>')
                              : '<div class="muted">— no assertions —</div>'
                          ) +
                        '</div>'
                      ).join('') +
                    '</details>'
                  );
                }).join('') +
              '</details>'
            );
          }).join('')
        : '<div class="muted">No folders found.</div>'
    }
  </div>

  <!-- Hidden JSON: suite API list (for combiner unique count) -->
  <script type="application/json" id="suite-apis">${JSON.stringify([...suiteApiSet])}</script>

  <!-- Modal -->
  <div class="modal" id="modal">
    <div class="backdrop" data-close="1"></div>
    <div class="dialog">
      <div class="head">
        <h4 id="mTitle">Payload</h4>
        <button class="x" data-close="1" aria-label="Close">×</button>
      </div>
      <div class="body">
        <pre id="mPre"></pre>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
  const DATA = ${JSON.stringify({
    labels: folderRows.map(r => pretty(r.group)),
    passPct: folderRows.map(r => r.passPct),
    avgMs: folderRows.map(r => r.avgMs)
  })};
  const API_SUMMARY = ${JSON.stringify(API_SUMMARY)};

  function computeChartHeight(labelCount){
    const basePerLabel = Math.max(18, Math.min(28, Math.round(window.innerHeight / 45)));
    const minH = 220;
    const maxH = Math.round(window.innerHeight * 0.6);
    return Math.max(minH, Math.min(maxH, basePerLabel * Math.max(4, labelCount)));
  }
  function trunc(s){
    if(!s) return s;
    const max = window.innerWidth < 700 ? 10 : (window.innerWidth < 1100 ? 18 : 26);
    return s.length > max ? s.slice(0, max-1) + '…' : s;
  }
  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

  let chartPass = null, chartResp = null;
  function buildCharts(){
    const labels = DATA.labels || [];
    const h = computeChartHeight(labels.length);
    const c1 = document.getElementById('barPass');
    const c2 = document.getElementById('barResp');
    if (c1) c1.style.height = h + 'px';
    if (c2) c2.style.height = h + 'px';

    const common = (title, max) => ({
      indexAxis: 'y',
      maintainAspectRatio: false,
      responsive: true,
      scales: {
        x: { beginAtZero: true, max, grid: { display:false } },
        y: { ticks:{ autoSkip:true, callback:(v,i)=>trunc(labels[i]) }, grid:{display:false} }
      },
      plugins: { legend:{ display:false }, title:{ display:true, text:title } },
      layout: { padding:{top:6,right:6,bottom:6,left:6} }
    });

    chartPass && chartPass.destroy();
    chartResp && chartResp.destroy();

    if (c1) chartPass = new Chart(c1, {
      type:'bar',
      data:{ labels, datasets:[{ label:'Pass %', data:DATA.passPct }]},
      options: common('Pass % by Folder', 100)
    });
    if (c2) chartResp = new Chart(c2, {
      type:'bar',
      data:{ labels, datasets:[{ label:'Average Response (ms)', data:DATA.avgMs }]},
      options: common('Average Response Time (ms) by Folder')
    });
  }

  // Inline expand in table (card style)
  window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#tbl tbody tr.clickable').forEach(tr=>{
      tr.addEventListener('click', ()=>{
        const id   = tr.getAttribute('data-row');      // e.g. "folder-availability"
        const name = tr.getAttribute('data-folder');   // raw folder key
        const sub  = document.getElementById('sub-'+id);
        const box  = document.getElementById('box-'+id);

        // close others
        document.querySelectorAll('#tbl tbody tr.subrow').forEach(s=>{
          if (s !== sub) s.style.display = 'none';
        });

        const open = sub.style.display !== 'none';
        if (open) { sub.style.display = 'none'; return; }

        const list = (API_SUMMARY[name] || []);
        box.innerHTML = list.length
          ? list.map(a =>
              '<div class="api-chip"><b>'+escHtml(a.pretty)+'</b>'+
              '<span class="badge pass">'+a.pass+'</span>'+
              '<span class="badge fail">'+a.fail+'</span>'+
              '<span class="muted">'+a.pct+'%</span></div>'
            ).join('')
          : '<span class="muted">No executed APIs in this folder for this run.</span>';

        sub.style.display = 'table-row'; // required for <tr>
      });
    });

    buildCharts();
  });

  // Modal for req/res payloads
  (function(){
    const modal=document.getElementById('modal');
    const mPre =document.getElementById('mPre');
    const mTitle=document.getElementById('mTitle');
    function openModal(kind, id){
      const tag=document.getElementById('payload-'+kind+'-'+id);
      if(!tag) return;
      try{
        const rawB64 = tag.textContent.trim();
        const obj = JSON.parse(atob(rawB64));
        mTitle.textContent = (kind==='req'?'Request':'Response') + ' • ' + id;
        mPre.textContent = JSON.stringify(obj, null, 2);
        modal.classList.add('show');
      }catch(err){
        mTitle.textContent='Payload';
        mPre.textContent='Unable to parse payload';
        modal.classList.add('show');
      }
    }
    function closeModal(){ modal.classList.remove('show'); mPre.textContent=''; }
    document.addEventListener('click',e=>{
      const btn=e.target.closest('[data-open]'); if(btn){ openModal(btn.getAttribute('data-open'), btn.getAttribute('data-for')); }
      if(e.target.closest('[data-close]')) closeModal();
      if(e.target.classList.contains('backdrop')) closeModal();
    });
    document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });
  })();

  window.addEventListener('resize', ()=>{ clearTimeout(window.__rt); window.__rt=setTimeout(buildCharts,150); });
  </script>
</body>
</html>`;

// ===== Write per-suite HTML (OLD path) =====
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, "utf8");
console.log("✓ Wrote per-suite HTML ->", outFile);

// ===== Temp copy per Parent/Module =====
(function writeTemp(){
  const parentDir = path.join(TEMP_ROOT, SUITE_PARENT);
  fs.mkdirSync(parentDir, { recursive: true });
  const tempFile = path.join(parentDir, `${SUITE_MODULE}_latest.html`);
  fs.writeFileSync(tempFile, html, "utf8");
  console.log("✓ Temp report ->", tempFile);
})();
