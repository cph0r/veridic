// The report: everything Veridic knows about a repo, gathered once and rendered as
// one self-contained HTML page (no server, no network, no LLM). Tabs: overview,
// specs (requirements with their cited code, tests and freshness), routes (what
// each really does and who can call it), findings (each with a suggested fix),
// tests (what they check), and the change in progress (claim, strays, untested).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openGraph } from "./graph.mjs";
import { routeInventory } from "./routes.mjs";
import { effectManifest, readiness } from "./effects.mjs";
import { auditTests, testCoverage } from "./tests.mjs";
import { metrics, defaultSpecs } from "./metrics.mjs";
import { checkCitations } from "./citations.mjs";
import { staleness } from "./staleness.mjs";
import { doneWithoutSpec, loadClaim } from "./seam.mjs";

const MAX_SNIPPET = 40; // lines of cited code shown per citation

// What to do about each kind of finding. Deterministic: the same finding always
// gets the same advice; the evidence lines say where.
export const FIXES = {
  "get-that-writes": "Make it a POST/PUT/DELETE, or move the write out of the GET. Crawlers, prefetchers and AI agents treat GET as safe to call.",
  "money-not-scoped": "Load the order/payment with the caller's id in the query (e.g. where: { id, userId: req.user.id }) before moving money.",
  "user-id-from-url": "Use the signed-in user's id (req.user.id) instead of the one in the URL, or reject when they differ.",
  "identity-from-request-body": "Take who the action is for from the session, not the request body; ignore or reject a body field that names another user.",
  "id-param-without-caller-scope": "Scope the lookup to the caller (where: { id, ownerId: caller }) or add an ownership guard before acting on the id.",
  "id-param-scoped-by-client-values": "The ids that scope this come from the client; derive them from the session instead.",
  "policy-mismatch": "The guard on this route disagrees with the intended access policy: change the guard, or update the policy if the code is right.",
  unasserted: "This test runs code but checks nothing, so it passes even when the code is broken. Add an assertion on what its title promises.",
  empty: "This test has no body. Write it, or remove it.",
  weak: "Only loose checks (toBeDefined, toBeTruthy, called at all). Assert the actual value or arguments.",
  stray: "This change edits code another route runs. Revert it, or claim that route too (veridic claim) if it belongs to the task.",
  untested: "No asserting test reaching this code names the route or the changed function. Add one before calling it done.",
  stale: "The cited code changed since the spec was written. Re-read it and update the requirement (veridic stale --fix moves citations that only shifted).",
  unresolved: "This citation doesn't resolve to code. Fix the path or line range.",
};

const readLines = (repo, file) => {
  try {
    return fs.readFileSync(path.join(repo, file), "utf8").split("\n");
  } catch {
    return null;
  }
};

function specSection(repo, file, m) {
  const text = fs.readFileSync(file, "utf8");
  const cite = checkCitations(repo, text);
  let cov = { requirements: [] };
  try {
    cov = testCoverage(repo, text, { specPath: file });
  } catch {}
  let stale = new Set();
  try {
    stale = new Set((staleness(repo, text, { range: "HEAD" }).summary.stale_requirements ?? []).map((x) => x.fr ?? x));
  } catch {}
  const citesBy = new Map();
  for (const c of cite.citations ?? []) (citesBy.get(c.fr) ?? citesBy.set(c.fr, []).get(c.fr)).push(c);
  const ids = [...new Set([...cov.requirements.map((r) => r.id), ...citesBy.keys()])];
  const reqs = ids.map((id) => {
    const r = cov.requirements.find((x) => x.id === id) ?? {};
    const cites = (citesBy.get(id) ?? []).map((c) => {
      const lines = c.resolves ? readLines(repo, c.file) : null;
      return {
        cite: c.cite,
        file: c.file ?? null,
        start: c.start,
        end: c.end,
        resolves: !!c.resolves,
        problem: c.problem ?? null,
        code: lines ? lines.slice(c.start - 1, Math.min(c.end, c.start - 1 + MAX_SNIPPET)).join("\n") : null,
        truncated: lines ? c.end - c.start + 1 > MAX_SNIPPET : false,
      };
    });
    // Citations under a heading (a decision table, a contract section) aren't requirements.
    const requirement = /^(?:FR|SC|NFR|R|AC|INV|D)-?\d+[a-z]?$/.test(id);
    const text = (r.text ?? "").replace(/^\*\*[\w-]+\*\*\s*(?:\([^)]*\))?\s*:?\s*/, "");
    return { id, requirement, text, status: r.status ?? "none", tests: (r.tests ?? []).map((t) => (typeof t === "string" ? t : t.at ?? `${t.file}:${t.line}`)), stale: stale.has(id), cites };
  });
  return { spec: m.spec, path: path.relative(repo, file), numbers: m, requirements: reqs };
}

function untrackedSpecs(repo) {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "*spec.md"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).map((f) => path.join(repo, f));
  } catch {
    return [];
  }
}

/** Everything the report shows, as data (also what `veridic report --json` prints). */
export async function collectReport(repo, { specs: specFiles } = {}) {
  const out = { repo, name: path.basename(repo), generated: new Date().toISOString(), errors: [] };
  const note = (where, e) => out.errors.push(`${where}: ${e.message ?? e}`);

  // Routes: effect, access, evidence.
  try {
    const g = openGraph(repo);
    const inv = routeInventory(g);
    const manifest = effectManifest(g, inv);
    const r = readiness(manifest);
    out.routes = manifest.map((t) => ({ id: t.tool, method: t.method, path: t.path, effect: t.effect, moves_money: t.moves_money, external: t.external, notifies: t.notifies, access: t.requires.access, scoped: t.requires.scoped_to_caller, handler: t.handler, evidence: t.evidence.map((e) => ({ kind: e.kind, at: e.at, via: e.via ?? null })), flags: t.access_flags }));
    out.readiness = r.summary;
    out.findings = r.issues.map((i) => ({ area: "API", severity: i.severity, kind: i.kind, where: i.tool, text: i.text, evidence: i.evidence, fix: FIXES[i.kind] ?? null }));
  } catch (e) {
    note("routes", e);
    out.routes = [];
    out.findings = [];
  }

  // Tests: strength across the repo.
  try {
    const a = auditTests(repo);
    out.tests = { summary: a.summary, flagged: a.flagged };
    for (const k of ["empty", "unasserted"]) for (const t of a.flagged[k] ?? []) out.findings.push({ area: "Tests", severity: "medium", kind: k === "empty" ? "empty test" : "test asserts nothing", where: t.at, text: t.title, evidence: [t.at], fix: FIXES[k] });
    for (const t of (a.flagged.weak ?? []).slice(0, 200)) out.findings.push({ area: "Tests", severity: "low", kind: "weak test", where: t.at, text: t.title, evidence: [t.at], fix: FIXES.weak });
  } catch (e) {
    note("tests", e);
  }

  // Specs: requirements, citations with code, tests, freshness.
  // Committed specs, and new ones not committed yet (a spec under review is often new).
  const files = specFiles?.length ? specFiles : [...new Set([...defaultSpecs(repo), ...untrackedSpecs(repo)])];
  out.specs = [];
  if (files.length) {
    try {
      const m = metrics(repo, files, { mutate: false });
      files.forEach((f, i) => {
        try {
          const s = specSection(repo, f, m.specs[i]);
          out.specs.push(s);
          for (const r of s.requirements) {
            if (r.stale) out.findings.push({ area: "Spec", severity: "medium", kind: "stale requirement", where: `${s.path} ${r.id}`, text: r.text, evidence: r.cites.map((c) => c.cite), fix: FIXES.stale });
            for (const c of r.cites.filter((c) => !c.resolves)) out.findings.push({ area: "Spec", severity: "medium", kind: "citation doesn't resolve", where: `${s.path} ${r.id}`, text: `${c.cite}: ${c.problem}`, evidence: [c.cite], fix: FIXES.unresolved });
          }
        } catch (e) {
          note(`spec ${f}`, e);
        }
      });
      out.coverage = m.coverage;
      out.attention = m.attention;
    } catch (e) {
      note("specs", e);
    }
  }

  // The change in progress: what the working tree changes against HEAD, checked against the claim.
  try {
    const claims = loadClaim(repo);
    const d = await doneWithoutSpec(repo, { claims });
    if (d.files?.length || d.tests?.length || claims.length) {
      out.change = { claims, done: d.done, problems: d.problems ?? [], files: d.files ?? [], seam: d.seam ?? null };
      for (const p of d.problems ?? []) {
        const kind = p.split(":")[0];
        out.findings.push({ area: "Change", severity: "high", kind: kind === "stray" ? "stray edit" : kind, where: "working tree", text: p.slice(kind.length + 1).trim(), evidence: [], fix: FIXES[kind] ?? null });
      }
    }
  } catch (e) {
    if (!/not a git|unknown revision|ambiguous argument 'HEAD'/i.test(e.message)) note("change", e);
  }

  const order = { high: 0, medium: 1, low: 2 };
  out.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return out;
}

/** The page: data embedded as JSON, rendered by a small inline script. */
export function renderReport(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = `Veridic report · ${data.name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="brand"><span class="logo">✓</span> Veridic <span class="muted" id="repo"></span><span class="spacer"></span><label class="muted small">Open code in <select id="editor"><option value="vscode">VS Code</option><option value="cursor">Cursor</option><option value="none">nowhere (plain text)</option></select></label></div>
  <nav id="tabs" role="tablist"></nav>
</header>
<main id="main"></main>
<footer id="foot"></footer>
<div class="toast" id="toast" role="status"></div>
<script type="application/json" id="data">${json}</script>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#2f6f4f;--high:#b42318;--med:#b54708;--low:#6b6b66;--ok:#2f6f4f;--code:#f1f0ec;--chip:#efeee9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecebe6;--muted:#9b9a94;--line:#2e2d2a;--accent:#6fbf8f;--high:#f97066;--med:#fdb022;--low:#9b9a94;--ok:#6fbf8f;--code:#232320;--chip:#2a2926}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--panel);border-bottom:1px solid var(--line);padding:12px 16px 0}
.brand{font-weight:600;font-size:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.logo{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;background:var(--accent);color:var(--panel);font-size:13px}
nav{display:flex;gap:4px;overflow-x:auto;margin-top:10px}nav button{border:0;background:none;color:var(--muted);padding:8px 12px;border-bottom:2px solid transparent;font:inherit;cursor:pointer;white-space:nowrap}
nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}nav .n{font-size:11px;background:var(--chip);border-radius:9px;padding:0 6px;margin-left:6px;color:var(--muted)}
main{max-width:1180px;margin:0 auto;padding:20px 16px 60px}.muted{color:var(--muted);font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.card .v{font-size:24px;font-weight:650}.card .k{color:var(--muted);font-size:12px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
h2{font-size:15px;margin:22px 0 10px}h3{font-size:14px;margin:0 0 6px}
.chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;background:var(--chip);color:var(--muted);margin-right:4px;white-space:nowrap}
.sev-high{background:color-mix(in srgb,var(--high) 15%,transparent);color:var(--high)}.sev-medium{background:color-mix(in srgb,var(--med) 15%,transparent);color:var(--med)}.sev-low{color:var(--low)}
.ok{color:var(--ok)}.bad{color:var(--high)}.warn{color:var(--med)}
td.h{min-width:260px}td.h code{word-break:break-all}.scroll table{min-width:760px}nav{scrollbar-width:none}nav::-webkit-scrollbar{display:none}html,body{overflow-x:hidden}code,pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--code);padding:10px;border-radius:8px;overflow-x:auto;margin:6px 0 0;max-height:360px}
.fix{border-left:3px solid var(--accent);padding:6px 10px;margin-top:8px;background:color-mix(in srgb,var(--accent) 7%,transparent);border-radius:0 6px 6px 0}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}input,select{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}input{flex:1;min-width:160px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}details summary{cursor:pointer}.subtabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.subtabs button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:5px 10px;border-radius:16px;cursor:pointer}.subtabs button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);font-weight:600}
.bar{height:8px;border-radius:4px;background:var(--chip);overflow:hidden;display:flex}.bar span{display:block;height:100%}
.empty{color:var(--muted);padding:30px;text-align:center}
.spacer{flex:1}.small{font-size:12px}.small select{padding:2px 6px;font-size:12px}
a.loc{color:inherit;text-decoration:underline dotted;text-underline-offset:2px}a.loc:hover{color:var(--accent)}
.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.btn{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:4px 10px;border-radius:7px;cursor:pointer;text-decoration:none;display:inline-block}.btn:hover{border-color:var(--accent);color:var(--accent)}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--panel)}.btn.primary:hover{color:var(--panel);filter:brightness(1.08)}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none}.toast.on{opacity:1}
footer{max-width:1180px;margin:0 auto;padding:0 16px 40px;color:var(--muted);font-size:12px}
`;

const JS = `
const D=JSON.parse(document.getElementById('data').textContent);
const $=(s,r=document)=>r.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const chip=(t,c='')=>'<span class="chip '+c+'">'+esc(t)+'</span>';const sev=s=>chip(s,'sev-'+s);
$('#repo').textContent=D.name+' · '+new Date(D.generated).toLocaleString();
let ED=(()=>{try{return localStorage.getItem('veridic-editor')}catch{return null}})()||'vscode';$('#editor').value=ED;$('#editor').onchange=e=>{ED=e.target.value;try{localStorage.setItem('veridic-editor',ED)}catch{}show()};
// file:line(-end)[ via x] -> a link that opens the editor at that line.
const LOC=/^([^\\s:()]+\\.[\\w]+):(\\d+)(?:-\\d+)?/;
function loc(t){const m=String(t).match(LOC);if(!m||ED==='none')return '<code>'+esc(t)+'</code>';const abs=(D.repo+'/'+m[1]).replace(/\\/+/g,'/');return '<a class="loc" href="'+ED+'://file'+encodeURI(abs.startsWith('/')?abs:'/'+abs)+':'+m[2]+'" title="Open in '+(ED==='cursor'?'Cursor':'VS Code')+'"><code>'+esc(t)+'</code></a>';}
const CLIP=[];const clip=t=>(CLIP.push(t),CLIP.length-1);
function toast(m){const el=$('#toast');el.textContent=m;el.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('on'),1800);}
async function copy(t){try{await navigator.clipboard.writeText(t)}catch{const a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();}toast('Copied. Paste it into Claude Code.');}
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(b){e.preventDefault();copy(CLIP[+b.dataset.copy]);}});
const btn=(label,text,cls='')=>'<button class="btn '+cls+'" data-copy="'+clip(text)+'">'+label+'</button>';
const TAIL='Before editing, run \`veridic claim\` with the route(s) or file(s) you will change. Make the smallest change that fixes it, add or fix a test that asserts the behavior, then run \`veridic done\` and keep going until it says DONE.';
function promptFor(f){
  const ev=(f.evidence||[]).filter(Boolean);
  if(f.area==='Tests')return 'Fix this test in '+D.name+': '+f.where+' ("'+f.text+'") '+(f.kind==='weak test'?'only has loose checks.':f.kind==='empty test'?'has no body.':'checks nothing, so it passes even when the code is broken.')+'\\nSuggested fix: '+(f.fix||'')+'\\nRead the code it exercises, assert what the title promises, and make sure the test would fail if that behavior broke. Run the test, then \`veridic done\`.';
  return 'Fix this Veridic finding in '+D.name+':\\n\\n'+f.severity.toUpperCase()+' '+f.kind+' at '+f.where+'\\n'+f.text+(ev.length?'\\nEvidence: '+ev.join(', '):'')+(f.fix?'\\nSuggested fix: '+f.fix:'')+'\\n\\nFirst confirm it is real by reading the evidence lines; if it is not, say why and stop. '+TAIL;}
function promptAll(list){return 'Fix these '+list.length+' Veridic findings in '+D.name+', one at a time, most severe first. For each: confirm it is real by reading the evidence (skip it and say why if not), then fix it.\\n\\n'+list.map((f,i)=>(i+1)+'. '+f.severity.toUpperCase()+' '+f.kind+' at '+f.where+': '+f.text+((f.evidence||[]).length?' (evidence: '+f.evidence.join(', ')+')':'')+(f.fix?'\\n   Suggested fix: '+f.fix:'')).join('\\n')+'\\n\\n'+TAIL;}
const F=D.findings||[];const T=D.tests&&D.tests.summary;
const tabs=[['overview','Overview',null],['specs','Specs',D.specs.length],['routes','Routes',D.routes.length],['findings','Findings',F.filter(f=>f.severity!=='low').length],['tests','Tests',T?T.tests:0]];
if(D.change)tabs.push(['change','Current change',D.change.problems.length]);
let cur=location.hash.slice(1)||(()=>{try{return localStorage.getItem('veridic-tab')}catch{return null}})()||'overview';if(!tabs.some(t=>t[0]===cur))cur='overview';
function nav(){$('#tabs').innerHTML=tabs.map(([k,l,n])=>'<button role="tab" aria-selected="'+(k===cur)+'" data-k="'+k+'">'+l+(n!=null?'<span class="n">'+n+'</span>':'')+'</button>').join('');}
$('#tabs').onclick=e=>{const b=e.target.closest('button');if(!b)return;cur=b.dataset.k;try{localStorage.setItem('veridic-tab',cur);history.replaceState(null,'','#'+cur)}catch{}nav();show();window.scrollTo(0,0);};
const card=(v,k,c='')=>'<div class="card"><div class="v '+c+'">'+v+'</div><div class="k">'+k+'</div></div>';
function overview(){const r=D.readiness||{};const hi=F.filter(f=>f.severity==='high').length,me=F.filter(f=>f.severity==='medium').length;
let h='<div class="cards">'+card(D.routes.length,'routes')+card((r.writes||0)+(r.destructive||0),'routes that write · '+(r.destructive||0)+' destructive')+card(r.move_money||0,'move money')+card(r.agent_ready_pct!=null?r.agent_ready_pct+'%':'—','agent-ready (no medium/high issue)')+card(hi,'high findings',hi?'bad':'ok')+card(me,'medium findings',me?'warn':'ok')+(T?card(T.checking_pct+'%','of '+T.tests+' tests check something'):'')+card(D.specs.length,'specs'+(D.coverage&&D.coverage.coverage_pct!=null?' · '+D.coverage.coverage_pct+'% of routes specified':''))+'</div>';
if(D.change)h+='<div class="panel"><h3>Current change: '+(D.change.done?'<span class="ok">DONE</span>':'<span class="bad">NOT DONE</span>')+'</h3>'+(D.change.problems.length?D.change.problems.map(p=>'<div>'+esc(p)+'</div>').join(''):'<div class="muted">Stays in its claim, and changed routes have asserting tests.</div>')+'</div>';
const top=F.filter(f=>f.severity!=='low');h+='<h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Fix first'+(top.length?btn('Copy all '+top.length+' as one prompt',promptAll(top)):'')+'</h2>'+(F.filter(f=>f.severity!=='low').slice(0,6).map(finding).join('')||'<div class="empty">Nothing high or medium. </div>');
if(D.errors.length)h+='<h2>Couldn\\'t check</h2><div class="panel">'+D.errors.map(e=>'<div class="muted">'+esc(e)+'</div>').join('')+'</div>';return h;}
function finding(f){const ev=(f.evidence||[]).filter(Boolean);const first=ev.find(e=>LOC.test(e))||(LOC.test(f.where)?f.where:null);const href=first&&ED!=='none'?(loc(first).match(/href="([^"]+)"/)||[])[1]:null;
return '<div class="panel">'+sev(f.severity)+chip(f.area)+'<b>'+esc(f.kind)+'</b> '+loc(f.where)+'<div>'+esc(f.text)+'</div>'+(ev.length?'<div class="muted">'+ev.map(loc).join(' · ')+'</div>':'')+(f.fix?'<div class="fix"><b>Suggested fix:</b> '+esc(f.fix)+'</div>':'')+
'<div class="actions">'+btn('Copy fix prompt for Claude',promptFor(f),'primary')+(href?'<a class="btn" href="'+href+'">Open in editor</a>':'')+'</div></div>';}
let fArea='all',fSev='high+medium',fQ='';
function findings(){const areas=['all',...new Set(F.map(f=>f.area))];
const list=F.filter(f=>(fArea==='all'||f.area===fArea)&&(fSev==='all'||(fSev==='high+medium'?f.severity!=='low':f.severity===fSev))&&(!fQ||(f.kind+f.where+f.text).toLowerCase().includes(fQ)));
return '<div class="controls"><input id="fq" placeholder="Filter findings" value="'+esc(fQ)+'"><select id="fa">'+areas.map(a=>'<option'+(a===fArea?' selected':'')+'>'+a+'</option>').join('')+'</select><select id="fs">'+['high+medium','high','medium','low','all'].map(a=>'<option'+(a===fSev?' selected':'')+'>'+a+'</option>').join('')+'</select></div><div class="muted" style="margin-bottom:8px;display:flex;gap:10px;align-items:center">'+list.length+' shown'+(list.length?btn('Copy these as one prompt',promptAll(list.slice(0,50))):'')+'</div>'+(list.slice(0,300).map(finding).join('')||'<div class="empty">No findings match.</div>');}
let rQ='',rE='all';
function routes(){if(!D.routes.length)return '<div class="empty">No routes found. Run <code>veridic init</code> in the repo.</div>';
const list=D.routes.filter(r=>(rE==='all'||(rE==='money'?r.moves_money:r.effect===rE))&&(!rQ||(r.id+r.handler).toLowerCase().includes(rQ)));
const issues=new Map();F.filter(f=>f.area==='API'&&f.severity!=='low').forEach(f=>issues.set(f.where,(issues.get(f.where)||[]).concat(f)));
return '<div class="controls"><input id="rq" placeholder="Filter routes" value="'+esc(rQ)+'"><select id="re">'+['all','read','write','destructive','money'].map(a=>'<option'+(a===rE?' selected':'')+'>'+a+'</option>').join('')+'</select></div><div class="scroll"><table><thead><tr><th>Route</th><th>Effect</th><th>Access</th><th>Scoped to caller</th><th>Issues</th><th>Handler</th></tr></thead><tbody>'+
list.map(r=>{const is=issues.get(r.id)||[];return '<tr><td><details><summary><code>'+esc(r.id)+'</code></summary>'+(r.evidence.length?r.evidence.map(e=>'<div class="muted"><code>'+esc(e.kind)+'</code> '+loc(e.at)+(e.via?' via '+esc(e.via):'')+'</div>').join(''):'<div class="muted">no effects traced</div>')+'</details></td><td>'+chip(r.effect,r.effect==='destructive'?'sev-high':r.effect==='write'?'sev-medium':'')+(r.moves_money?chip('money','sev-high'):'')+(r.notifies?chip('notifies'):'')+(r.external?chip('external'):'')+'</td><td>'+esc(r.access)+'</td><td>'+(r.access==='public'&&r.effect==='read'?'<span class="muted">—</span>':esc(r.scoped))+'</td><td>'+is.map(f=>sev(f.severity)+'<span title="'+esc(f.text)+'">'+esc(f.kind)+'</span>').join('<br>')+'</td><td class="h">'+loc(r.handler)+'</td></tr>'}).join('')+'</tbody></table></div>';}
let sIdx=0,sQ='';
const ST={passing:'ok',covered:'ok',failing:'bad',unasserted:'bad',none:'warn',tagged_only:'warn',todo:'muted'};
function specs(){if(!D.specs.length)return '<div class="empty">No specs yet. Ask your agent: “write a spec for the orders feature with veridic”. Specs are committed <code>*spec.md</code> files.</div>';
const s=D.specs[Math.min(sIdx,D.specs.length-1)];const n=s.numbers||{};
const reqs=s.requirements.filter(r=>!sQ||(r.id+r.text).toLowerCase().includes(sQ));
return (D.specs.length>1?'<div class="subtabs">'+D.specs.map((x,i)=>'<button data-s="'+i+'" aria-pressed="'+(i===sIdx)+'">'+esc(x.path)+'</button>').join('')+'</div>':'')+
'<div class="cards">'+card(s.requirements.filter(r=>r.requirement).length,'requirements')+card((n.citations_resolving_pct??'—')+'%','citations resolve')+card(n.claim_support_pct!=null?n.claim_support_pct+'%':'—','stated facts in cited lines')+card(n.tested_pct!=null?n.tested_pct+'%':'—','requirements tested')+card(n.stale_requirements??'—','stale requirements',n.stale_requirements?'warn':'ok')+'</div>'+
'<div class="controls"><input id="sq" placeholder="Filter requirements" value="'+esc(sQ)+'"></div>'+
(()=>{const one=r=>'<div class="panel"><h3>'+esc(r.id)+' '+(r.requirement?chip(r.status.replace('_',' '),ST[r.status]||''):'')+(r.stale?chip('stale','sev-medium'):'')+'</h3><div>'+esc(r.text)+'</div>'+
(r.tests.length?'<div class="muted">Tests: '+r.tests.map(loc).join(' · ')+'</div>':'')+
r.cites.map(c=>'<details><summary>'+(c.resolves?loc(c.file+':'+c.start+(c.end!==c.start?'-'+c.end:'')):'<code>'+esc(c.cite)+'</code>')+' '+(c.resolves?'':'<span class="bad">'+esc(c.problem)+'</span>')+'</summary>'+(c.code!=null?'<pre>'+esc(c.code)+(c.truncated?'\\n…':'')+'</pre>':'')+'</details>').join('')+'</div>';const rq=reqs.filter(r=>r.requirement),other=reqs.filter(r=>!r.requirement);return rq.map(one).join('')+(other.length?'<h2>Other cited sections</h2>'+other.map(one).join(''):'');})();}
function tests(){if(!T)return '<div class="empty">No tests found.</div>';const tot=Math.max(1,T.tests);const seg=(n,c)=>'<span style="width:'+(n/tot*100)+'%;background:'+c+'"></span>';
const fl=D.tests.flagged||{};const list=(k,label)=>(fl[k]||[]).length?'<h2>'+label+' ('+fl[k].length+')</h2><div class="panel">'+fl[k].slice(0,300).map(t=>'<div>'+loc(t.at)+' '+esc(t.title)+'</div>').join('')+'</div>':'';
return '<div class="cards">'+card(T.tests,'tests in '+T.test_files+' files')+card(T.strong,'check real values','ok')+card(T.weak,'only loose checks',T.weak?'warn':'')+card(T.unasserted+T.empty,'check nothing',T.unasserted+T.empty?'bad':'ok')+card(T.skipped,'skipped')+'</div><div class="bar">'+seg(T.strong,'var(--ok)')+seg(T.weak,'var(--med)')+seg(T.unasserted+T.empty,'var(--high)')+seg(T.skipped,'var(--line)')+'</div>'+
'<div class="fix" style="margin-top:14px">A test that checks nothing passes even when the code is broken. Fix those first; then turn loose checks (<code>toBeDefined</code>, <code>toHaveBeenCalled()</code>) into checks of the actual value.</div>'+list('empty','Empty')+list('unasserted','Check nothing')+list('weak','Only loose checks');}
function change(){const c=D.change;return '<div class="panel"><h3>'+(c.done?'<span class="ok">DONE</span>':'<span class="bad">NOT DONE</span>')+'</h3><div class="muted">Claimed: '+(c.claims.length?c.claims.map(x=>'<code>'+esc(x)+'</code>').join(' '):'nothing (run <code>veridic claim &lt;route&gt;</code> before editing)')+'</div>'+c.problems.map(p=>'<div class="bad">'+esc(p)+'</div>').join('')+'</div>'+
'<div class="scroll"><table><thead><tr><th>Changed file</th><th>Routes it reaches</th><th>Tests reaching it</th><th>Untested</th></tr></thead><tbody>'+c.files.map(f=>'<tr><td>'+loc(f.file+':1')+'</td><td>'+(f.routes||[]).map(r=>'<code>'+esc(r)+'</code>').join('<br>')+'</td><td>'+(f.tests||[]).slice(0,8).map(t=>loc(t+':1')).join('<br>')+'</td><td class="bad">'+(f.untested_routes||[]).map(esc).join('<br>')+'</td></tr>').join('')+'</tbody></table></div>';}
const views={overview,specs,routes,findings,tests,change};
function show(){CLIP.length=0;$('#main').innerHTML=views[cur]();
$('#foot').innerHTML='Generated '+esc(new Date(D.generated).toLocaleString())+' from the code as it was then. To refresh, run <code>veridic report</code> again '+btn('Copy command','cd '+D.repo+' && veridic report')+'. Nothing here was uploaded anywhere: this page is a local file.';
const bind=(id,fn)=>{const el=$('#'+id);if(el)el.oninput=el.onchange=e=>{fn(e.target.value);const p=el.selectionStart;show();const n=$('#'+id);if(n&&n.tagName==='INPUT'){n.focus();try{n.setSelectionRange(p,p)}catch{}}}};
bind('fq',v=>fQ=v.toLowerCase());bind('fa',v=>fArea=v);bind('fs',v=>fSev=v);bind('rq',v=>rQ=v.toLowerCase());bind('re',v=>rE=v);bind('sq',v=>sQ=v.toLowerCase());
document.querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>{sIdx=+b.dataset.s;show()});}
nav();show();
`;
