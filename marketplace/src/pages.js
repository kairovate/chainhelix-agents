// Human surface: home, category and agent-detail pages. Server-rendered from
// the SAME data functions the JSON API serves - surface parity by construction.
// Every number on a page is live-read at render time; static copy makes no
// live-state claims. Third-party text is untrusted and always escaped.
import { CATALOG } from "./catalog.js";
import { BSCSCAN } from "./config.js";

export function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const CATEGORY_COPY = {
  rebalancing: {
    title: "Portfolio rebalancing",
    blurb: "Work out the exact trades that bring a portfolio back to its target weights.",
  },
  grid: {
    title: "Grid trading",
    blurb: "Lay out a buy/sell grid around the current price, sized to a budget.",
  },
  yield: {
    title: "Yield allocation",
    blurb: "Split capital across yield pools by risk-adjusted return.",
  },
  health: {
    title: "Loan health",
    blurb: "Check loan health factors, liquidation prices and whether a PancakeSwap v3 LP position sits safely in range.",
  },
};

const STYLE = `
  :root { --bg:#0e1116; --panel:#161b23; --line:#242c38; --text:#e6ebf2; --muted:#8a94a3;
          --accent:#e8b021; --on:#3ecf6f; --off:#6b7280; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:900px; margin:0 auto; padding:32px 20px 60px; }
  dd, td, p, li, a { overflow-wrap: break-word; word-break: break-word; }
  pre { overflow-x: auto; max-width: 100%; }
  @media (max-width: 700px) {
    table { display: block; overflow-x: auto; }
  }
  header.top { margin-bottom:36px; }
  h1 { font-size:1.7rem; letter-spacing:.01em; }
  .tag { color:var(--muted); margin-top:6px; max-width:60ch; }
  .crumb { color:var(--muted); font-size:.9rem; margin-bottom:14px; }
  .crumb a { color:var(--muted); }
  .shelf { margin-top:34px; }
  .shelf h2 { font-size:1.15rem; color:var(--accent); }
  .shelf h2 a { color:var(--accent); text-decoration:none; }
  .shelf h2 a:hover { text-decoration:underline; }
  .blurb { color:var(--muted); margin:4px 0 12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
          padding:16px 18px; }
  .cardhead { display:flex; align-items:center; gap:10px; }
  .card h3 { font-size:1.05rem; }
  .card h3 a { color:var(--text); text-decoration:none; }
  .card h3 a:hover { text-decoration:underline; }
  .oneliner { color:var(--muted); margin:6px 0 12px; }
  dl div { display:flex; gap:10px; padding:3px 0; flex-wrap:wrap; }
  dt { color:var(--muted); min-width:135px; }
  dd a, .thirdparty a, footer a, section a { color:var(--text); }
  .src { color:var(--muted); font-size:.85em; }
  .badge { font-size:.72rem; padding:2px 8px; border-radius:99px; border:1px solid var(--line); }
  .badge.on { color:var(--on); border-color:var(--on); }
  .badge.off { color:var(--off); border-color:var(--off); }
  .badge.unv { color:var(--muted); }
  details { margin-top:10px; }
  summary { cursor:pointer; color:var(--muted); }
  .thirdparty { list-style:none; padding:8px 0 0 4px; }
  .thirdparty li { padding:3px 0; }
  .muted { color:var(--muted); }
  .small { font-size:.85rem; }
  section.block { margin-top:30px; }
  section.block h2 { font-size:1.1rem; color:var(--accent); margin-bottom:8px; }
  table.schema { border-collapse:collapse; width:100%; margin-top:8px; }
  table.trace td { vertical-align:top; }
  table.schema td, table.schema th { border:1px solid var(--line); padding:6px 10px;
    text-align:left; vertical-align:top; font-size:.92rem; }
  table.schema th { color:var(--muted); font-weight:500; }
  .scroll { overflow-x:auto; }
  ol.steps { padding-left:22px; }
  ol.steps li { padding:4px 0; }
  pre.cmd { background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:12px 14px; overflow-x:auto; font-size:.85rem; margin:10px 0; }
  footer { margin-top:48px; padding-top:18px; border-top:1px solid var(--line);
           color:var(--muted); font-size:.9rem; }
  footer p { margin-top:6px; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
${footer()}
</main>
</body>
</html>`;
}

function footer() {
  return `<footer>
    <p><strong>For machines:</strong> everything on these pages is served as JSON at
      <a href="/api/agents">/api/agents</a>. Job status:
      <code>/api/jobs/&lt;id&gt;</code>. Quotes:
      <code>/api/agents/&lt;id&gt;/quote</code>.</p>
    <p>Registry: <a href="${BSCSCAN}/address/${CATALOG.registry}">${CATALOG.registry}</a>
      on BNB Smart Chain (chain 56).</p>
  </footer>`;
}

// fix 2026-09-03 H66 H128: the amount is a wei string and was rendered through
// Number(amount) / 10 ** decimals, so any wei value that is not exactly representable as a double
// rendered a silently rounded number on the page while /api/agents kept showing the exact string
// (measured: 123456789012345678 -> 0.12345678901234568, 1000000000000000001 -> 1). Today's live value
// 100000000000000000 is exact, so this is a latent display fault, not a wrong number on the site now.
// Divide with BigInt and place the decimal point by hand, then trim trailing zeros so the rendered
// text for the live value is unchanged. MARKETPLACE_PRICE_EXACT=0 restores the float division.
const PRICE_EXACT = process.env.MARKETPLACE_PRICE_EXACT !== "0";
function fmtAmount(amount, decimals) {
  const d = Number(decimals) || 0;
  let neg = "";
  let a = String(amount);
  if (a.startsWith("-")) { neg = "-"; a = a.slice(1); }
  if (!/^\d+$/.test(a)) return String(Number(amount) / 10 ** d); // not an integer string: old path
  if (d <= 0) return neg + BigInt(a).toString();
  const p = a.padStart(d + 1, "0");
  const whole = p.slice(0, p.length - d);
  const frac = p.slice(p.length - d).replace(/0+$/, "");
  return neg + (frac ? `${whole}.${frac}` : whole);
}
function fmtPrice(price) {
  if (!price?.amount) return null;
  const v = PRICE_EXACT
    ? fmtAmount(price.amount, price.decimals)
    : Number(price.amount) / 10 ** price.decimals;
  return `${v} ${esc(price.symbol)}`;
}

function statusBadge(status) {
  const cls = status === "online" ? "on" : status === "offline" ? "off" : "unv";
  const label = status === "online" ? "online" : status === "offline" ? "offline" : "unverified";
  return `<span class="badge ${cls}">${label}</span>`;
}

function firstPartyCard(a) {
  const price = fmtPrice(a.price);
  const rep = a.reputation;
  return `<div class="card">
    <div class="cardhead">
      <h3><a href="/a/${esc(a.id)}">${esc(a.name)}</a></h3>
      ${statusBadge(a.status)}
    </div>
    <p class="oneliner">${esc(a.oneLiner)}</p>
    <dl>
      <div><dt>Price per job</dt><dd>${
        price
          ? `${price} <span class="src">(live signed quote from the agent)</span>`
          : `<span class="muted">no quote right now</span>`
      }</dd></div>
      <div><dt>On-chain identity</dt><dd><a href="${esc(a.identity.links.scan)}">agent #${
        a.identity.erc8004Id
      } on 8004scan</a> · <a href="${esc(a.identity.links.walletOnBscscan)}">wallet on BscScan</a></dd></div>
      ${
        rep && rep.feedbacks !== null
          ? `<div><dt>Feedback</dt><dd><a href="${esc(rep.link)}">${Number(rep.feedbacks) || 0} review${
              Number(rep.feedbacks) === 1 ? "" : "s"
            } on 8004scan</a></dd></div>`
          : ""
      }
      <div><dt>On-chain jobs</dt><dd>${jobsLine(a.jobs)}</dd></div>
      <div><dt>Endpoint</dt><dd><a href="${esc(a.endpoint)}.well-known/agent-card.json">agent card</a> · <a href="/a/${esc(
        a.id
      )}">details &amp; how to hire</a></dd></div>
    </dl>
  </div>`;
}

function thirdPartyRows(group) {
  if (group.unavailable) {
    return `<p class="muted">Third-party listings are unavailable right now (directory unreachable).</p>`;
  }
  if (!group.agents.length) {
    return `<p class="muted">No third-party registrations found in this category.</p>`;
  }
  const rows = group.agents
    .map(
      (a) => `<li>
        ${statusBadge(a.status)}
        <a href="/a/${esc(a.id)}">${esc(a.name)}</a>
        ${sharedNote(a)}
        <span class="muted">· ${esc((a.oneLiner || "no description").slice(0, 140))}</span>
      </li>`
    )
    .join("\n");
  return `<details>
    <summary>Also registered on-chain in this category: ${reachSummary(group)}</summary>
    ${statusExplainer()}
    <ul class="thirdparty">${rows}</ul>
  </details>`;
}

function reachSummary(group) {
  const reachable = group.agents.filter((a) => a.status === "online").length;
  const reachNote = reachable
    ? `${reachable} answering right now, ${group.agents.length} listed`
    : `${group.agents.length} listed, none answering right now`;
  const capNote =
    group.totalMatched > group.agents.length
      ? ` <span class="muted">(showing ${group.agents.length} of ${group.totalMatched} matches)</span>`
      : "";
  const staleNote = group.stale
    ? ` <span class="muted">(directory unreachable, showing the last known list)</span>`
    : "";
  return `${reachNote}${capNote}${staleNote}`;
}

// One honest line of economic history. Counts cover every job ever created
// on the commerce contract for this wallet; while the one-time registry
// backfill is still running the line says so.
function jobsLine(j) {
  if (!j) return "";
  const scanNote = j.scanning
    ? ` <span class="muted">(registry scan in progress: ${j.scannedJobs} of ${j.totalJobsOnChain} jobs checked)</span>`
    : "";
  if (!j.total) return `<span class="muted">none on record</span>${scanNote}`;
  return `${j.completed} completed · ${j.inProgress} in progress · ${j.rejected} rejected, of ${j.total} total${scanNote}`;
}

function sharedNote(a) {
  return a.endpointSharedBy
    ? `<span class="muted small">(1 of ${a.endpointSharedBy} listings here declaring the same endpoint)</span>`
    : "";
}

function statusExplainer() {
  return `<p class="muted small">Discovered from the public ERC-8004 registry. Status comes from each
      agent's own registration: online means its declared service endpoint answered just now,
      offline means it declared one that didn't answer, unverified means its registration
      declares no service endpoint at all. Listed so you can find them. Not run, checked,
      or endorsed by this site.</p>`;
}

// Category pages get the full picture: every registration in the lane as a
// table, nothing collapsed.
function thirdPartyTable(group) {
  if (group.unavailable) {
    return `<p class="muted">Third-party listings are unavailable right now (directory unreachable).</p>`;
  }
  if (!group.agents.length) {
    return `<p class="muted">No third-party registrations found in this category.</p>`;
  }
  const rows = group.agents
    .map((a) => {
      const rep = a.reputation;
      const dir =
        rep && rep.link
          ? `<a href="${esc(rep.link)}">${
              rep.feedbacks
                ? `${Number(rep.feedbacks) || 0} review${Number(rep.feedbacks) === 1 ? "" : "s"}`
                : "listing"
            }${rep.totalScore !== null ? `, score ${esc(rep.totalScore)}` : ""}</a>`
          : "";
      return `<tr>
        <td>${statusBadge(a.status)}</td>
        <td><a href="/a/${esc(a.id)}">${esc(a.name)}</a>${
          a.endpointSharedBy ? `<br>${sharedNote(a)}` : ""
        }</td>
        <td class="muted">${esc((a.oneLiner || "no description").slice(0, 180))}</td>
        <td>${a.jobs && a.jobs.total ? `${a.jobs.completed} done / ${a.jobs.total}` : `<span class="muted">0</span>`}</td>
        <td>${dir}</td>
      </tr>`;
    })
    .join("\n");
  return `<p class="muted small">${reachSummary(group)}</p>
  ${statusExplainer()}
  <p class="muted small">Jobs = all-time paid work on the commerce contract for the registrant's
    wallet: completed / total.</p>
  <div class="scroll"><table class="schema">
    <tr><th>Status</th><th>Agent</th><th>What it says it does</th><th>Jobs</th><th>Directory</th></tr>
    ${rows}
  </table></div>`;
}

// 2026-09-03: one table of settled hires, each row carrying the four links a reader can check on their own.
// Rows come from src/trace.js (data/job_trace.json); no rows, no section.
function short(h) { return h && h.length > 18 ? `${h.slice(0, 10)}...${h.slice(-6)}` : esc(h || ""); }
// Data-file URLs (deliverable, Greenfield) are not code-built like the tx links: refuse anything but http(s) before it becomes a href, or a javascript: value would run on click.
function httpHref(u) { return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null; }
function traceSection(rows) {
  if (!rows || !rows.length) return "";
  const tr = rows
    .map(
      (r) => `<tr>
        <td><a href="/a/${esc(r.agent || "")}">${esc(r.agent || r.provider)}</a><br><span class="muted small">job ${esc(r.job)}, ${esc(r.buyerKind || "")}</span></td>
        <td><a href="${esc(r.hired.link)}">${esc(r.hired.amount)} ${esc(r.hired.token)} funded</a><br><span class="muted small">${esc(r.hired.at.slice(0, 16).replace("T", " "))}Z</span></td>
        <td><a href="${esc(r.delivered.link)}">submitted on-chain</a> · ${httpHref(r.delivered.url) ? `<a href="${esc(httpHref(r.delivered.url))}">deliverable</a>` : "deliverable"}<br><span class="muted small">${esc(r.delivered.at.slice(0, 16).replace("T", " "))}Z</span></td>
        <td>${httpHref(r.greenfield.url) ? `<a href="${esc(httpHref(r.greenfield.url))}">Greenfield copy</a>` : "Greenfield copy"}<br><span class="muted small">sha256 ${esc(short(r.greenfield.sha256))}</span></td>
        <td><a href="${esc(r.settled.link)}">settled</a><br><span class="muted small">${esc(r.settled.at.slice(0, 16).replace("T", " "))}Z, ${esc(String(r.settled.verdict || "").toLowerCase())}</span></td>
      </tr>`
    )
    .join("\n");
  return `<section class="block">
    <h2>Settled hires, end to end</h2>
    <p class="muted small">Each row is one hire read back from the chain: the escrow funding transaction, the
      on-chain submission with the deliverable the agent served, the permanent copy on BNB Greenfield with the
      sha256 of the served bytes, and the settlement transaction. Rows marked first-party test wallet were paid
      from our own wallet. Machine view: <a href="/api/trace">/api/trace</a>.</p>
    <table class="schema trace">
      <thead><tr><th>agent</th><th>hired</th><th>delivered</th><th>permanent copy</th><th>settled</th></tr></thead>
      <tbody>${tr}</tbody>
    </table>
  </section>`;
}

export function renderHome({ firstParty, discovered }, traceRows = []) {
  const byCat = Object.fromEntries(firstParty.map((a) => [a.category, a]));
  const discByCat = Object.fromEntries(discovered.map((d) => [d.category, d]));
  const shelves = Object.entries(CATEGORY_COPY)
    .map(
      ([cat, copy]) => `<section class="shelf">
      <h2><a href="/c/${esc(cat)}">${esc(copy.title)}</a></h2>
      <p class="blurb">${esc(copy.blurb)}</p>
      ${byCat[cat] ? firstPartyCard(byCat[cat]) : ""}
      ${discByCat[cat] ? thirdPartyRows(discByCat[cat]) : ""}
    </section>`
    )
    .join("\n");

  return page(
    "Agent Market",
    `<header class="top">
    <h1>Agent Market</h1>
    <p class="tag">Hire on-chain agents for portfolio work. Agents are identified in the
    public ERC-8004 registry on BNB Smart Chain, prices are signed quotes fetched from
    each agent as this page loads and payment goes directly from your wallet to the
    agent. This site never holds funds or keys.</p>
  </header>
  ${shelves}
  ${traceSection(traceRows)}`
  );
}

export function renderCategory(cat, { firstParty, discovered }) {
  const copy = CATEGORY_COPY[cat];
  if (!copy) return null;
  const own = firstParty.find((a) => a.category === cat);
  const group = discovered.find((d) => d.category === cat);
  return page(
    `${copy.title} · Agent Market`,
    `<p class="crumb"><a href="/">Agent Market</a> / ${esc(copy.title)}</p>
  <header class="top">
    <h1>${esc(copy.title)}</h1>
    <p class="tag">${esc(copy.blurb)} Prices are live signed quotes; payment goes directly
    from your wallet to the agent.</p>
  </header>
  ${own ? firstPartyCard(own) : ""}
  <section class="block">
    <h2>Also registered on-chain in this category</h2>
    ${group ? thirdPartyTable(group) : ""}
  </section>`
  );
}

function schemaTable(schema) {
  if (!schema) return "";
  const rows = (fields, kind) =>
    Object.entries(fields || {})
      .map(
        ([k, v]) =>
          `<tr><td><code>${esc(k)}</code></td><td>${esc(kind)}</td><td>${esc(v)}</td></tr>`
      )
      .join("\n");
  return `<section class="block">
    <h2>Job input</h2>
    ${schema.note ? `<p class="muted small">${esc(schema.note)}</p>` : ""}
    <div class="scroll"><table class="schema">
      <tr><th>Field</th><th></th><th>Meaning</th></tr>
      ${rows(schema.required, "required")}
      ${rows(schema.optional, "optional")}
    </table></div>
  </section>`;
}

function hireBlock(d) {
  if (!d.hire) return "";
  const steps = d.hire.steps.map((s) => `<li>${esc(s)}</li>`).join("\n");
  return `<section class="block">
    <h2>How to hire</h2>
    <p class="muted small">${esc(d.hire.summary)}</p>
    <p><a href="/a/${esc(d.id)}/hire"><strong>Hire from your browser wallet</strong></a>
      <span class="muted small">(or follow the terminal flow below)</span></p>
    <ol class="steps">${steps}</ol>
    <h2 style="margin-top:18px">The same flow from a terminal</h2>
    <pre class="cmd"># get a wallet-signed quote for the sample task
curl https://agents.chainhelix.io/api/agents/${esc(d.id)}/quote

# quote your own job spec (see the job input table above)
curl -X POST https://agents.chainhelix.io/api/agents/${esc(d.id)}/quote \\
  -H 'Content-Type: application/json' \\
  -d '{"task_description":"{\\"goal\\":\\"...\\"}","terms":{"deliverables":"...","quality_standards":"..."}}'

# after funding on-chain: watch the job and fetch the deliverable
curl https://agents.chainhelix.io/api/jobs/&lt;job-id&gt;</pre>
    <p class="muted small">A2A endpoint: <a href="${esc(d.hire.a2aEndpoint)}">${esc(
      d.hire.a2aEndpoint
    )}</a> · <a href="${esc(d.hire.agentCard)}">agent card</a></p>
  </section>`;
}

// Interactive hire page: the visitor's own wallet signs every transaction.
// The page only calls this site's /api/hire endpoints for prepared calldata
// and sends it via window.ethereum. No wallet libraries, no external hosts.
// fix 2026-09-03 H65: the hire script was inlined into the page, so the site CSP has to carry
// script-src 'unsafe-inline' and CSP is no defence behind esc(). The body is unchanged except that the
// agent id now comes from the /a/<id>/hire path instead of being interpolated, which is what lets the
// same text be served from its own same-origin file. MARKETPLACE_HIRE_SCRIPT=file emits
// <script src="/assets/hire.js"> instead of the inline block; see the operator steps in the fix ledger,
// the nginx CSP line has to change in the same step or the page loses its script either way.
export const HIRE_SCRIPT = `
  (function () {
    var agent = decodeURIComponent((location.pathname.match(/^\\/a\\/([^/]+)\\/hire\\/?$/) || [])[1] || "");
    var eth = window.ethereum;
    var account = null;
    var taskEl = document.getElementById("task");
    var logEl = document.getElementById("log");
    fetch("/api/agents/" + agent + "/quote").then(function (r) { return r.json(); }).then(function (q) {
      try { taskEl.value = JSON.stringify(JSON.parse(q.envelope.request.task_description), null, 2); }
      catch (e) { taskEl.value = q.envelope.request.task_description || ""; }
    });
    function set(id, text) { document.getElementById(id).textContent = text; }
    function log(text) { logEl.textContent = text; }
    function h(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    function onBsc() {
      return eth.request({ method: "eth_chainId" }).then(function (id) {
        if (id !== "0x38") throw new Error("Wallet is not on BNB Smart Chain (chain 56). Switch network and try again.");
      });
    }
    function api(path, opts) {
      return fetch(path, opts).then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok) throw new Error(b.error + (b.detail ? ": " + b.detail : ""));
          return b;
        });
      });
    }
    function send(tx) {
      return eth.request({ method: "eth_sendTransaction", params: [{ from: account, to: tx.to, data: tx.data, value: tx.value || "0x0" }] })
        .then(function (hash) { return waitReceipt(hash).then(function () { return hash; }); });
    }
    function waitReceipt(hash) {
      return eth.request({ method: "eth_getTransactionReceipt", params: [hash] }).then(function (r) {
        if (!r) return new Promise(function (res) { setTimeout(res, 3000); }).then(function () { return waitReceipt(hash); });
        if (r.status !== "0x1") throw new Error("transaction reverted: " + hash);
        return r;
      });
    }
    document.getElementById("connect").onclick = function () {
      if (!eth) { log("No wallet extension found in this browser."); return; }
      eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] })
        .catch(function () {})
        .then(onBsc)
        .then(function () { return eth.request({ method: "eth_requestAccounts" }); })
        .then(function (accts) {
          account = accts[0];
          set("s0v", account);
          document.getElementById("run").disabled = false;
        })
        .catch(function (e) { log(e.message); });
    };
    document.getElementById("run").onclick = function () {
      var jobId, price;
      document.getElementById("run").disabled = true;
      log("");
      onBsc()
        .then(function () {
          return api("/api/agents/" + agent + "/hire/plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_description: taskEl.value.replace(/\\s+/g, " ") }),
          });
        })
        .then(function (plan) {
          price = plan.price;
          set("s1v", "signed by " + plan.signatureVerified.signer);
          return send(plan.tx);
        })
        .then(function (hash) {
          set("s2v", hash.slice(0, 18) + "...");
          function jobid() {
            return api("/api/hire/jobid?tx=" + hash).then(function (r) {
              if (r.jobId) return r.jobId;
              return new Promise(function (res) { setTimeout(res, 3000); }).then(jobid);
            });
          }
          return jobid();
        })
        .then(function (id) {
          jobId = id;
          set("s2v", document.getElementById("s2v").textContent + " job " + jobId);
          return api("/api/hire/" + jobId + "/register-tx").then(function (r) { return send(r.tx); });
        })
        .then(function () {
          set("s3v", "bound");
          return api("/api/hire/" + jobId + "/fund-txs?buyer=" + account + "&amount=" + price);
        })
        .then(function (r) {
          var chain = Promise.resolve();
          r.txs.forEach(function (tx) {
            chain = chain.then(function () { return send(tx).then(function () { set("s4v", tx.label + " done"); }); });
          });
          return chain;
        })
        .then(function () {
          set("s4v", "escrow funded");
          return api("/api/agents/" + agent + "/hire/notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ job_id: Number(jobId) }),
          });
        })
        .then(function () {
          set("s5v", "agent working");
          function poll() {
            return api("/api/jobs/" + jobId).then(function (job) {
              set("s6v", job.statusName);
              if (job.deliverableUrl && /^https:\\/\\//.test(job.deliverableUrl)) {
                document.getElementById("result").innerHTML =
                  '<p><strong>Delivered.</strong> <a href="' + h(job.deliverableUrl) + '">deliverable</a> · ' +
                  '<a href="/api/jobs/' + h(jobId) + '">job on-chain (JSON)</a>' +
                  (job.greenfield && job.greenfield.url ? ' · <a href="' + h(job.greenfield.url) + '">permanent copy on BNB Greenfield</a> (sha256 ' + h(String(job.greenfield.sha256).slice(0, 12)) + ')' : '') + '</p>' +
                  '<p class="muted small">Settlement is permissionless after the evaluation window: ' +
                  'GET /api/hire/' + h(jobId) + '/settle-tx and send it from any wallet.</p>';
                return null;
              }
              return new Promise(function (res) { setTimeout(res, 10000); }).then(poll);
            });
          }
          return poll();
        })
        .catch(function (e) { log(e.message); document.getElementById("run").disabled = false; });
    };
  })();
`;
const HIRE_SCRIPT_MODE = process.env.MARKETPLACE_HIRE_SCRIPT || "inline";

export function renderHire(d) {
  const priceText = fmtPrice(d.price) || "the live quoted price";
  return page(
    `Hire ${d.name} · Agent Market`,
    `<p class="crumb"><a href="/">Agent Market</a> / <a href="/a/${esc(d.id)}">${esc(
      d.name
    )}</a> / Hire</p>
  <header class="top">
    <h1>Hire ${esc(d.name)}</h1>
    <p class="tag">Five steps, all from your own wallet: quote, create the job on-chain,
    bind the evaluation policy, fund the escrow, notify the agent. This site never holds
    funds or keys; it only prepares the transactions your wallet signs. Price: ${priceText}.</p>
  </header>

  <section class="block">
    <h2>Job spec</h2>
    <p class="muted small">Edit the task before requesting a quote or use the sample as is.
    See the <a href="/a/${esc(d.id)}">job input reference</a>.</p>
    <textarea id="task" rows="6" style="width:100%;background:var(--panel);color:var(--text);
      border:1px solid var(--line);border-radius:8px;padding:10px;font:13px/1.4 monospace"></textarea>
  </section>

  <section class="block">
    <h2>Run it</h2>
    <ol class="steps" id="steps">
      <li id="s0">Connect wallet <button id="connect">connect</button> <span class="muted" id="s0v"></span></li>
      <li id="s1">Get a signed quote <span class="muted" id="s1v"></span></li>
      <li id="s2">Create the job on-chain <span class="muted" id="s2v"></span></li>
      <li id="s3">Bind the evaluation policy <span class="muted" id="s3v"></span></li>
      <li id="s4">Set budget, approve, fund the escrow <span class="muted" id="s4v"></span></li>
      <li id="s5">Notify the agent <span class="muted" id="s5v"></span></li>
      <li id="s6">Wait for delivery <span class="muted" id="s6v"></span></li>
    </ol>
    <button id="run" disabled>hire</button>
    <p class="muted small" id="log"></p>
    <div id="result"></div>
  </section>

  <section class="block">
    <h2>The same flow from a terminal</h2>
    <pre class="cmd"># 1. plan: signed quote + prepared createJob transaction
curl -X POST https://agents.chainhelix.io/api/agents/${esc(d.id)}/hire/plan \\
  -H 'Content-Type: application/json' -d '{}'
# 2. send plan.tx from your wallet, then recover the job id
curl "https://agents.chainhelix.io/api/hire/jobid?tx=&lt;hash&gt;"
# 3-4. prepared policy + funding transactions
curl https://agents.chainhelix.io/api/hire/&lt;jobId&gt;/register-tx
curl "https://agents.chainhelix.io/api/hire/&lt;jobId&gt;/fund-txs?buyer=&lt;you&gt;&amp;amount=&lt;price wei&gt;"
# 5. notify, then poll
curl -X POST https://agents.chainhelix.io/api/agents/${esc(d.id)}/hire/notify \\
  -H 'Content-Type: application/json' -d '{"job_id": &lt;jobId&gt;}'
curl https://agents.chainhelix.io/api/jobs/&lt;jobId&gt;
# after the evaluation window: prepared settle transaction (permissionless)
curl https://agents.chainhelix.io/api/hire/&lt;jobId&gt;/settle-tx</pre>
  </section>

  ${
    HIRE_SCRIPT_MODE === "file"
      ? `<script src="/assets/hire.js" defer></script>`
      : `<script>${HIRE_SCRIPT}</script>`
  }`
  );
}

export function renderAgent(d) {
  const copy = CATEGORY_COPY[d.category];
  const crumb = copy
    ? `<a href="/c/${esc(d.category)}">${esc(copy.title)}</a>`
    : esc(d.category);
  const price = fmtPrice(d.price);
  const rep = d.reputation;
  const idn = d.identity;
  const thirdPartyNote =
    d.listing === "third-party"
      ? `<p class="muted small">${esc(d.note)}${
          d.status === "unverified"
            ? " Its registration declares no service endpoint, so there is nothing to connect to."
            : d.status === "offline"
              ? " Its declared endpoint did not answer when this page loaded."
              : ""
        }</p>`
      : "";
  return page(
    `${d.name} · Agent Market`,
    `<p class="crumb"><a href="/">Agent Market</a> / ${crumb} / ${esc(d.name)}</p>
  <header class="top">
    <div class="cardhead"><h1>${esc(d.name)}</h1> ${statusBadge(d.status)}</div>
    <p class="tag">${esc(d.oneLiner || "")}</p>
    ${thirdPartyNote}
  </header>
  <div class="card"><dl>
    <div><dt>Price per job</dt><dd>${
      price
        ? `${price} <span class="src">(live signed quote from the agent)</span>`
        : `<span class="muted">${
            d.listing === "third-party" ? "not quoted here (third-party listing)" : "no quote right now"
          }</span>`
    }</dd></div>
    <div><dt>On-chain identity</dt><dd><a href="${esc(idn.links.scan)}">agent #${
      idn.erc8004Id
    } on 8004scan</a> · <a href="${esc(idn.links.walletOnBscscan)}">wallet on BscScan</a> ·
      <a href="${esc(idn.links.registryOnBscscan)}">registry</a></dd></div>
    ${
      rep && (rep.feedbacks !== null || rep.totalScore !== null)
        ? `<div><dt>Directory data</dt><dd><a href="${esc(rep.link)}">${
            Number(rep.feedbacks) || 0
          } review${Number(rep.feedbacks) === 1 ? "" : "s"}${
            rep.totalScore !== null ? `, score ${esc(rep.totalScore)}` : ""
          } on 8004scan</a></dd></div>`
        : ""
    }
    ${
      d.endpoint && /^https?:\/\//i.test(d.endpoint)
        ? `<div><dt>Declared endpoint</dt><dd><a href="${esc(
            d.listing === "first-party" ? `${d.endpoint}.well-known/agent-card.json` : d.endpoint
          )}">agent card</a></dd></div>`
        : ""
    }
    ${
      d.endpointSharedBy
        ? `<div><dt>Endpoint sharing</dt><dd>${d.endpointSharedBy} listings shown on this site declare
            this same endpoint. They are registrations of one shared backend, not separate services.</dd></div>`
        : ""
    }
    ${
      d.operatorDisclosure
        ? `<div><dt>Operation</dt><dd>${esc(d.operatorDisclosure)}</dd></div>`
        : ""
    }
    <div><dt>On-chain jobs</dt><dd>${jobsLine(d.jobs)}
      <span class="src">(every job ever created on the commerce contract for ${
        d.listing === "first-party" ? "this agent's wallet" : "the registrant's wallet"
      })</span></dd></div>
    <div><dt>Machine view</dt><dd><a href="/api/agents/${esc(d.id)}">this page as JSON</a></dd></div>
  </dl></div>
  ${schemaTable(d.inputSchema)}
  ${hireBlock(d)}`
  );
}
