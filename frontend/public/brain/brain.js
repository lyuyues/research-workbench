// =====================================================================
// Second Brain — brain.js
// B+D mode: AI-generated = dashed / tentative; after you ✓ it = solid / truly part of your brain
// =====================================================================

// DB-backed via the /api/brain/state endpoints; localStorage is not the source of truth.
// Kept as offline-fallback only.
const API_BASE = '/api/brain';
const STORAGE_KEY = 'brain-confirmations-v1';
const ANSWERS_KEY = 'brain-answers-v1';
const EDGE_STORAGE_KEY = 'brain-edge-confirmations-v1';
const NOTES_KEY = 'brain-node-notes-v1';
const RENAMES_KEY = 'brain-node-renames-v1';

// API helpers
// Turn a non-200 response into a readable message: JSON `detail` / `error` field if present, else the text.
async function apiErrorMessage(r) {
  let t = '';
  try { t = await r.text(); } catch {}
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object') {
      const d = j.detail ?? j.error;
      if (d) return typeof d === 'string' ? d : JSON.stringify(d);
    }
  } catch {}
  return t ? `${r.status} ${t}` : `HTTP ${r.status}`;
}
async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(await apiErrorMessage(r));
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await apiErrorMessage(r));
  return r.json();
}

// Lightweight error toast
function showSyncError(msg) {
  let t = document.getElementById('sync-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'sync-toast';
    t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#fdecea;color:#c0362c;padding:8px 14px;border-radius:6px;font-size:12px;z-index:100;border:1px solid #f2c4bf;';
    document.body.appendChild(t);
  }
  t.textContent = '⚠ ' + msg;
  t.style.display = 'block';
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

let allData = null;
let graph = null;
let activeProjectFilter = 'all';
let activeDomains = new Set();
let activeTypes = new Set();   // node type filter (controlled by legend chips)

window.toggleType = function(typeKey) {
  if (activeTypes.has(typeKey)) activeTypes.delete(typeKey);
  else activeTypes.add(typeKey);
  // update UI active state
  document.querySelectorAll('.legend-chip').forEach(el => {
    el.classList.toggle('active', activeTypes.has(el.dataset.type));
  });
  refresh();
};
let onlyConfirmed = false;
let onlyPending = false;
let confirmations = loadConfirmations();
let answers = loadAnswers();
let edgeConfirmations = loadEdgeConfirmations();
let nodeNotes = loadNodeNotes();
let nodeRenames = loadNodeRenames();
let reviewMode = false;
let reviewQueue = [];
let reviewIndex = 0;
let sidebarMode = 'detail'; // 'detail' | 'list'
let collapsedSections = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('brain-collapsed-sections') || '[]')); }
  catch { return new Set(); }
})();
function sectionToggle(id, title, count, color = 'var(--text-dim)') {
  const collapsed = collapsedSections.has(id);
  return `<h3 onclick="toggleSection('${id}')" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;color:${color};margin-top:18px;">
    <span style="font-size:9px;color:var(--text-faint);width:8px;">${collapsed ? '▶' : '▼'}</span>
    <span>${title}${count !== undefined ? ` (${count})` : ''}</span>
  </h3>`;
}
window.toggleSection = function(id) {
  if (collapsedSections.has(id)) collapsedSections.delete(id);
  else collapsedSections.add(id);
  localStorage.setItem('brain-collapsed-sections', JSON.stringify([...collapsedSections]));
  const body = document.getElementById(`sec-body-${id}`);
  if (body) body.style.display = collapsedSections.has(id) ? 'none' : '';
  // Update chevron
  const header = body?.previousElementSibling;
  if (header) {
    const span = header.querySelector('span');
    if (span) span.textContent = collapsedSections.has(id) ? '▶' : '▼';
  }
};
let listSearch = '';
let listTypeFilter = 'all'; // 'all' | 'concept' | 'source:paper' | 'source:book' | 'highlight' | 'question' | 'project'
let listCollapsed = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('brain-list-collapsed') || '[]')); }
  catch { return new Set(); }
})();
let lastFocusedNode = null;
let nodeHistory = []; // stack of recently-visited node IDs (for ← back button)
let expandedMerges = new Set(); // session-scoped: expanded merge banners (by node id)
window.toggleMergeList = function(nodeId) {
  if (expandedMerges.has(nodeId)) expandedMerges.delete(nodeId);
  else expandedMerges.add(nodeId);
  renderSidebar();
};

function navigateTo(node) {
  if (!node) return;
  // history: push the current node (skip if it is the same node)
  if (lastFocusedNode && lastFocusedNode.id !== node.id) {
    nodeHistory.push(lastFocusedNode.id);
    if (nodeHistory.length > 50) nodeHistory.shift();
  }
  lastFocusedNode = node;
  sidebarMode = 'detail';
  focusOnNode(node);
  renderSidebar();
  updateBackButton();
}

window.goBack = function() {
  if (nodeHistory.length === 0) return;
  const prevId = nodeHistory.pop();
  const prev = (allData.nodes || []).find(n => n.id === prevId);
  if (!prev) { updateBackButton(); return; }
  // don't push when going back (otherwise two nodes loop forever)
  lastFocusedNode = prev;
  sidebarMode = 'detail';
  focusOnNode(prev);
  renderSidebar();
  updateBackButton();
};

function updateBackButton() {
  const btn = document.getElementById('navBackBtn');
  if (!btn) return;
  btn.style.display = nodeHistory.length > 0 ? '' : 'none';
  btn.title = `← Back (${nodeHistory.length})`;
}

// -------------------- Storage helpers --------------------
// Initial state loaders (localStorage fallback when DB load fails or offline)
function loadConfirmations() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function loadAnswers() {
  try { return JSON.parse(localStorage.getItem(ANSWERS_KEY) || '{}'); } catch { return {}; }
}
function loadEdgeConfirmations() {
  try { return JSON.parse(localStorage.getItem(EDGE_STORAGE_KEY) || '{}'); } catch { return {}; }
}
function loadNodeNotes() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch { return {}; }
}
function loadNodeRenames() {
  try { return JSON.parse(localStorage.getItem(RENAMES_KEY) || '{}'); } catch { return {}; }
}

// Hydrate state from the server (the server DB is the only source of record).
// localStorage is only a read-only offline mirror; it is never pushed back to the DB.
async function loadStateFromServer() {
  try {
    const s = await apiGet(`${API_BASE}/state`);

    confirmations = s.node_confirmations || {};
    edgeConfirmations = s.edge_confirmations || {};
    nodeNotes = s.node_notes || {};
    nodeRenames = s.node_renames || {};
    answers = s.answers || {};
    // Backup mirror to localStorage (offline fallback). Server is source of truth.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(confirmations));
      localStorage.setItem(EDGE_STORAGE_KEY, JSON.stringify(edgeConfirmations));
      localStorage.setItem(NOTES_KEY, JSON.stringify(nodeNotes));
      localStorage.setItem(RENAMES_KEY, JSON.stringify(nodeRenames));
      localStorage.setItem(ANSWERS_KEY, JSON.stringify(answers));
    } catch {}
    return true;
  } catch (e) {
    showSyncError('Could not load state from the server; using local cache');
    console.error(e);
    return false;
  }
}

// Per-mutation API saves (each replaces the old "save *()" bulk writes)
async function persistNodeConfirmation(nodeId, status) {
  try { await apiPost(`${API_BASE}/state/node/${encodeURIComponent(nodeId)}/confirm`, {status}); }
  catch (e) { showSyncError('Confirmation not saved: ' + e.message); }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(confirmations));
}
async function persistEdgeConfirmation(edgeId, status) {
  try { await apiPost(`${API_BASE}/state/edge/${edgeId}/confirm`, {status}); }
  catch (e) { showSyncError('Link confirmation not saved: ' + e.message); }
  localStorage.setItem(EDGE_STORAGE_KEY, JSON.stringify(edgeConfirmations));
}
async function persistNote(nodeId, text) {
  try { await apiPost(`${API_BASE}/state/node/${encodeURIComponent(nodeId)}/note`, {text}); }
  catch (e) { showSyncError('Note not saved: ' + e.message); }
  localStorage.setItem(NOTES_KEY, JSON.stringify(nodeNotes));
}
async function persistRename(nodeId, label) {
  try { await apiPost(`${API_BASE}/state/node/${encodeURIComponent(nodeId)}/rename`, {label}); }
  catch (e) { showSyncError('Rename not saved: ' + e.message); }
  localStorage.setItem(RENAMES_KEY, JSON.stringify(nodeRenames));
}
async function persistAnswer(questionId, text) {
  try { await apiPost(`${API_BASE}/state/question/${encodeURIComponent(questionId)}/answer`, {text}); }
  catch (e) { showSyncError('Answer not saved: ' + e.message); }
  localStorage.setItem(ANSWERS_KEY, JSON.stringify(answers));
}

// Compat shims for old call sites that just say "save"
function saveConfirmations() { /* now per-item via persistNodeConfirmation */ }
function saveEdgeConfirmations() { /* now per-item via persistEdgeConfirmation */ }
function saveAnswers() { /* now per-item via persistAnswer */ }
function saveNodeNotes() { /* now per-item via persistNote */ }
function saveNodeRenames() { /* now per-item via persistRename */ }
function getDisplayLabel(node) {
  return nodeRenames[node.id] || node.label || '';
}
function edgeKey(link) {
  // Edges now have DB integer ID; key by that for state lookups
  if (link.id !== undefined && link.id !== null) return String(link.id);
  // Fallback for any edges without ID (shouldn't happen after DB)
  const s = typeof link.source === 'object' ? link.source.id : link.source;
  const t = typeof link.target === 'object' ? link.target.id : link.target;
  return `${s}|${t}|${link.type || ''}`;
}
function edgeStatusOf(link) {
  if (link.confirmed === true) return 'confirmed';
  return edgeConfirmations[edgeKey(link)] || 'pending';
}

// confirmation state for a node/edge id:
//   "confirmed" | "rejected" | undefined (= pending)
function statusOf(item) {
  // Project nodes are always confirmed (they're your anchors, not AI output)
  if (item.type === 'project') return 'confirmed';
  if (item.confirmed === true) return 'confirmed';
  return confirmations[item.id] || 'pending';
}

// -------------------- Color & sizing --------------------
// Tuned for the platform's light background (#f7f8fa); legend dots in index.html use the same values
const NODE_COLOR = {
  project:   '#d1495b',
  concept:   '#2f5bd3',
  paper:     '#2e9e6b',
  book:      '#3a9ca8',
  highlight: '#d9a33a',
  question:  '#e07a2f',
  comment:   '#a463b8',
};

function nodeColor(n) {
  const base = NODE_COLOR[n.subtype] || NODE_COLOR[n.type] || '#8a93a3';
  const status = statusOf(n);
  // If lens active and this node not matched → very dim grey
  if (n._matched === false) return '#dde1e7';
  if (status === 'rejected') return '#efd3d0';
  if (status === 'pending')  return base + '88';
  return base;
}

// Decide which nodes get persistent floating labels (avoid clutter at 700 nodes)
function shouldShowLabel(n) {
  if (n.type === 'project') return true;
  if (n.type === 'question') return true;
  if (n.type === 'concept') return true;          // 47 concepts — OK to label all
  if (n.type === 'highlight') return false;       // 319 highlights → too noisy
  if (n.type === 'source') {
    // Only "important" sources: many highlights OR has a comment from you
    if ((n.highlights_count || 0) >= 30) return true;
    if ((n.highlights || []).some(h => h.yue_comment)) return true;
    return false;
  }
  return false;
}

// Higher wins when labels collide: projects, then heavy concepts, questions, then sources
function labelPriority(n) {
  if (n.type === 'project') return 10000;
  if (n.type === 'concept') return 1000 + (n.weight || 0) * 10;
  if (n.type === 'question') return 800;
  if (n.type === 'source') return 100 + Math.min(500, n.highlights_count || 0);
  return 0;
}

function labelTextHeight(n) {
  if (n.type === 'project') return 7;
  if (n.type === 'concept') return 4 + (n.weight || 0) * 0.4;
  if (n.type === 'question') return 4;
  if (n.type === 'source') return 3.5;
  return 3;
}

function nodeSize(n) {
  let base;
  if (n.type === 'project') base = 14;
  else if (n.type === 'concept') base = 6 + (n.weight || 0) * 1.5;
  else if (n.type === 'highlight') base = 3;
  else if (n.type === 'question') base = 5;
  else base = 5 + (n.weight || 0) * 0.8;
  // Matched nodes get a slight boost so they pop
  if (n._matched === true && n._boostable !== false) base *= 1.4;
  return base;
}

function nodeOpacityFn(n) {
  if (n._matched === false) return 0.12;
  return 0.95;
}

// All edges share one grey (mono); types differ by width + arrows + dashes
const EDGE_COLOR_BASE = '#8a93a3';
const EDGE_COLOR = {
  cites:        EDGE_COLOR_BASE,
  instantiates: EDGE_COLOR_BASE,
  relates_to:   EDGE_COLOR_BASE,
  echoes:       EDGE_COLOR_BASE,
  contradicts:  EDGE_COLOR_BASE,
  extends:      EDGE_COLOR_BASE,
  answers:      EDGE_COLOR_BASE,
};
// Type shapes:
//   cites        thin + arrow (directed, citation)
//   instantiates medium + arrow (directed, concept → instance)
//   extends      thick + arrow (directed, builds on)
//   answers      medium + arrow (directed, answer)
//   contradicts  medium + two-way arrows (conflict)
//   relates_to   medium, no arrow (symmetric)
//   echoes       medium dashed (symmetric, loose "echo" relation)
const EDGE_BASE_WIDTH = {
  cites: 0.4, relates_to: 0.7, instantiates: 0.7,
  echoes: 0.6, extends: 1.2, contradicts: 0.7, answers: 0.7,
};
const EDGE_HAS_ARROW = new Set(['cites', 'instantiates', 'extends', 'answers', 'contradicts']);
const EDGE_DASHED = new Set(['echoes']);

function linkColor(l) {
  const base = EDGE_COLOR[l.type] || '#444';
  if (l._matched === false) return '#eceef2';
  const sId = idOf(l.source), tId = idOf(l.target);
  const sNode = allData.nodes.find(n => n.id === sId);
  const tNode = allData.nodes.find(n => n.id === tId);
  if (!sNode || !tNode) return base;
  // Hide edge if either endpoint rejected
  if (statusOf(sNode) === 'rejected' || statusOf(tNode) === 'rejected') return '#eceef2';
  // Edge has its OWN status now (independent of nodes)
  const es = edgeStatusOf(l);
  if (es === 'rejected') return '#eceef2';
  if (es === 'confirmed') return base;
  // pending: dim
  return base + '44';
}

function linkWidth(l) {
  if (l._matched === false) return 0.15;
  const sId = idOf(l.source), tId = idOf(l.target);
  const sNode = allData.nodes.find(n => n.id === sId);
  const tNode = allData.nodes.find(n => n.id === tId);
  if (sNode && (statusOf(sNode) === 'rejected') || tNode && statusOf(tNode) === 'rejected') return 0.05;
  const es = edgeStatusOf(l);
  if (es === 'rejected') return 0.05;
  // Highlight the edge currently under review
  if (reviewMode && reviewIndex < reviewQueue.length && allData.links[reviewQueue[reviewIndex]] === l) {
    return 4.0;
  }
  // base width by type
  const base = EDGE_BASE_WIDTH[l.type] || 0.5;
  return es === 'confirmed' ? base * 2.5 : base;
}

function linkOpacityFn(l) {
  return l._matched === false ? 0.05 : 0.7;
}

function idOf(endpoint) {
  return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

// -------------------- Graph init --------------------
async function init() {
  // Graph data from DB-backed API
  const resp = await fetch(`${API_BASE}/graph`);
  if (!resp.ok) throw new Error(await apiErrorMessage(resp));
  allData = await resp.json();

  // Sanitize: drop links that reference nodes not present in the nodes array.
  // ForceGraph3D throws "node not found" and aborts rendering if any orphan link exists.
  const nodeIds = new Set(allData.nodes.map(n => n.id));
  const beforeLinks = allData.links.length;
  allData.links = allData.links.filter(l => {
    const sId = typeof l.source === 'object' ? l.source.id : l.source;
    const tId = typeof l.target === 'object' ? l.target.id : l.target;
    return nodeIds.has(sId) && nodeIds.has(tId);
  });
  const droppedLinks = beforeLinks - allData.links.length;
  if (droppedLinks > 0) console.warn(`dropped ${droppedLinks} orphan link(s) referencing missing nodes`);

  // Hydrate state from DB (overwrites localStorage defaults)
  await loadStateFromServer();

  // Pin project nodes around a circle
  const projects = allData.nodes.filter(n => n.type === 'project');
  projects.forEach((n, i) => {
    const angle = (i / Math.max(projects.length, 1)) * Math.PI * 2;
    const r = 240;
    n.fx = Math.cos(angle) * r;
    n.fy = Math.sin(angle) * r;
    n.fz = 0;
  });

  graph = ForceGraph3D()(document.getElementById('graph'))
    .backgroundColor('#f7f8fa')
    .nodeLabel(n => `<div style="background:#fff;border:1px solid #e3e6eb;box-shadow:0 2px 8px rgba(0,0,0,.08);padding:6px 10px;border-radius:6px;font-size:12px;color:#1f2430;font-family:Inter,-apple-system,sans-serif;">${escapeHtml(n.label)}<br><span style="color:var(--muted);font-size:10px;">${n.type}${statusOf(n) === 'pending' ? ' · pending' : ''}</span></div>`)
    .nodeColor(nodeColor)
    .nodeVal(nodeSize)
    .nodeOpacity(0.95)
    .nodeResolution(12)
    .linkColor(linkColor)
    .linkWidth(linkWidth)
    .linkOpacity(0.7)
    .nodeVisibility(n => n._matched !== false || true)
    .linkDirectionalArrowLength(l => EDGE_HAS_ARROW.has(l.type) ? 3.5 : 0)
    .linkDirectionalArrowRelPos(0.7)
    .linkDirectionalArrowColor(() => EDGE_COLOR_BASE)
    .linkDirectionalParticles(l => EDGE_DASHED.has(l.type) ? 3 : 0)
    .linkDirectionalParticleWidth(0.8)
    .linkDirectionalParticleSpeed(0.004)
    .linkDirectionalParticleColor(() => EDGE_COLOR_BASE)
    .linkLabel(l => l.label || l.type)
    .onNodeClick(node => {
      // auto-expand the sidebar (if it was hidden via ⛶)
      if (document.body.classList.contains('sidebar-hidden')) {
        document.body.classList.remove('sidebar-hidden');
        localStorage.setItem(SIDEBAR_HIDDEN_KEY, '0');
        const btn = document.getElementById('sidebarToggle');
        if (btn) btn.textContent = '⛶';
      }
      navigateTo(node);
    })
    .onNodeRightClick(node => {
      if (document.body.classList.contains('sidebar-hidden')) {
        document.body.classList.remove('sidebar-hidden');
        localStorage.setItem(SIDEBAR_HIDDEN_KEY, '0');
        const btn = document.getElementById('sidebarToggle');
        if (btn) btn.textContent = '⛶';
      }
      navigateTo(node);
    })
    .graphData(applyFilters(allData));

  // Boost charge so things spread out
  graph.d3Force('charge').strength(-180);
  graph.d3Force('link').distance(l => {
    if (l.type === 'cites') return 30;
    if (l.type === 'relates_to') return 90;
    return 60;
  });

  updateStats();
  updatePendingCount();
  wireFilters();
  setupLabelsOverlay();
  // Apply stored theme (toggles graph background to match)
  applyTheme(localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark');
  // initial sidebar shows tabs + empty detail
  renderSidebar();
}

// -------------------- HTML overlay node labels --------------------
// Use HTML divs absolutely positioned on top of the canvas, updated each frame
// by manually projecting node 3D positions to screen coords. No external deps.
let labelsLayer = null;
const labelElements = new Map(); // node.id -> { el, lastVisible }

function setupLabelsOverlay() {
  if (labelsLayer) return;
  labelsLayer = document.createElement('div');
  labelsLayer.id = 'labels-layer';
  document.getElementById('graph').appendChild(labelsLayer);
  requestAnimationFrame(updateLabelsLoop);
}

function projectToScreen(x, y, z, camera, w, h) {
  const mwi = camera.matrixWorldInverse.elements;
  const pm  = camera.projectionMatrix.elements;
  // mwi * [x,y,z,1] → view
  const vx = mwi[0]*x + mwi[4]*y + mwi[8]*z  + mwi[12];
  const vy = mwi[1]*x + mwi[5]*y + mwi[9]*z  + mwi[13];
  const vz = mwi[2]*x + mwi[6]*y + mwi[10]*z + mwi[14];
  const vw = mwi[3]*x + mwi[7]*y + mwi[11]*z + mwi[15];
  // pm * view → clip
  const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz  + pm[12]*vw;
  const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz  + pm[13]*vw;
  const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15]*vw;
  if (cw <= 0.0001) return null; // behind camera
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  if (ndcX < -1.3 || ndcX > 1.3 || ndcY < -1.3 || ndcY > 1.3) return null;
  return [
    (ndcX * 0.5 + 0.5) * w,
    (-ndcY * 0.5 + 0.5) * h,
    cw,  // depth (for sizing fade)
  ];
}

function updateLabelsLoop() {
  if (!labelsLayer || !graph || !allData) {
    requestAnimationFrame(updateLabelsLoop);
    return;
  }
  const camera = graph.camera && graph.camera();
  const renderer = graph.renderer && graph.renderer();
  if (!camera || !renderer) {
    requestAnimationFrame(updateLabelsLoop);
    return;
  }
  const canvas = renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // 1) project every labelled node; 2) place labels by priority and hide any that would
  //    overlap one already placed (keeps the map readable at 1500+ nodes / in a narrow embed).
  const cands = [];
  allData.nodes.forEach(n => {
    if (!shouldShowLabel(n)) return;
    if (n.x === undefined) return;
    let entry = labelElements.get(n.id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'node-label label-' + n.type;
      const label = getDisplayLabel(n);
      el.textContent = label.length > 24 ? label.slice(0, 22) + '…' : label;
      // Make label clickable as proxy for the node
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (document.body.classList.contains('sidebar-hidden')) {
          document.body.classList.remove('sidebar-hidden');
          localStorage.setItem(SIDEBAR_HIDDEN_KEY, '0');
          const btn = document.getElementById('sidebarToggle');
          if (btn) btn.textContent = '⛶';
        }
        navigateTo(n);
      });
      labelsLayer.appendChild(el);
      entry = {el, w: 0, h: 0};
      labelElements.set(n.id, entry);
    }
    if (!entry.w) { entry.w = entry.el.offsetWidth; entry.h = entry.el.offsetHeight; }
    if (n._matched === false) { entry.el.classList.add('label-hidden'); return; }
    const proj = projectToScreen(n.x, n.y, n.z || 0, camera, w, h);
    if (!proj) { entry.el.classList.add('label-hidden'); return; }
    cands.push({n, entry, proj, pri: labelPriority(n)});
  });
  cands.sort((a, b) => (b.pri - a.pri) || (a.proj[2] - b.proj[2]));
  const placed = [];
  const PAD = 3;
  for (const c of cands) {
    const {entry, proj} = c;
    const bw = entry.w || 80, bh = entry.h || 14;
    // .node-label is translate(-50%, -150%): box sits centred above the node
    const x0 = proj[0] - bw / 2 - PAD, x1 = proj[0] + bw / 2 + PAD;
    const y0 = proj[1] - bh * 1.5 - PAD, y1 = proj[1] - bh * 0.5 + PAD;
    const hit = c.n.type !== 'project' && placed.some(r => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
    if (hit) { entry.el.classList.add('label-hidden'); continue; }
    placed.push([x0, y0, x1, y1]);
    entry.el.classList.remove('label-hidden');
    entry.el.style.left = `${proj[0]}px`;
    entry.el.style.top = `${proj[1]}px`;
    // Subtle fade by depth — farther nodes' labels get dimmer
    const opacity = Math.max(0.35, Math.min(1, 400 / proj[2]));
    entry.el.style.opacity = String(opacity);
  }

  requestAnimationFrame(updateLabelsLoop);
}

function focusOnNode(node) {
  const dist = 140;
  const r = Math.hypot(node.x || 1, node.y || 1, node.z || 1);
  const ratio = 1 + dist / r;
  graph.cameraPosition(
    { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
    node,
    1200
  );
}

// -------------------- Filtering / matching --------------------
// Mark each node's _matched flag based on active lens. Doesn't remove nodes
// — the graph layout stays stable so spatial memory is preserved.
function computeMatched() {
  const lensActive = (activeProjectFilter !== 'all') || (activeDomains.size > 0) || (activeTypes.size > 0);

  if (!lensActive) {
    allData.nodes.forEach(n => { n._matched = true; });
    allData.links.forEach(l => { l._matched = true; });
    return;
  }

  // Compute nodes matching the project lens (2-hop) and/or domain lens (1-hop). AND them.
  let projectMatches = null;
  if (activeProjectFilter !== 'all') {
    const t = activeProjectFilter;
    const set = new Set([t]);
    allData.links.forEach(l => {
      const s = idOf(l.source), tt = idOf(l.target);
      if (s === t) set.add(tt);
      if (tt === t) set.add(s);
    });
    const oneHop = new Set(set);
    allData.links.forEach(l => {
      const s = idOf(l.source), tt = idOf(l.target);
      if (oneHop.has(s)) set.add(tt);
      if (oneHop.has(tt)) set.add(s);
    });
    projectMatches = set;
  }

  let domainMatches = null;
  if (activeDomains.size > 0) {
    const direct = new Set();
    allData.nodes.forEach(n => {
      const doms = n.domains || [];
      if (doms.some(d => activeDomains.has(d))) direct.add(n.id);
      if (n.type === 'project') direct.add(n.id); // anchors always
    });
    const expanded = new Set(direct);
    allData.links.forEach(l => {
      const s = idOf(l.source), t = idOf(l.target);
      if (direct.has(s)) expanded.add(t);
      if (direct.has(t)) expanded.add(s);
    });
    domainMatches = expanded;
  }

  // type filter (exact, no neighbour expansion)
  let typeMatches = null;
  if (activeTypes.size > 0) {
    typeMatches = new Set();
    allData.nodes.forEach(n => {
      if (activeTypes.has(n.type) || (n.subtype && activeTypes.has(n.subtype))) {
        typeMatches.add(n.id);
      }
    });
  }

  allData.nodes.forEach(n => {
    let m = true;
    if (projectMatches && !projectMatches.has(n.id)) m = false;
    if (domainMatches && !domainMatches.has(n.id)) m = false;
    if (typeMatches && !typeMatches.has(n.id)) m = false;
    n._matched = m;
  });
  allData.links.forEach(l => {
    const s = idOf(l.source), t = idOf(l.target);
    const sN = allData.nodes.find(n => n.id === s);
    const tN = allData.nodes.find(n => n.id === t);
    l._matched = !!(sN && tN && sN._matched && tN._matched);
  });
}

// Status filters hide nodes (binary content filter, not a lens)
function applyConfirmedFilter(data) {
  if (!onlyConfirmed && !onlyPending) return data;
  let nodes = data.nodes;
  if (onlyConfirmed) {
    nodes = nodes.filter(n => statusOf(n) === 'confirmed');
  } else if (onlyPending) {
    // pending = not confirmed, not rejected; exclude data-confirmed (projects, your highlights)
    nodes = nodes.filter(n => statusOf(n) === 'pending');
  }
  const ids = new Set(nodes.map(n => n.id));
  let links = data.links.filter(l => ids.has(idOf(l.source)) && ids.has(idOf(l.target)));
  if (onlyConfirmed) {
    links = links.filter(l => l.confirmed === true || statusOf(l) === 'confirmed');
  }
  return { nodes, links };
}

function applyFilters(data) {
  // Just mark match state; everything stays visible.
  computeMatched();
  return applyConfirmedFilter(data);
}

function refresh() {
  graph.graphData(applyFilters(allData));
  // Force re-evaluation of node/link visual properties
  if (graph.nodeColor) {
    graph.nodeColor(nodeColor).linkColor(linkColor).linkWidth(linkWidth);
  }
  updateStats();
  updatePendingCount();
}

function renderProjectFilters() {
  const holder = document.getElementById('project-filter-buttons');
  if (!holder) return;
  const projects = allData.nodes
    .filter(n => n.type === 'project')
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
  holder.innerHTML = projects.map(n => {
    const label = n.label || String(n.id).replace(/^project:/, '');
    const active = activeProjectFilter === n.id ? ' active' : '';
    return `<button class="filter-btn${active}" data-filter="${escapeHtml(n.id)}">${escapeHtml(label)}</button>`;
  }).join('');
}

function wireFilters() {
  renderProjectFilters();
  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeProjectFilter = btn.dataset.filter;
      refresh();
    });
  });
  // Old "confirmed only / pending only" filter buttons are gone; node review replaces them.
  // Keep the state in case we want to re-add filter later.

  renderDomainChips();
}

function renderDomainChips() {
  const container = document.getElementById('domain-chips');
  if (!container) return;
  const domains = (allData.meta && allData.meta.domains) || [];
  // Sort by count desc
  const sorted = [...domains].sort((a, b) => (b.count || 0) - (a.count || 0));
  container.innerHTML = sorted.map(d => {
    const active = activeDomains.has(d.id) ? 'active' : '';
    return `<button class="filter-btn ${active}" data-domain="${d.id}"
                    onclick="toggleDomain('${d.id}')"
                    style="${active ? `background:${d.color};border-color:${d.color};color:#fff;` : `border-color:${d.color};color:${d.color};`}"
                    title="${d.count} nodes">${d.label} <span style="opacity:0.7;font-size:9px;">${d.count}</span></button>`;
  }).join('');
}

window.toggleDomain = function(id) {
  if (activeDomains.has(id)) activeDomains.delete(id);
  else activeDomains.add(id);
  document.getElementById('domain-all').classList.toggle('active', activeDomains.size === 0);
  renderDomainChips();
  updateDomainActiveCount();
  refresh();
};

window.clearDomains = function() {
  activeDomains.clear();
  document.getElementById('domain-all').classList.add('active');
  renderDomainChips();
  updateDomainActiveCount();
  refresh();
};

let domainRowOpen = false;
window.toggleDomainRow = function() {
  domainRowOpen = !domainRowOpen;
  document.getElementById('domain-toggle-arrow').textContent = domainRowOpen ? '▼' : '▶';
  document.getElementById('domain-all').style.display = domainRowOpen ? '' : 'none';
  document.getElementById('domain-chips').style.display = domainRowOpen ? 'inline-flex' : 'none';
};

function updateDomainActiveCount() {
  const el = document.getElementById('domain-active-count');
  if (el) el.textContent = activeDomains.size > 0 ? `(${activeDomains.size})` : '';
}

function updateStats() {
  const matchedCount = allData.nodes.filter(n => n._matched !== false).length;
  const confirmedCount = allData.nodes.filter(n => statusOf(n) === 'confirmed').length;
  const total = allData.nodes.length;
  const lensActive = (activeProjectFilter !== 'all') || (activeDomains.size > 0);
  document.getElementById('stats').textContent = lensActive
    ? `${matchedCount}/${total} nodes lit · ${confirmedCount} confirmed`
    : `${total} nodes · ${allData.links.length} links · ${confirmedCount} confirmed`;
}

function updatePendingCount() {
  const pending = allData.nodes.filter(n => statusOf(n) === 'pending').length;
  const el = document.getElementById('pendingCount');
  if (pending > 0) {
    el.style.display = 'block';
    el.textContent = `🟡 ${pending} awaiting review`;
  } else {
    el.style.display = 'none';
  }
}

// -------------------- Sidebar header (tabs) --------------------
function renderTabs() {
  return `<div class="sb-tabs">
    <button class="sb-tab ${sidebarMode === 'detail' ? 'active' : ''}" onclick="switchSidebar('detail')">📍 Details</button>
    <button class="sb-tab ${sidebarMode === 'list' ? 'active' : ''}" onclick="switchSidebar('list')">📋 Node list</button>
  </div>`;
}

window.switchSidebar = function(mode) {
  sidebarMode = mode;
  renderSidebar();
};

// -------------------- Sidebar (router) --------------------
function renderSidebar(node) {
  if (node !== undefined) lastFocusedNode = node;
  const sb = document.getElementById('sidebar-content');
  if (sidebarMode === 'list') {
    sb.innerHTML = renderTabs() + renderList();
    wireListSearch();
  } else {
    sb.innerHTML = renderTabs() + renderDetail(lastFocusedNode);
    if (document.getElementById('agentStatus')) {
      checkAgent();
      if (lastFocusedNode) loadAgentHistory(lastFocusedNode.id);
    }
    // load concept-specific sources
    if (lastFocusedNode && lastFocusedNode.type !== 'source' && lastFocusedNode.type !== 'project') {
      loadNodeContext(lastFocusedNode.id);
    }
  }
}

window.loadAllHighlights = async function(nodeId) {
  const list = document.getElementById(`hl-list-${nodeId}`);
  if (!list) return;
  list.innerHTML += `<div style="text-align:center;padding:8px;color:var(--text-dim);font-size:11px;">Loading…</div>`;
  try {
    const res = await apiGet(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}/highlights`);
    const highs = res.highlights || [];
    let html = '';
    highs.forEach(h => {
      if (h.is_standalone_note) {
        html += `<div style="background:var(--surface-2);border-left:3px solid #9580ff;padding:8px 12px;margin:6px 0;border-radius:0 4px 4px 0;font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;">
          <div class="meta" style="color:#9580ff;font-size:9px;">📝 Note</div>${escapeHtml(h.text)}</div>`;
      } else if (h.image_path) {
        html += `<div class="quote" style="padding:6px 8px;">`;
        if (h.page) html += `<div class="meta">p.${h.page} · 🖼 Screenshot</div>`;
        html += `<img src="${API_BASE}/${escapeHtml(h.image_path)}" loading="lazy" alt="screenshot"
                      style="max-width:100%;border-radius:3px;cursor:zoom-in;display:block;margin-top:4px;"
                      onclick="window.open(this.src, '_blank')">`;
        if (h.text) html += `<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${escapeHtml(h.text)}</div>`;
        html += `</div>`;
        if (h.yue_comment) html += `<div class="user-comment">${escapeHtml(h.yue_comment)}</div>`;
      } else {
        const typeLabel = h.annotation_type === 'underline' ? '_underline_ ' : '';
        html += `<div class="quote">`;
        if (h.page) html += `<div class="meta">p.${h.page}${typeLabel ? ' · ' + typeLabel : ''}</div>`;
        html += `${escapeHtml(h.text)}</div>`;
        if (h.yue_comment) html += `<div class="user-comment">${escapeHtml(h.yue_comment)}</div>`;
      }
    });
    list.innerHTML = html;
    // Remove the load-more button after parent div
    const sec = list.parentElement;
    const button = sec.querySelector('button[onclick*="loadAllHighlights"]');
    if (button) button.parentElement.remove();
  } catch (e) {
    list.innerHTML += `<div style="color:#c95e5e;font-size:11px;">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
};

async function loadNodeContext(nodeId) {
  const el = document.getElementById(`ctx-${nodeId}`);
  if (!el) return;
  try {
    const res = await apiGet(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}/context`);
    const contexts = res.contexts || [];
    if (contexts.length === 0) {
      el.innerHTML = `<div style="font-style:italic;color:var(--text-faint);">(no linked sources found)</div>`;
      return;
    }
    let html = '';
    contexts.forEach(({source, hops, highlights}) => {
      const hopHint = hops > 1 ? ` <span style="color:var(--text-faint);font-size:9px;">(${hops} hops)</span>` : '';
      html += `<div style="margin-top:10px;"><div style="font-size:11px;color:#227a52;margin-bottom:4px;">📚 ${escapeHtml(source.label)}${hopHint}</div>`;
      highlights.forEach(h => {
        html += `<div class="quote">`;
        if (h.page) html += `<div class="meta">p.${h.page}</div>`;
        html += `${escapeHtml(h.text)}</div>`;
        if (h.yue_comment) {
          html += `<div class="user-comment">${escapeHtml(h.yue_comment)}</div>`;
        }
      });
      html += `</div>`;
    });
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div style="color:#c95e5e;">Failed to load sources: ${escapeHtml(e.message)}</div>`;
  }
}

function renderDetail(node) {
  if (!node) {
    return `<div class="empty-state">
      <strong>Second Brain</strong><br><br>
      Left-drag · rotate<br>
      Scroll · zoom<br>
      Click a node · details<br><br>
      Or switch to <strong>📋 Node list</strong> to browse everything
    </div>`;
  }
  const status = statusOf(node);

  let html = '';
  // Type tag
  const tagColors = {
    project:   {bg: '#fbe9eb', color: '#b02a3e'},
    concept:   {bg: '#e9effc', color: '#2f5bd3'},
    paper:     {bg: '#e6f5ee', color: '#227a52'},
    book:      {bg: '#e5f3f5', color: '#2a7a85'},
    highlight: {bg: '#fbf3e2', color: '#9a6b12'},
    question:  {bg: '#fdeee3', color: '#b55a1a'},
  };
  const subtype = node.subtype || node.type;
  const tag = tagColors[subtype] || {bg: '#f1f3f6', color: '#6b7280'};
  // Type tag — double-click to edit via inline dropdown
  const tagId = `type-tag-${node.id}`;
  const labelTxt = `${node.type}${node.subtype ? ' · ' + node.subtype : ''}`;
  const editable = (node.type === 'concept' || node.type === 'question' || node.type === 'source');
  html += `<span class="type-tag" id="${tagId}" style="background:${tag.bg};color:${tag.color};${editable ? 'cursor:pointer;' : ''}"
                ${editable ? `ondblclick="openTypeEditor('${node.id}')"` : ''}
                title="${editable ? 'Double-click to change type' : ''}">${labelTxt}${editable ? ' ✎' : ''}</span>`;
  const displayLabel = getDisplayLabel(node);
  const isRenamed = !!nodeRenames[node.id];
  html += `<h2 style="display:flex;align-items:flex-start;gap:8px;">
    <span style="flex:1;">${escapeHtml(displayLabel)}</span>
    <button onclick="renameNode('${node.id}')" title="${isRenamed ? 'Original name: ' + escapeHtml(node.label) + '\\nClick to edit' : 'Click to rename (display only, data unchanged)'}"
            style="background:transparent;border:1px solid var(--line);color:${isRenamed ? '#f4a261' : 'var(--muted)'};padding:2px 8px;border-radius:4px;font-size:11px;cursor:pointer;flex-shrink:0;line-height:1.4;">✎${isRenamed ? ' renamed' : ''}</button>
  </h2>`;
  if (isRenamed) {
    html += `<div style="font-size:10px;color:var(--muted);margin:-4px 0 8px 0;">Original: ${escapeHtml(node.label)}</div>`;
  }

  // Find duplicate-label candidates for merge
  const dupes = allData.nodes.filter(n =>
    n.id !== node.id &&
    n.type === node.type &&
    (getDisplayLabel(n).toLowerCase().trim() === getDisplayLabel(node).toLowerCase().trim() ||
     getDisplayLabel(n).includes(getDisplayLabel(node)) ||
     getDisplayLabel(node).includes(getDisplayLabel(n)))
  );
  if (dupes.length > 0) {
    const expanded = expandedMerges.has(node.id);
    const safeNodeId = node.id.replace(/['"\\]/g, '\\$&');
    // compact toggle button (collapsed by default)
    html += `<div style="margin:4px 0 ${expanded ? '4px' : '10px'};">
      <button onclick="toggleMergeList('${safeNodeId}')"
              title="${dupes.length} same-name / similar nodes — click to see candidates"
              style="background:transparent;border:1px solid var(--confirm-border);color:var(--confirm-text);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;">
        🔀 ${dupes.length} similar ${expanded ? '▾' : '▸'}
      </button>
    </div>`;
    if (expanded) {
      html += `<div style="display:flex;flex-direction:column;gap:4px;margin:0 0 10px;">`;
      dupes.forEach(d => {
        const dLabel = getDisplayLabel(d);
        const hl = d.highlights_count ? `${d.highlights_count}h` : (d.weight ? `w${d.weight}` : '');
        const author = d.author ? ` · ${d.author.split(/[,;]/)[0].trim()}` : '';
        const year = d.year ? ` · ${d.year}` : '';
        const subtype = d.subtype ? d.subtype : d.type;
        const meta = `${subtype}${hl ? ' · ' + hl : ''}${author}${year}`;
        const safeTgt = d.id.replace(/['"\\]/g, '\\$&');
        const safeSrcLbl = (getDisplayLabel(node) || '').replace(/['"\\]/g, '\\$&');
        const safeTgtLbl = dLabel.replace(/['"\\]/g, '\\$&');
        html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface);border:1px solid var(--border);">
          <div style="flex:1;min-width:0;cursor:pointer;" onclick="jumpTo('${safeTgt}')">
            <div style="font-size:12px;color:var(--text);line-height:1.35;">${escapeHtml(dLabel)}</div>
            <div style="font-size:10px;color:var(--text-faint);margin-top:2px;letter-spacing:0.05em;">${escapeHtml(meta)}</div>
          </div>
          <button onclick="event.stopPropagation();confirmMerge('${safeNodeId}','${safeTgt}','${safeSrcLbl}','${safeTgtLbl}')"
                  title="Merge the current node into this one"
                  style="background:transparent;border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:0;cursor:pointer;font-size:12px;font-family:inherit;flex-shrink:0;">✓ Merge</button>
        </div>`;
      });
      html += `</div>`;
    }
  }
  // No "merge into another node" button without same-name nodes — merge only appears when duplicates are detected

  // Confirmation status is managed via the list view's row strips (✓/✗/↶); no inline banner needed.

  // Description (click to edit inline) — no whitespace around content; pre-wrap would show it
  html += `<div id="detail-view-${node.id}" onclick="editDetail('${node.id}')" title="Click to edit" style="cursor:text;padding:2px 0;border-radius:3px;font-size:13px;line-height:1.55;color:var(--text-dim);white-space:pre-wrap;${!node.detail ? 'font-style:italic;color:var(--text-faint);' : ''}">${node.detail ? escapeHtml(node.detail) : 'Click to add a description…'}</div>`;

  // 💭 My thoughts — click-to-edit pattern (same UX as description)
  if (node.type !== 'question') {
    const text = nodeNotes[node.id]?.text || '';
    html += `<div style="margin:14px 0 8px;">
      <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;display:flex;justify-content:space-between;">
        <span>💭 My thoughts</span>
        <span id="noteStatus-${node.id}" style="font-size:9px;color:var(--text-faint);text-transform:none;letter-spacing:0;"></span>
      </div>
      <div id="note-view-${node.id}" onclick="editNote('${node.id}')" title="Click to edit" style="cursor:text;padding:2px 0;border-radius:3px;font-size:12.5px;line-height:1.55;color:var(--text-dim);white-space:pre-wrap;${!text ? 'font-style:italic;color:var(--text-faint);' : ''}">${text ? escapeHtml(text) : 'Click to add your thoughts…'}</div>
    </div>`;
  }

  // Agent Q&A box — multi-turn conversation with history
  html += `<div class="agent-box">
    <div class="agent-title">
      🤖 Ask AI about this node
      <span style="display:flex;gap:8px;align-items:center;">
        <button onclick="clearAgentChat('${node.id}')"
                title="Clear chat history"
                style="background:transparent;border:none;color:var(--text-faint);cursor:pointer;font-size:10px;">🗑 Clear</button>
        <span class="agent-status" id="agentStatus">Checking…</span>
      </span>
    </div>
    <div id="agentHistory-${node.id}" style="margin-bottom:8px;max-height:320px;overflow-y:auto;padding-right:4px;"></div>
    <textarea class="agent-input" id="agentInput-${node.id}" placeholder="Empty = 'What is this? How does it relate to my research?' · or ask a follow-up · ⌘Enter to send"></textarea>
    <button class="agent-ask-btn" onclick="askAgent('${node.id}')">Ask (⌘Enter)</button>
  </div>`;

  // Question type — show answer with click-to-edit UX + promote button
  if (node.type === 'question') {
    const existingAnswer = answers[node.id] || '';
    html += `<h3 style="margin-top:14px;">Your answer</h3>
      <div id="ans-view-${node.id}" onclick="editAnswer('${node.id}')" title="Click to edit"
           style="cursor:text;padding:8px 10px;background:var(--surface-2);border-radius:5px;font-size:13px;line-height:1.55;color:var(--text);white-space:pre-wrap;min-height:36px;${!existingAnswer ? 'font-style:italic;color:var(--text-faint);' : ''}">${existingAnswer ? escapeHtml(existingAnswer) : 'Click to write an answer…'}</div>`;
    if (existingAnswer) {
      html += `<div style="margin-top:8px;display:flex;gap:6px;align-items:center;font-size:11px;color:var(--text-faint);">
        <span>Should this answer become its own node?</span>
        <button onclick="promoteAnswer('${node.id}','concept')"
                style="background:transparent;border:1px solid #4a8fe2;color:#4a8fe2;padding:2px 8px;border-radius:11px;cursor:pointer;font-size:10.5px;">→ concept</button>
        <button onclick="promoteAnswer('${node.id}','comment')"
                style="background:transparent;border:1px solid #d4a5d4;color:#d4a5d4;padding:2px 8px;border-radius:11px;cursor:pointer;font-size:10.5px;">→ comment</button>
        <button onclick="promoteAnswer('${node.id}','question')"
                style="background:transparent;border:1px solid #f4a261;color:#f4a261;padding:2px 8px;border-radius:11px;cursor:pointer;font-size:10.5px;">→ New question</button>
      </div>`;
    }
  }

  // 📖 Sources — async fetched via API for concept-specific highlights (collapsible)
  if (node.type !== 'source' && node.type !== 'project') {
    const secId = `ctx-${node.id}`;
    const collapsed = collapsedSections.has(secId);
    html += sectionToggle(secId, '📖 Sources');
    html += `<div id="sec-body-${secId}" style="${collapsed ? 'display:none;' : ''}"><div id="ctx-${node.id}" style="font-size:11px;color:var(--text-dim);padding:6px 0;">Loading…</div></div>`;
  }

  // Highlights for source/concept (collapsible, scrollable, lazy-loaded for sources)
  if (node.highlights && node.highlights.length > 0) {
    const secId = `highlights-${node.id}`;
    const collapsed = collapsedSections.has(secId);
    // For source nodes, show total count (lazy-load full list)
    const totalCount = node.type === 'source' ? (node.highlights_count || node.highlights.length) : node.highlights.length;
    html += sectionToggle(secId, 'Highlights', totalCount);
    html += `<div id="sec-body-${secId}" style="${collapsed ? 'display:none;' : ''}max-height:480px;overflow-y:auto;padding-right:4px;">
      <div id="hl-list-${node.id}">`;
    node.highlights.forEach(h => {
      console.log('[DEBUG hl render]', JSON.stringify(h));  // TEMP — remove after diagnosing image issue
      // Standalone note: render as longer markdown-like block
      if (h.is_standalone_note) {
        html += `<div style="background:var(--surface-2);border-left:3px solid #9580ff;padding:8px 12px;margin:6px 0;border-radius:0 4px 4px 0;font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;">
          <div class="meta" style="color:#9580ff;font-size:9px;">📝 Note</div>
          ${escapeHtml(h.text)}
        </div>`;
        return;
      }
      // Image annotation: show thumbnail
      if (h.image_path) {
        html += `<div class="quote" style="padding:6px 8px;">`;
        if (h.page) html += `<div class="meta">p.${h.page} · 🖼 Screenshot</div>`;
        html += `<img src="${API_BASE}/${escapeHtml(h.image_path)}" loading="lazy" alt="screenshot"
                      style="max-width:100%;border-radius:3px;cursor:zoom-in;display:block;margin-top:4px;"
                      onclick="window.open(this.src, '_blank')">`;
        if (h.text) html += `<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${escapeHtml(h.text)}</div>`;
        html += `</div>`;
        if (h.yue_comment) html += `<div class="user-comment">${escapeHtml(h.yue_comment)}</div>`;
        return;
      }
      // Default: text highlight / underline
      const typeLabel = h.annotation_type === 'underline' ? '_underline_ ' : '';
      html += `<div class="quote">`;
      if (h.page) html += `<div class="meta">p.${h.page}${typeLabel ? ' · ' + typeLabel : ''}</div>`;
      html += `${escapeHtml(h.text)}</div>`;
      if (h.yue_comment) {
        html += `<div class="user-comment">${escapeHtml(h.yue_comment)}</div>`;
      }
    });
    html += `</div>`;  // close hl-list-${node.id}
    if (node.type === 'source' && totalCount > node.highlights.length) {
      html += `<div style="text-align:center;padding:8px;color:var(--text-dim);font-size:11px;">
        <button onclick="loadAllHighlights('${node.id}')"
                style="background:transparent;border:1px solid var(--border);color:var(--text-dim);padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;">
          📜 Load all ${totalCount}
        </button>
      </div>`;
    }
    html += `</div>`;  // close sec-body
  }

  // Your comment on a single highlight node
  if (node.yue_comment) {
    html += `<h3>Your comment</h3>`;
    html += `<div class="user-comment">${escapeHtml(node.yue_comment)}</div>`;
  }

  // Related nodes (excluding rejected edges)
  const related = findRelated(node.id).filter(({edge}) =>
    edge.id === undefined || edgeConfirmations[String(edge.id)] !== 'rejected'
  );
  html += `<h3 style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
    <span style="flex:1;">Related (${related.length})</span>
    <button onclick="discoverRelated('${node.id}')"
            style="background:transparent;border:1px solid #4a8fe2;color:#4a8fe2;padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer;font-weight:400;text-transform:none;letter-spacing:0;">🔍 Scan all</button>
    <button onclick="openEdgeCreator('${node.id}')"
            style="background:transparent;border:1px solid #52b788;color:#52b788;padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer;font-weight:400;text-transform:none;letter-spacing:0;">➕ Add link</button>
  </h3>
  <div id="discover-panel-${node.id}" style="display:none;margin-bottom:10px;"></div>`;
  // Inline edge creator (hidden by default)
  html += `<div id="edge-creator-${node.id}" style="display:none;background:var(--tool);border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:10px;">
    <div style="font-size:11px;color:#227a52;margin-bottom:6px;">Add a link you found</div>
    <input type="text" id="ec-search-${node.id}" placeholder="Target node (search label)"
           oninput="filterEdgeTargets('${node.id}')"
           style="width:100%;background:var(--panel);border:1px solid var(--line);color:var(--text);padding:6px 8px;border-radius:4px;font-size:12px;box-sizing:border-box;margin-bottom:4px;">
    <div id="ec-targets-${node.id}" style="max-height:160px;overflow-y:auto;background:var(--panel);border-radius:4px;margin-bottom:6px;"></div>
    <div style="display:flex;gap:6px;margin-bottom:6px;">
      <select id="ec-type-${node.id}" style="flex:1;background:var(--panel);border:1px solid var(--line);color:var(--text);padding:5px;border-radius:4px;font-size:11.5px;">
        <option value="echoes">echoes</option>
        <option value="extends">extends</option>
        <option value="contradicts">contradicts</option>
        <option value="supports">supports</option>
        <option value="relates_to" selected>relates_to</option>
        <option value="instantiates">instantiates</option>
        <option value="answers">answers</option>
        <option value="cites">cites</option>
      </select>
      <input type="text" id="ec-label-${node.id}" placeholder="Label (optional)"
             style="flex:1;background:var(--panel);border:1px solid var(--line);color:var(--text);padding:5px;border-radius:4px;font-size:11.5px;">
    </div>
    <div style="display:flex;gap:6px;">
      <button onclick="createEdgeFromUI('${node.id}')"
              style="flex:1;background:#52b788;color:#fff;border:none;padding:6px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">✓ Create</button>
      <button onclick="closeEdgeCreator('${node.id}')"
              style="background:transparent;border:1px solid #444;color:var(--muted);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:11px;">Cancel</button>
    </div>
  </div>`;

  if (related.length > 0) {
    related.forEach(({node: n, edge}) => {
      const relLabel = edge.label || edge.type;
      // User-created edges marked with ✎
      const userMark = (edge.confirmed === true && edge.type !== 'cites') ? ' <span style="color:#52b788;font-size:9px;">✎</span>' : '';
      const dispLabel = getDisplayLabel(n);
      const safeRel = (relLabel || '').replace(/['"\\]/g, '\\$&');
      const safeLbl = (dispLabel || '').replace(/['"\\]/g, '\\$&');
      const removeBtn = (edge.id !== undefined)
        ? `<span class="rel-remove" onclick="event.stopPropagation();confirmRejectEdge('${edge.id}','${safeRel}','${safeLbl}')" title="Remove this link">×</span>`
        : '';
      html += `<div class="related-link" onclick="jumpTo('${n.id}')"><span class="rel-content"><span class="rel-type">${relLabel}</span>${escapeHtml(dispLabel)}${userMark}</span>${removeBtn}</div>`;
    });
  }

  // 🏷 domain chips — at the bottom (less distracting)
  if (node.type !== 'highlight' && node.type !== 'question') {
    const currentDoms = node.domains || [];
    const allDoms = (allData.meta && allData.meta.domains) || [];
    const inactive = allDoms.filter(d => !currentDoms.includes(d.id));
    html += `<div style="margin-top:18px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Topics</div>
      <div style="display:flex;flex-wrap:wrap;gap:3px;align-items:center;">`;
    currentDoms.forEach(domId => {
      const meta = allDoms.find(d => d.id === domId);
      if (!meta) return;
      // expand 3-digit hex to 6-digit so alpha suffix works
      let c = meta.color || '#888888';
      if (c.length === 4 && c.startsWith('#')) {
        c = '#' + c[1]+c[1] + c[2]+c[2] + c[3]+c[3];
      }
      html += `<span style="background:${c}22;border:1px solid ${c}66;color:${c};padding:1px 6px 1px 9px;border-radius:10px;font-size:10.5px;display:inline-flex;align-items:center;gap:4px;">
        ${meta.label}
        <span onclick="removeNodeDomain('${node.id}','${domId}')" title="Remove" style="cursor:pointer;font-size:12px;line-height:1;color:${c};opacity:0.5;">×</span>
      </span>`;
    });
    if (inactive.length > 0) {
      html += `<select onchange="addNodeDomain('${node.id}', this.value); this.value='';"
              style="background:transparent;border:1px dashed var(--border);color:var(--text-faint);padding:1px 4px;border-radius:10px;font-size:10.5px;cursor:pointer;">
        <option value="">+ Add</option>
        ${inactive.map(d => `<option value="${d.id}">${d.label}</option>`).join('')}
      </select>`;
    }
    html += `</div></div>`;
  }

  // Source metadata
  if (node.author || node.year || node.venue || node.doi || (node.zotero_tags && node.zotero_tags.length)) {
    html += `<h3>Metadata</h3>`;
    if (node.author) html += `<div class="meta-row"><span>Author</span><span style="color:var(--text);">${escapeHtml(node.author)}</span></div>`;
    if (node.year)   html += `<div class="meta-row"><span>Year</span><span style="color:var(--text);">${node.year}</span></div>`;
    if (node.venue)  html += `<div class="meta-row"><span>Venue</span><span style="color:var(--text);">${escapeHtml(node.venue)}</span></div>`;
    if (node.doi)    html += `<div class="meta-row"><span>DOI</span><span style="color:var(--text);">${escapeHtml(node.doi)}</span></div>`;
    if (node.zotero_tags && node.zotero_tags.length) {
      html += `<div style="margin-top:8px;font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.8px;">Zotero tags</div>`;
      html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">`;
      node.zotero_tags.forEach(t => {
        html += `<span style="background:var(--surface-3);color:var(--text-dim);padding:2px 8px;border-radius:10px;font-size:10.5px;">${escapeHtml(t)}</span>`;
      });
      html += `</div>`;
    }
  }

  return html;
}

// -------------------- List view --------------------
function renderList() {
  // Static header (input + type chips); body re-renders on filter / search.
  let html = `<input class="list-search" type="text" id="listSearchInput" placeholder="🔍 Search nodes / labels / descriptions…" value="${escapeHtml(listSearch)}">`;
  html += `<div id="listTypeFilter"></div>`;
  html += `<div id="listBody"></div>`;
  return html;
}

// IME-aware list body renderer (called from input + chip changes)
function renderListBody() {
  const groupKeyOf = (n) =>
    (n.type === 'source' && n.subtype) ? `source:${n.subtype}` : n.type;

  const typeOrder = ['project', 'concept', 'source:paper', 'source:book', 'highlight', 'question'];
  const typeLabel = {
    project: 'Projects',
    concept: 'Concepts',
    'source:paper': '📄 Papers',
    'source:book': '📚 Books',
    highlight: 'Highlights with comments',
    question: '🟠 Open questions',
  };

  const counts = {all: 0};
  allData.nodes.forEach(n => {
    const k = groupKeyOf(n);
    counts[k] = (counts[k] || 0) + 1;
    counts.all++;
  });

  // type filter chips (rendered into #listTypeFilter)
  const filterEl = document.getElementById('listTypeFilter');
  if (filterEl) {
    let chips = `<div class="list-type-filter">`;
    chips += `<span class="type-chip ${listTypeFilter === 'all' ? 'active' : ''}" onclick="setListType('all')">All (${counts.all})</span>`;
    typeOrder.forEach(t => {
      if (counts[t]) {
        chips += `<span class="type-chip ${listTypeFilter === t ? 'active' : ''}" onclick="setListType('${t}')">${typeLabel[t]} (${counts[t]})</span>`;
      }
    });
    chips += `</div>`;
    filterEl.innerHTML = chips;
  }

  let html = '';
  // Filter nodes (search both displayed label and original)
  const term = listSearch.trim().toLowerCase();
  const filtered = allData.nodes.filter(n => {
    if (listTypeFilter !== 'all' && groupKeyOf(n) !== listTypeFilter) return false;
    if (!term) return true;
    return getDisplayLabel(n).toLowerCase().includes(term)
        || (n.label || '').toLowerCase().includes(term)
        || (n.detail || '').toLowerCase().includes(term)
        || (n.yue_comment || '').toLowerCase().includes(term);
  });

  // Group by displayGroup (separates source:paper from source:book)
  const groups = {};
  filtered.forEach(n => {
    const k = groupKeyOf(n);
    if (!groups[k]) groups[k] = [];
    groups[k].push(n);
  });

  const bodyEl = document.getElementById('listBody');
  if (filtered.length === 0) {
    if (bodyEl) bodyEl.innerHTML = `<div class="list-empty">No matches</div>`;
    return;
  }

  typeOrder.forEach(t => {
    if (!groups[t] || groups[t].length === 0) return;
    if (listTypeFilter !== 'all' && listTypeFilter !== t) return;
    const collapsed = listCollapsed.has(t);
    html += `<div class="list-section">`;
    // Always render a clickable header (even when single-type filter is active)
    const arrow = collapsed ? '▶' : '▼';
    html += `<div class="list-section-header" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:4px 0;"
                  onclick="toggleListSection('${t}')">
      <span style="color:var(--muted);font-size:9px;width:8px;">${arrow}</span>
      <span>${typeLabel[t]} · ${groups[t].length}</span>
    </div>`;
    if (collapsed) {
      html += `</div>`;
      return;
    }
    // sort: confirmed first, then by label
    groups[t].sort((a, b) => {
      const sA = statusOf(a), sB = statusOf(b);
      if (sA !== sB) {
        const order = {confirmed: 0, pending: 1, rejected: 2};
        return (order[sA] ?? 3) - (order[sB] ?? 3);
      }
      return (a.label || '').localeCompare(b.label || '');
    });
    groups[t].forEach(n => {
      const status = statusOf(n);
      const dotColor = nodeColor(n);
      const baseColor = NODE_COLOR[n.subtype] || NODE_COLOR[n.type] || '#8a93a3';
      // three stacked signals: width + opacity + right-side badge
      let barWidth, barAlpha, badge, textStyle, actionStrips;
      const isLockedConfirmed = n.confirmed === true && !confirmations[n.id];
      if (status === 'confirmed') {
        barWidth = 7; barAlpha = 'FF';
        badge = `<span style="font-size:11px;color:#52b788;margin-left:6px;flex-shrink:0;">✓</span>`;
        textStyle = 'font-weight:500;';
        actionStrips = isLockedConfirmed ? '' :
          `<div class="row-action row-undo" onclick="event.stopPropagation();listConfirm('${n.id}','pending')" title="Undo confirmation">↶</div>`;
      } else if (status === 'rejected') {
        barWidth = 1; barAlpha = '15';
        badge = `<span style="font-size:11px;color:#c95e5e;margin-left:6px;flex-shrink:0;">✗</span>`;
        textStyle = 'color:var(--text-faint);text-decoration:line-through;';
        actionStrips =
          `<div class="row-action row-undo" onclick="event.stopPropagation();listConfirm('${n.id}','pending')" title="Undo → pending">↶</div>`;
      } else { // pending
        barWidth = 2; barAlpha = '70';
        badge = '';
        textStyle = 'color:var(--text-dim);';
        actionStrips =
          `<div class="row-action row-yes" onclick="event.stopPropagation();listConfirm('${n.id}','confirmed')" title="✓ Add to my brain">✓</div>
           <div class="row-action row-no" onclick="event.stopPropagation();listConfirm('${n.id}','rejected')" title="✗ No">✗</div>`;
      }
      const barColor = baseColor + barAlpha;
      const meta = n.highlights_count ? `${n.highlights_count}h` :
                   n.weight ? `w${n.weight}` : '';
      const displayLabel = getDisplayLabel(n);
      const renamed = nodeRenames[n.id] ? ' ✎' : '';
      html += `<div class="list-item" style="border-left:${barWidth}px solid ${barColor};">
        <div class="li-content" onclick="jumpTo('${n.id}')">
          <span class="list-item-dot" style="background:${dotColor}"></span>
          <span class="list-item-label" style="${textStyle}">${escapeHtml(displayLabel)}<span style="color:#f4a261;">${renamed}</span></span>
          <span class="list-item-meta">${meta}</span>
          ${badge}
        </div>
        ${actionStrips}
      </div>`;
    });
    html += `</div>`;
  });
  if (bodyEl) bodyEl.innerHTML = html;
}

function wireListSearch() {
  const input = document.getElementById('listSearchInput');
  if (!input) return;
  if (input._wired) {
    // Just re-render body without touching the input (preserves IME state)
    renderListBody();
    return;
  }
  input._wired = true;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let composing = false;
  let pending = null;

  // IME composition events: skip mid-composition updates
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', e => {
    composing = false;
    listSearch = e.target.value;
    renderListBody();
  });

  input.addEventListener('input', e => {
    if (composing) return;  // ignore mid-IME keystrokes
    listSearch = e.target.value;
    // debounce so rapid English typing doesn't spam re-renders
    clearTimeout(pending);
    pending = setTimeout(() => { renderListBody(); }, 50);
  });

  // Initial body render
  renderListBody();
}

window.setListType = function(t) {
  listTypeFilter = t;
  // Update just the body (don't replace the search input — that breaks IME)
  if (document.getElementById('listBody')) {
    renderListBody();
  } else {
    renderSidebar();
  }
};

// Inline ✓/✗ on a list row — doesn't navigate away, preserves scroll
window.listConfirm = async function(nodeId, status) {
  if (status === 'pending') delete confirmations[nodeId];
  else confirmations[nodeId] = status;
  // Update just the list body (keeps search input + IME state intact)
  if (sidebarMode === 'list' && document.getElementById('listBody')) {
    const sidebarEl = document.getElementById('sidebar');
    const scrollY = sidebarEl ? sidebarEl.scrollTop : 0;
    renderListBody();
    requestAnimationFrame(() => { if (sidebarEl) sidebarEl.scrollTop = scrollY; });
  }
  refresh();
  await persistNodeConfirmation(nodeId, status === 'pending' ? null : status);
};

window.toggleListSection = function(t) {
  if (listCollapsed.has(t)) listCollapsed.delete(t);
  else listCollapsed.add(t);
  localStorage.setItem('brain-list-collapsed', JSON.stringify([...listCollapsed]));
  // Only re-render body, keep input alive
  if (document.getElementById('listBody')) renderListBody();
};

function findRelated(nodeId) {
  const out = [];
  allData.links.forEach(l => {
    const s = idOf(l.source), t = idOf(l.target);
    let otherId = null;
    if (s === nodeId) otherId = t;
    else if (t === nodeId) otherId = s;
    if (otherId) {
      const other = allData.nodes.find(n => n.id === otherId);
      if (other) out.push({node: other, edge: l});
    }
  });
  return out;
}

// For a non-source node, walk 1-2 hops to find source nodes and their relevant highlights.
// Preference: user-commented highlights > highest-pages highlights.
function findContextSources(nodeId, maxDepth=2) {
  const visited = new Set([nodeId]);
  const found = []; // [{source, hops}]
  const queue = [{id: nodeId, depth: 0}];
  while (queue.length) {
    const {id, depth} = queue.shift();
    if (depth >= maxDepth) continue;
    allData.links.forEach(l => {
      const sId = idOf(l.source), tId = idOf(l.target);
      const otherId = sId === id ? tId : (tId === id ? sId : null);
      if (!otherId || visited.has(otherId)) return;
      visited.add(otherId);
      const other = allData.nodes.find(n => n.id === otherId);
      if (!other) return;
      if (other.type === 'source') {
        found.push({source: other, hops: depth + 1});
      } else {
        queue.push({id: otherId, depth: depth + 1});
      }
    });
  }
  // sort: closer hops first, then sources with yue_comment count
  found.sort((a, b) => {
    if (a.hops !== b.hops) return a.hops - b.hops;
    const aC = (a.source.highlights || []).filter(h => h.yue_comment).length;
    const bC = (b.source.highlights || []).filter(h => h.yue_comment).length;
    return bC - aC;
  });
  return found.slice(0, 4);
}

window.jumpTo = function(nodeId) {
  const n = allData.nodes.find(x => x.id === nodeId);
  if (!n) return;
  navigateTo(n);
};

// Remove a link (soft delete: marked rejected; can be undone in 🔍 Review links)
window.rejectEdge = async function(edgeId) {
  edgeConfirmations[String(edgeId)] = 'rejected';
  refresh();
  renderSidebar();
  try { await persistEdgeConfirmation(edgeId, 'rejected'); }
  catch (e) { console.warn('persistEdgeConfirmation failed:', e); }
};

// confirm before removing
window.confirmRejectEdge = function(edgeId, relType, nodeName) {
  const msg = `Remove link?\n\n${relType} → ${nodeName}\n\n(Can be undone in "🔍 Review links")`;
  if (confirm(msg)) {
    rejectEdge(edgeId);
  }
};

// -------------------- Confirmation actions --------------------
window.confirmNode = async function(nodeId, newStatus) {
  if (newStatus === 'pending') delete confirmations[nodeId];
  else confirmations[nodeId] = newStatus;
  refresh();
  const n = allData.nodes.find(x => x.id === nodeId);
  if (n) renderSidebar(n);
  await persistNodeConfirmation(nodeId, newStatus === 'pending' ? null : newStatus);
};

window.saveAnswer = async function(qNodeId) {
  const text = document.getElementById('answer-input').value.trim();
  if (!text) return;
  answers[qNodeId] = text;
  await persistAnswer(qNodeId, text);
  const synthId = `answer:${qNodeId}`;
  allData.nodes = allData.nodes.filter(n => n.id !== synthId);
  allData.links = allData.links.filter(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return s !== synthId && t !== synthId;
  });
  refresh();
  renderSidebar();
};

window.editAnswer = function(nodeId) {
  const view = document.getElementById(`ans-view-${nodeId}`);
  if (!view) return;
  const current = answers[nodeId] || '';
  view.outerHTML = `<textarea id="ans-edit-${nodeId}"
    onblur="saveAnswerInline('${nodeId}')"
    placeholder="Even one sentence is fine..."
    style="width:100%;min-height:80px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:5px;font-size:13px;font-family:inherit;line-height:1.55;box-sizing:border-box;resize:vertical;">${escapeHtml(current)}</textarea>`;
  document.getElementById(`ans-edit-${nodeId}`).focus();
};

window.saveAnswerInline = async function(nodeId) {
  const ta = document.getElementById(`ans-edit-${nodeId}`);
  if (!ta) return;
  const text = ta.value.trim();
  const prev = answers[nodeId] || '';
  if (text !== prev) {
    if (!text) delete answers[nodeId];
    else answers[nodeId] = text;
    await persistAnswer(nodeId, text);
  }
  const display = answers[nodeId] || '';
  ta.outerHTML = `<div id="ans-view-${nodeId}" onclick="editAnswer('${nodeId}')" title="Click to edit"
    style="cursor:text;padding:8px 10px;background:var(--surface-2);border-radius:5px;font-size:13px;line-height:1.55;color:var(--text);white-space:pre-wrap;min-height:36px;${!display ? 'font-style:italic;color:var(--text-faint);' : ''}">${display ? escapeHtml(display) : 'Click to write an answer…'}</div>`;
};

window.promoteAnswer = async function(qNodeId, newType) {
  const text = answers[qNodeId];
  if (!text) return;
  const qNode = allData.nodes.find(n => n.id === qNodeId);
  if (!qNode) return;
  const label = text.length > 40 ? text.slice(0, 38) + '…' : text;
  const detailPrefix = `(Promoted from the answer to the question "${qNode.label}")\n\n`;
  try {
    const res = await apiPost(`${API_BASE}/nodes/create`, {
      type: newType, label, detail: detailPrefix + text, weight: 3,
    });
    allData.nodes.push(res.node);
    const edgeRes = await apiPost(`${API_BASE}/edges/create`, {
      source: qNodeId, target: res.node.id, type: 'answers',
    });
    if (!edgeRes.duplicate) allData.links.push(edgeRes.edge);
    refresh();
    lastFocusedNode = res.node;
    sidebarMode = 'detail';
    renderSidebar();
  } catch (e) {
    showSyncError('Promote failed: ' + e.message);
  }
};

// Export confirmations
window.renameNode = async function(nodeId) {
  const node = allData.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const current = getDisplayLabel(node);
  const newName = prompt(`Rename this node\nOriginal name: ${node.label}\n(Leave empty to restore the original)`, current);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === node.label) {
    delete nodeRenames[nodeId];
  } else {
    nodeRenames[nodeId] = trimmed;
  }
  // Refresh label sprite
  const entry = labelElements.get(nodeId);
  if (entry && entry.el) { entry.el.remove(); labelElements.delete(nodeId); }
  renderSidebar();
  refresh();
  await persistRename(nodeId, trimmed === node.label ? '' : trimmed);
};

window.saveMyThought = async function(nodeId) {
  return autoSaveNote(nodeId);
};

window.editNote = function(nodeId) {
  const view = document.getElementById(`note-view-${nodeId}`);
  if (!view) return;
  const current = nodeNotes[nodeId]?.text || '';
  view.outerHTML = `<textarea id="note-edit-${nodeId}"
    onblur="saveNote('${nodeId}')"
    placeholder="Your reaction · analogies · counterexamples · links to your projects"
    style="width:100%;min-height:60px;background:transparent;border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:4px;font-size:12.5px;font-family:inherit;line-height:1.55;box-sizing:border-box;resize:vertical;margin:0;">${escapeHtml(current)}</textarea>`;
  document.getElementById(`note-edit-${nodeId}`).focus();
};

window.saveNote = async function(nodeId) {
  const ta = document.getElementById(`note-edit-${nodeId}`);
  if (!ta) return;
  const newText = ta.value.trim();
  const prev = nodeNotes[nodeId]?.text || '';
  const status = document.getElementById(`noteStatus-${nodeId}`);
  if (newText !== prev) {
    if (!newText) delete nodeNotes[nodeId];
    else nodeNotes[nodeId] = { text: newText, updated: new Date().toISOString() };
    if (status) status.textContent = newText ? 'Saving…' : '';
    await persistNote(nodeId, newText);
    if (status) {
      status.textContent = newText ? '✓ Saved' : '';
      status.style.color = '#227a52';
      setTimeout(() => { if (status) status.textContent = ''; }, 1500);
    }
  }
  // Restore view
  ta.outerHTML = `<div id="note-view-${nodeId}" onclick="editNote('${nodeId}')" title="Click to edit" style="cursor:text;padding:2px 0;border-radius:3px;font-size:12.5px;line-height:1.55;color:var(--text-dim);white-space:pre-wrap;${!newText ? 'font-style:italic;color:var(--text-faint);' : ''}">${newText ? escapeHtml(newText) : 'Click to add your thoughts…'}</div>`;
};

// Compat for any old call sites
window.autoSaveNote = window.saveMyThought = async function(nodeId) { return window.saveNote(nodeId); };

window.editDetail = function(nodeId) {
  const view = document.getElementById(`detail-view-${nodeId}`);
  if (!view) return;
  const node = allData.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const current = node.detail || '';
  // Replace view with textarea
  view.outerHTML = `<textarea id="detail-edit-${nodeId}"
    onblur="saveDetail('${nodeId}')"
    placeholder="Description: what it is / source / a definition"
    style="width:100%;min-height:60px;background:transparent;border:1px solid var(--border);color:var(--text-dim);padding:6px 8px;border-radius:4px;font-size:13px;font-family:inherit;line-height:1.55;box-sizing:border-box;resize:vertical;margin:0;">${escapeHtml(current)}</textarea>`;
  document.getElementById(`detail-edit-${nodeId}`).focus();
};

window.saveDetail = async function(nodeId) {
  const ta = document.getElementById(`detail-edit-${nodeId}`);
  if (!ta) return;
  const newText = ta.value.trim();
  const node = allData.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const oldText = node.detail || '';
  if (newText === oldText) {
    ta.outerHTML = `<div id="detail-view-${nodeId}" onclick="editDetail('${nodeId}')" title="Click to edit" style="cursor:text;padding:2px 0;border-radius:3px;font-size:13px;line-height:1.55;color:var(--text-dim);white-space:pre-wrap;${!oldText ? 'font-style:italic;color:var(--text-faint);' : ''}">${oldText ? escapeHtml(oldText) : 'Click to add a description…'}</div>`;
    return;
  }
  node.detail = newText || null;
  try {
    await apiPost(`${API_BASE}/state/node/${encodeURIComponent(nodeId)}/detail`, {text: newText});
  } catch (e) {
    showSyncError('Description not saved: ' + e.message);
    node.detail = oldText;  // revert
  }
  const display = node.detail || '';
  ta.outerHTML = `<div id="detail-view-${nodeId}" onclick="editDetail('${nodeId}')" title="Click to edit" style="cursor:text;padding:2px 0;border-radius:3px;font-size:13px;line-height:1.55;color:var(--text-dim);white-space:pre-wrap;${!display ? 'font-style:italic;color:var(--text-faint);' : ''}">${display ? escapeHtml(display) : 'Click to add a description…'}</div>`;
};

function formatNoteTime(iso) {
  try {
    const t = new Date(iso);
    const now = new Date();
    const diffMin = (now - t) / 60000;
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${Math.floor(diffMin)} min ago`;
    if (diffMin < 60*24) return `${Math.floor(diffMin/60)} h ago`;
    return `${t.getMonth()+1}/${t.getDate()}`;
  } catch { return ''; }
}

// -------------------- Paste-to-extract --------------------
let extractResult = null;
let extractChecks = {};  // key -> bool (whether selected)

window.openExtractor = function() {
  const m = document.getElementById('extract-modal');
  if (!m) return;
  document.getElementById('ex-text').value = '';
  document.getElementById('ex-preview').innerHTML = '';
  document.getElementById('ex-apply-btn').style.display = 'none';
  document.getElementById('ex-extract-btn').disabled = false;
  document.getElementById('ex-extract-btn').textContent = '🪄 Extract';
  extractResult = null;
  extractChecks = {};
  m.style.display = 'flex';
  setTimeout(() => document.getElementById('ex-text')?.focus(), 50);
};

window.closeExtractor = function() {
  const m = document.getElementById('extract-modal');
  if (m) m.style.display = 'none';
};

window.runExtract = async function() {
  const text = document.getElementById('ex-text').value.trim();
  if (!text) {
    showSyncError('Paste some text first');
    return;
  }
  const btn = document.getElementById('ex-extract-btn');
  const preview = document.getElementById('ex-preview');
  btn.disabled = true;
  btn.textContent = '🪄 Extracting… (10-20 s)';
  preview.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:10px;">AI is parsing…</div>';
  try {
    const res = await apiPost(`${API_BASE}/extract`, {text});
    extractResult = res;
    renderExtractPreview(res);
    document.getElementById('ex-apply-btn').style.display = '';
    btn.textContent = '🪄 Extract again';
    btn.disabled = false;
  } catch (e) {
    preview.innerHTML = `<div style="color:#c95e5e;font-size:12px;padding:10px;">Extraction failed: ${escapeHtml(e.message)}</div>`;
    btn.textContent = '🪄 Extract';
    btn.disabled = false;
  }
};

function renderExtractPreview(res) {
  const preview = document.getElementById('ex-preview');
  const concepts = res.concepts || [];
  const questions = res.questions || [];
  const comments = res.comments || [];
  extractChecks = {};
  let html = '';

  function section(title, color, items, type, renderItem) {
    if (items.length === 0) return '';
    let s = `<div style="margin-top:12px;">
      <div style="font-size:11px;color:${color};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600;">
        ${title} (${items.length})
      </div>`;
    items.forEach((item, i) => {
      const key = `${type}:${i}`;
      extractChecks[key] = true;
      s += `<div style="background:var(--surface-2);border-left:3px solid ${color};border-radius:4px;padding:8px 10px;margin-bottom:6px;display:flex;gap:8px;">
        <input type="checkbox" checked id="ex-chk-${key}" onchange="extractChecks['${key}']=this.checked;"
               style="margin-top:3px;flex-shrink:0;cursor:pointer;">
        <div style="flex:1;min-width:0;">${renderItem(item, i)}</div>
      </div>`;
    });
    s += `</div>`;
    return s;
  }

  html += section('Concepts', '#52b788', concepts, 'c', (c) => {
    const doms = (c.domains || []).map(d => `<span style="background:var(--surface-3);color:var(--text-dim);padding:1px 6px;border-radius:8px;font-size:9.5px;margin-right:3px;">${escapeHtml(d)}</span>`).join('');
    return `<div style="font-size:13px;color:var(--text);font-weight:500;">${escapeHtml(c.label || '')}</div>
            ${c.detail ? `<div style="font-size:11.5px;color:var(--text-dim);margin-top:3px;line-height:1.5;">${escapeHtml(c.detail)}</div>` : ''}
            ${doms ? `<div style="margin-top:4px;">${doms}</div>` : ''}`;
  });

  html += section('Questions', '#f4a261', questions, 'q', (q) => {
    return `<div style="font-size:13px;color:var(--text);">${escapeHtml(q.label || '')}</div>
            ${q.detail ? `<div style="font-size:11.5px;color:var(--text-dim);margin-top:3px;line-height:1.5;">${escapeHtml(q.detail)}</div>` : ''}`;
  });

  html += section('Comments → existing nodes', '#9580ff', comments, 'm', (m, i) => {
    const target = allData.nodes.find(n => n.id === m.attach_to);
    const targetLabel = target ? getDisplayLabel(target) : `<span style="color:#c95e5e;">(not found: ${escapeHtml(m.attach_to)})</span>`;
    return `<div style="font-size:11.5px;color:var(--text-dim);margin-bottom:3px;">→ <strong style="color:#9580ff;">${targetLabel}</strong></div>
            <div style="font-size:12.5px;color:var(--text);line-height:1.5;">${escapeHtml(m.text || '')}</div>`;
  });

  if (concepts.length + questions.length + comments.length === 0) {
    html = `<div style="color:var(--text-dim);font-size:12px;padding:14px;text-align:center;">AI found no clear concept / question / comment in the text. Try pasting something else.</div>`;
  } else {
    html = `<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">Tick the ones to keep — all selected by default</div>` + html;
  }
  preview.innerHTML = html;
}

window.applyExtract = async function() {
  if (!extractResult) return;
  const concepts = (extractResult.concepts || []).filter((_, i) => extractChecks[`c:${i}`]);
  const questions = (extractResult.questions || []).filter((_, i) => extractChecks[`q:${i}`]);
  const comments = (extractResult.comments || []).filter((_, i) => extractChecks[`m:${i}`]);
  const btn = document.getElementById('ex-apply-btn');
  btn.disabled = true; btn.textContent = 'Applying…';

  let createdC = 0, createdQ = 0, addedM = 0, errors = [];

  for (const c of concepts) {
    try {
      const res = await apiPost(`${API_BASE}/nodes/create`, {
        type: 'concept', label: c.label, detail: c.detail || null,
        weight: 3, domains: c.domains || [],
      });
      allData.nodes.push(res.node);
      createdC++;
    } catch (e) { errors.push(`concept "${c.label}": ${e.message}`); }
  }
  for (const q of questions) {
    try {
      const res = await apiPost(`${API_BASE}/nodes/create`, {
        type: 'question', label: q.label, detail: q.detail || null, weight: 3,
      });
      allData.nodes.push(res.node);
      createdQ++;
    } catch (e) { errors.push(`question "${q.label}": ${e.message}`); }
  }
  for (const m of comments) {
    if (!m.attach_to) continue;
    try {
      // Append to existing node note (preserve any prior text)
      const existing = nodeNotes[m.attach_to];
      const prior = existing?.text || '';
      const stamp = new Date().toISOString().slice(0, 10);
      const newText = prior
        ? `${prior}\n\n--- 📋 Extracted ${stamp} ---\n${m.text}`
        : `📋 Extracted ${stamp}:\n${m.text}`;
      await apiPost(`${API_BASE}/state/node/${encodeURIComponent(m.attach_to)}/note`, {text: newText});
      nodeNotes[m.attach_to] = {text: newText, updated: new Date().toISOString()};
      addedM++;
    } catch (e) { errors.push(`comment → ${m.attach_to}: ${e.message}`); }
  }

  refresh();
  closeExtractor();
  let msg = `✓ Created ${createdC} concepts + ${createdQ} questions · added ${addedM} comments`;
  if (errors.length) msg += `\n${errors.length} errors: ${errors[0]}${errors.length>1?'…':''}`;
  showSyncError(msg);
};

// -------------------- User-created nodes (concepts / questions / sources) --------------------
let ccSelectedDomains = new Set();
let ccCurrentType = 'concept';  // 'concept' | 'question' | 'book' | 'paper'

const TYPE_PLACEHOLDERS = {
  concept:  { label: 'Bidirectional priming',  detail: 'What it is / why you care / which project it relates to' },
  question: { label: 'Why…?',                  detail: 'Background / how you want AI to help you think' },
  comment:  { label: 'A reaction to X',        detail: 'Your reaction / comment / no conclusion needed' },
  book:     { label: 'Deep Work / Atomic Habits',detail: 'Core argument / what interests you' },
  paper:    { label: 'Attention Is All You Need',detail: 'Core contribution / what you want to use it for' },
};

window.setConceptType = function(t) {
  ccCurrentType = t;
  // Update button styles
  document.querySelectorAll('.cc-type-btn').forEach(btn => {
    const active = btn.dataset.type === t;
    btn.style.background = active ? '#4a8fe2' : 'transparent';
    btn.style.color = active ? '#fff' : 'var(--text-dim)';
    btn.style.borderColor = active ? '#4a8fe2' : 'var(--border)';
  });
  // Show/hide fields
  const sourceFields = document.getElementById('cc-source-fields');
  const paperFields = document.getElementById('cc-paper-fields');
  const domainsSection = document.getElementById('cc-domains-section');
  const weightSection = document.getElementById('cc-weight-section');
  sourceFields.style.display = (t === 'book' || t === 'paper') ? '' : 'none';
  paperFields.style.display = (t === 'paper') ? '' : 'none';
  domainsSection.style.display = (t === 'question' || t === 'comment') ? 'none' : '';
  weightSection.style.display = (t === 'question' || t === 'comment' || t === 'book' || t === 'paper') ? 'none' : '';
  // Update placeholders
  const ph = TYPE_PLACEHOLDERS[t];
  document.getElementById('cc-label').placeholder = 'e.g. ' + ph.label;
  document.getElementById('cc-detail').placeholder = ph.detail;
};

window.openConceptCreator = function() {
  const modal = document.getElementById('concept-creator');
  if (!modal) return;
  // Reset fields
  document.getElementById('cc-label').value = '';
  document.getElementById('cc-detail').value = '';
  document.getElementById('cc-weight').value = '3';
  const authorEl = document.getElementById('cc-author');
  const yearEl = document.getElementById('cc-year');
  const venueEl = document.getElementById('cc-venue');
  const doiEl = document.getElementById('cc-doi');
  if (authorEl) authorEl.value = '';
  if (yearEl) yearEl.value = '';
  if (venueEl) venueEl.value = '';
  if (doiEl) doiEl.value = '';
  ccSelectedDomains = new Set();
  setConceptType('concept');
  // Populate domain chips
  const domsEl = document.getElementById('cc-domains');
  const domains = (allData.meta && allData.meta.domains) || [];
  domsEl.innerHTML = domains.map(d => `
    <span class="cc-dom-chip" data-id="${d.id}"
          onclick="toggleCcDomain('${d.id}', this)"
          style="font-size:11px;padding:3px 9px;border-radius:11px;border:1px solid ${d.color || '#444'};color:${d.color || 'var(--muted)'};cursor:pointer;">
      ${d.label}
    </span>`).join('');
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('cc-label')?.focus(), 50);
};

window.closeConceptCreator = function() {
  const modal = document.getElementById('concept-creator');
  if (modal) modal.style.display = 'none';
};

window.toggleCcDomain = function(id, el) {
  if (ccSelectedDomains.has(id)) {
    ccSelectedDomains.delete(id);
    el.style.background = '';
    el.style.color = el.style.borderColor;
  } else {
    ccSelectedDomains.add(id);
    el.style.background = el.style.borderColor;
    el.style.color = '#fff';
  }
};

window.submitConcept = async function() {
  const label = document.getElementById('cc-label').value.trim();
  if (!label) {
    showSyncError('Label cannot be empty');
    document.getElementById('cc-label').focus();
    return;
  }

  // Map UI type to API payload
  const isSource = (ccCurrentType === 'book' || ccCurrentType === 'paper');
  const apiType = isSource ? 'source' : ccCurrentType;  // 'concept' / 'question' / 'comment' / 'source'
  const apiSubtype = isSource ? ccCurrentType : null;

  // Check for existing similar entries (within same type)
  const labelLower = label.toLowerCase();
  function hasOverlap(a, b) {
    if (a === b) return 'exact';
    if (a.includes(b) || b.includes(a)) return 'contains';
    // 2+ Chinese chars or 3+ ASCII chars consecutive substring match
    const minA = Math.min(a.length, b.length);
    for (let len = Math.min(minA, 8); len >= 2; len--) {
      for (let i = 0; i + len <= a.length; i++) {
        const sub = a.substring(i, i + len);
        const cnChars = (sub.match(/[\u4e00-\u9fa5]/g) || []).length;
        if (cnChars >= 2 && b.includes(sub)) return 'chunk-cn';
        if (cnChars === 0 && sub.length >= 3 && /[a-z0-9]/i.test(sub) && b.includes(sub)) return 'chunk-en';
      }
    }
    return null;
  }
  const similar = allData.nodes.map(n => {
    if (n.type !== apiType) return null;
    if (apiSubtype && n.subtype !== apiSubtype) return null;
    const nl = getDisplayLabel(n).toLowerCase();
    const match = hasOverlap(labelLower, nl);
    return match ? {node: n, match} : null;
  }).filter(Boolean);
  allData.nodes.forEach(n => {
    if (n.type !== apiType) return;
    if (apiSubtype && n.subtype !== apiSubtype) return;
    if (similar.find(s => s.node.id === n.id)) return;
    if (n.detail && n.detail.toLowerCase().includes(labelLower)) {
      similar.push({node: n, match: 'in-detail'});
    }
  });
  if (similar.length > 0) {
    const labels = {exact: 'same name', contains: 'contains', 'chunk-cn': 'shares characters', 'chunk-en': 'shares letters', 'in-detail': 'appears in description'};
    const list = similar.slice(0, 8).map((s, i) =>
      `${i+1}. [${labels[s.match] || s.match}] ${getDisplayLabel(s.node)}` +
      (s.node.detail ? ` — ${s.node.detail.slice(0, 50)}` : '')
    ).join('\n');
    const ok = confirm(
      `⚠️ ${similar.length} similar / related nodes already exist:\n\n${list}\n\n` +
      `Click "OK" to create a new one anyway (you can merge later)\nClick "Cancel" to stop and check these first`
    );
    if (!ok) return;
  }

  const detail = document.getElementById('cc-detail').value.trim() || null;
  const weight = parseInt(document.getElementById('cc-weight').value, 10) || 1;
  const domains = (ccCurrentType === 'question' || ccCurrentType === 'comment') ? [] : [...ccSelectedDomains];
  const body = { type: apiType, label, detail, weight, domains };
  if (apiSubtype) body.subtype = apiSubtype;
  if (isSource) {
    body.author = document.getElementById('cc-author').value.trim() || null;
    const yr = document.getElementById('cc-year').value.trim();
    body.year = yr ? parseInt(yr, 10) : null;
    if (apiSubtype === 'paper') {
      body.venue = document.getElementById('cc-venue').value.trim() || null;
      body.doi = document.getElementById('cc-doi').value.trim() || null;
    }
  }
  try {
    const res = await apiPost(`${API_BASE}/nodes/create`, body);
    allData.nodes.push(res.node);
    closeConceptCreator();
    refresh();
    lastFocusedNode = res.node;
    sidebarMode = 'detail';
    renderSidebar();
    // Auto-discover for concepts (not questions or sources)
    if (apiType === 'concept') {
      setTimeout(() => discoverRelated(res.node.id), 200);
    }
  } catch (e) {
    showSyncError('Create failed: ' + e.message);
  }
};

// -------------------- Discover related (DB text scan) --------------------
window.discoverRelated = async function(nodeId) {
  const panel = document.getElementById(`discover-panel-${nodeId}`);
  if (!panel) return;
  panel.style.display = '';
  panel.innerHTML = `<div style="padding:10px;color:var(--text-dim);font-size:11px;">🔍 Scanning everything…</div>`;
  try {
    const res = await apiGet(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}/discover`);
    const candidates = res.candidates || [];
    if (candidates.length === 0) {
      panel.innerHTML = `<div style="padding:10px;color:var(--text-dim);font-size:11px;background:var(--surface-2);border-radius:5px;">Scan done; nothing literally related found (no match in labels / descriptions / highlights). Try ➕ Add link to connect manually.</div>`;
      return;
    }
    let html = `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:10px;">
      <div style="font-size:11px;color:#4a8fe2;margin-bottom:8px;display:flex;justify-content:space-between;">
        <span>🔍 Found ${candidates.length} possibly related — each ✓ creates a relates_to link</span>
        <button onclick="document.getElementById('discover-panel-${nodeId}').style.display='none'"
                style="background:transparent;border:none;color:var(--text-dim);cursor:pointer;font-size:11px;">✕</button>
      </div>`;
    candidates.forEach((c) => {
      const dotColor = NODE_COLOR[c.subtype] || NODE_COLOR[c.type] || '#8a93a3';
      const matched = (c.matched_terms || []).map(t => `<span style="background:rgba(74,143,226,0.2);color:var(--accent);padding:1px 5px;border-radius:6px;font-size:9px;margin-right:3px;">${escapeHtml(t)}</span>`).join('');
      html += `<div id="discover-row-${nodeId}-${c.id.replace(/[^a-z0-9]/gi,'_')}" style="display:flex;gap:8px;align-items:flex-start;padding:8px;background:var(--surface);border-radius:4px;margin-bottom:5px;">
        <span style="width:8px;height:8px;border-radius:50%;background:${dotColor};margin-top:5px;flex-shrink:0;"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;color:var(--text);">${escapeHtml(c.label)} <span style="color:var(--text-faint);font-size:9px;">(${c.match_count}×)</span></div>
          <div style="font-size:9.5px;color:var(--text-dim);margin-top:2px;">${c.type}${c.subtype ? ' · ' + c.subtype : ''}</div>
          ${matched ? `<div style="margin-top:4px;">${matched}</div>` : ''}
          ${c.snippet ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.4;font-style:italic;">${escapeHtml(c.snippet)}</div>` : ''}
        </div>
        <button onclick="connectDiscovered('${nodeId}','${c.id}','relates_to')"
                style="background:#52b788;border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;align-self:center;">✓ Link</button>
        <button onclick="dismissDiscovered('${nodeId}','${c.id}')"
                title="Skip this one"
                style="background:transparent;border:1px solid var(--border);color:var(--text-dim);padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;align-self:center;">✗</button>
      </div>`;
    });
    html += `</div>`;
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div style="padding:10px;color:#c95e5e;font-size:11px;">Scan failed: ${escapeHtml(e.message)}</div>`;
  }
};

window.connectDiscovered = async function(fromId, toId, edgeType) {
  try {
    const res = await apiPost(`${API_BASE}/edges/create`, {
      source: fromId, target: toId, type: edgeType, label: null,
    });
    if (!res.duplicate) {
      allData.links.push(res.edge);
    }
    // Just remove the row from discover panel (no full re-render = no scroll jump)
    const rowId = `discover-row-${fromId}-${toId.replace(/[^a-z0-9]/gi,'_')}`;
    const row = document.getElementById(rowId);
    if (row) {
      // Visual flash before removing
      row.style.transition = 'background 0.3s, opacity 0.3s';
      row.style.background = 'rgba(82,183,136,0.25)';
      setTimeout(() => { row.style.opacity = '0'; }, 150);
      setTimeout(() => { row.remove(); }, 450);
    }
    refresh();  // updates graph
    // NOTE: intentionally NOT calling renderSidebar() — would lose scroll position.
    // Related count in header will be off until next view, OK trade-off for snappy UX.
  } catch (e) {
    showSyncError('Link failed: ' + e.message);
  }
};

window.dismissDiscovered = function(fromId, toId) {
  const rowId = `discover-row-${fromId}-${toId.replace(/[^a-z0-9]/gi,'_')}`;
  const row = document.getElementById(rowId);
  if (row) row.remove();
};

// -------------------- Merge nodes --------------------
// Confirm before merging via the inline list UX
window.confirmMerge = function(sourceId, targetId, sourceLabel, targetLabel) {
  const msg = `Merge "${sourceLabel}" into "${targetLabel}"?\n\n` +
              `⚠️ The current node will be deleted; all links / notes / highlights / confirmations / chats move to the target.\n` +
              `(This cannot be undone)`;
  if (confirm(msg)) {
    doMerge(sourceId, targetId, sourceLabel, targetLabel);
  }
};
// Legacy entry: old prompt-based API kept as an alias in case something still calls it
window.openMergeUI = function(sourceId) {
  const source = allData.nodes.find(n => n.id === sourceId);
  if (source) showSyncError(`Open the details of "${getDisplayLabel(source)}" to see the candidate list`);
};

async function doMerge(sourceId, targetId, sourceLabel, targetLabel) {
  try {
    const res = await apiPost(`${API_BASE}/nodes/${encodeURIComponent(sourceId)}/merge-into`,
                              {target_id: targetId});
    // Remove source from local data
    allData.nodes = allData.nodes.filter(n => n.id !== sourceId);
    // Re-point edges + drop self-loops/dups
    const seen = new Set();
    const newLinks = [];
    allData.links.forEach(l => {
      let s = idOf(l.source); let t = idOf(l.target);
      if (s === sourceId) s = targetId;
      if (t === sourceId) t = targetId;
      if (s === t) return;
      const key = `${s}|${t}|${l.type}`;
      if (seen.has(key)) return;
      seen.add(key);
      l.source = s; l.target = t;
      newLinks.push(l);
    });
    allData.links = newLinks;
    // Navigate to target
    lastFocusedNode = allData.nodes.find(n => n.id === targetId);
    sidebarMode = 'detail';
    refresh();
    renderSidebar();
    showSyncError(`✓ Merged: "${sourceLabel}" → "${targetLabel}" (${res.result.moved} links moved)`);
  } catch (e) {
    showSyncError('Merge failed: ' + e.message);
  }
}

// -------------------- User-created edges --------------------
let edgeCreatorTarget = {}; // nodeId -> selected target node id

async function persistDomains(nodeId, domains) {
  try {
    await apiPost(`${API_BASE}/state/node/${encodeURIComponent(nodeId)}/domains`, {domains});
  } catch (e) {
    showSyncError('Topics not saved: ' + e.message);
  }
}

window.addNodeDomain = async function(nodeId, domainId) {
  if (!domainId) return;
  const n = allData.nodes.find(x => x.id === nodeId);
  if (!n) return;
  if (!n.domains) n.domains = [];
  if (!n.domains.includes(domainId)) n.domains.push(domainId);
  await persistDomains(nodeId, n.domains);
  renderSidebar();
  refresh();
};

window.removeNodeDomain = async function(nodeId, domainId) {
  const n = allData.nodes.find(x => x.id === nodeId);
  if (!n || !n.domains) return;
  n.domains = n.domains.filter(d => d !== domainId);
  await persistDomains(nodeId, n.domains);
  renderSidebar();
  refresh();
};

window.openTypeEditor = function(nodeId) {
  const tag = document.getElementById(`type-tag-${nodeId}`);
  if (!tag) return;
  const n = allData.nodes.find(x => x.id === nodeId);
  if (!n) return;
  const cur = `${n.type}${n.subtype ? ':' + n.subtype : ''}`;
  tag.outerHTML = `<select id="type-tag-${nodeId}"
      onchange="commitTypeChange('${nodeId}', this.value)"
      onblur="restoreTypeTag('${nodeId}')"
      style="background:var(--surface-2);color:var(--text);border:1px solid var(--border);padding:2px 6px;border-radius:6px;font-size:11px;cursor:pointer;">
    <option value="concept" ${cur==='concept'?'selected':''}>concept</option>
    <option value="question" ${cur==='question'?'selected':''}>question</option>
    <option value="source:book" ${cur==='source:book'?'selected':''}>source · book</option>
    <option value="source:paper" ${cur==='source:paper'?'selected':''}>source · paper</option>
  </select>`;
  document.getElementById(`type-tag-${nodeId}`).focus();
};

window.commitTypeChange = async function(nodeId, value) {
  const n = allData.nodes.find(x => x.id === nodeId);
  if (!n) return;
  const [newType, newSubtype] = value.split(':');
  const body = {type: newType};
  if (newSubtype) body.subtype = newSubtype;
  try {
    await apiPost(`${API_BASE}/state/node/${encodeURIComponent(nodeId)}/type`, body);
    n.type = newType;
    n.subtype = newSubtype || null;
  } catch (e) {
    showSyncError('Type change failed: ' + e.message);
  }
  refresh();
  renderSidebar();
};

window.restoreTypeTag = function(nodeId) {
  // If user blurred without picking, just re-render sidebar to restore tag
  const sel = document.getElementById(`type-tag-${nodeId}`);
  if (sel && sel.tagName === 'SELECT') {
    renderSidebar();
  }
};
// back-compat
window.changeNodeType = window.openTypeEditor;

window.toggleNodeSubtype = async function(nodeId) {
  const n = allData.nodes.find(x => x.id === nodeId);
  if (!n || n.type !== 'source') return;
  const newSubtype = n.subtype === 'book' ? 'paper' : 'book';
  n.subtype = newSubtype; // optimistic
  refresh();
  renderSidebar();
  try {
    await apiPost(`${API_BASE}/state/node/${encodeURIComponent(nodeId)}/subtype`, {subtype: newSubtype});
  } catch (e) {
    showSyncError('Type change failed: ' + e.message);
    n.subtype = newSubtype === 'book' ? 'paper' : 'book'; // revert
    refresh();
    renderSidebar();
  }
};

window.openEdgeCreator = function(fromId) {
  const box = document.getElementById(`edge-creator-${fromId}`);
  if (!box) return;
  box.style.display = '';
  edgeCreatorTarget[fromId] = null;
  filterEdgeTargets(fromId);
  setTimeout(() => document.getElementById(`ec-search-${fromId}`)?.focus(), 50);
};

window.closeEdgeCreator = function(fromId) {
  const box = document.getElementById(`edge-creator-${fromId}`);
  if (box) box.style.display = 'none';
  delete edgeCreatorTarget[fromId];
};

window.filterEdgeTargets = function(fromId) {
  const search = (document.getElementById(`ec-search-${fromId}`)?.value || '').toLowerCase().trim();
  const targetsDiv = document.getElementById(`ec-targets-${fromId}`);
  if (!targetsDiv) return;
  const candidates = allData.nodes
    .filter(n => n.id !== fromId)
    .filter(n => !search || (getDisplayLabel(n) + ' ' + (n.detail || '')).toLowerCase().includes(search))
    .slice(0, 20);
  targetsDiv.innerHTML = candidates.map(n => {
    const sel = edgeCreatorTarget[fromId] === n.id ? 'background:var(--user);' : '';
    const col = nodeColor(n);
    return `<div onclick="selectEdgeTarget('${fromId}','${n.id}')"
                 style="${sel}padding:5px 8px;cursor:pointer;font-size:11.5px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--line);">
      <span style="width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0;"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);">${escapeHtml(getDisplayLabel(n))}</span>
      <span style="color:var(--muted);font-size:9px;">${n.type}</span>
    </div>`;
  }).join('') || `<div style="padding:8px;color:var(--muted);font-size:11px;text-align:center;">No match</div>`;
};

window.selectEdgeTarget = function(fromId, targetId) {
  edgeCreatorTarget[fromId] = targetId;
  filterEdgeTargets(fromId);
};

window.createEdgeFromUI = async function(fromId) {
  const target = edgeCreatorTarget[fromId];
  if (!target) {
    showSyncError('Pick a target node first');
    return;
  }
  const type = document.getElementById(`ec-type-${fromId}`).value;
  const label = document.getElementById(`ec-label-${fromId}`).value.trim();
  try {
    const res = await apiPost(`${API_BASE}/edges/create`, {
      source: fromId, target, type, label,
    });
    if (res.duplicate) {
      showSyncError('This link already exists');
      return;
    }
    // Splice into local graph data
    allData.links.push(res.edge);
    closeEdgeCreator(fromId);
    refresh();
    // Re-render sidebar for fromId
    const n = allData.nodes.find(x => x.id === fromId);
    if (n) { lastFocusedNode = n; sidebarMode = 'detail'; renderSidebar(); }
  } catch (e) {
    showSyncError('Create failed: ' + e.message);
  }
};

window.exportConfirmations = function() {
  const blob = new Blob([JSON.stringify({confirmations, answers}, null, 2)],
    {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `brain-confirmations-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
};

// -------------------- Utils --------------------
function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// -------------------- Review mode (nodes & edges, symmetric) --------------------
// reviewMode: false | 'node' | 'edge'
window.enterNodeReview = function() { return enterReviewOfType('node'); };
window.enterEdgeReview = function() { return enterReviewOfType('edge'); };
window.enterReview = window.enterEdgeReview; // back-compat

function enterReviewOfType(type) {
  reviewQueue = [];
  if (type === 'edge') {
    allData.links.forEach((l, i) => {
      if (edgeStatusOf(l) === 'pending') reviewQueue.push(i);
    });
  } else {
    allData.nodes.forEach((n, i) => {
      if (statusOf(n) === 'pending') reviewQueue.push(i);
    });
  }
  if (reviewQueue.length === 0) {
    alert(type === 'edge' ? '🎉 All links reviewed!' : '🎉 All nodes reviewed!');
    return;
  }
  reviewMode = type;
  reviewIndex = 0;
  renderReviewSidebar();
  focusOnCurrentReviewItem();
  refresh();
}

window.exitReview = function() {
  reviewMode = false;
  reviewQueue = [];
  reviewIndex = 0;
  renderSidebar();
  refresh();
};

window.reviewDecide = async function(status) {
  if (!reviewMode) return;
  if (reviewMode === 'edge') {
    const link = allData.links[reviewQueue[reviewIndex]];
    if (link && link.id !== undefined) {
      edgeConfirmations[String(link.id)] = status;
      persistEdgeConfirmation(link.id, status);  // fire and forget for snappy UI
    }
  } else {
    const node = allData.nodes[reviewQueue[reviewIndex]];
    if (node) {
      confirmations[node.id] = status;
      persistNodeConfirmation(node.id, status);
    }
  }
  reviewIndex++;
  if (reviewIndex >= reviewQueue.length) {
    finishReview();
  } else {
    renderReviewSidebar();
    focusOnCurrentReviewItem();
    refresh();
  }
};

window.reviewSkip = function() {
  if (!reviewMode) return;
  reviewIndex++;
  if (reviewIndex >= reviewQueue.length) {
    finishReview();
  } else {
    renderReviewSidebar();
    focusOnCurrentReviewItem();
  }
};

function finishReview() {
  const totalConfirmed = reviewMode === 'edge'
    ? Object.values(edgeConfirmations).filter(v => v === 'confirmed').length
    : Object.values(confirmations).filter(v => v === 'confirmed').length;
  const totalRejected = reviewMode === 'edge'
    ? Object.values(edgeConfirmations).filter(v => v === 'rejected').length
    : Object.values(confirmations).filter(v => v === 'rejected').length;
  const what = reviewMode === 'edge' ? 'Links' : 'Nodes';
  const sb = document.getElementById('sidebar-content');
  sb.innerHTML = `<h2>🎉 ${what} reviewed</h2>
    <p>Total: <strong style="color:#52b788;">${totalConfirmed}</strong> ✓, <strong style="color:#c95e5e;">${totalRejected}</strong> ✗.</p>
    <button class="confirm-btn yes" style="margin-top:16px;width:100%;" onclick="exitReview()">Back to normal view</button>`;
  reviewMode = false;
  refresh();
}

function renderReviewSidebar() {
  if (reviewMode === 'edge') return renderEdgeReviewSidebar();
  if (reviewMode === 'node') return renderNodeReviewSidebar();
}

function focusOnCurrentReviewItem() {
  if (reviewMode === 'edge') return focusOnCurrentEdge();
  if (reviewMode === 'node') return focusOnCurrentReviewNode();
}

function focusOnCurrentEdge() {
  if (!reviewMode || reviewIndex >= reviewQueue.length) return;
  const link = allData.links[reviewQueue[reviewIndex]];
  if (!link) return;
  const s = allData.nodes.find(n => n.id === idOf(link.source));
  const t = allData.nodes.find(n => n.id === idOf(link.target));
  if (!s || !t || s.x === undefined || t.x === undefined) return;
  const mx = (s.x + t.x) / 2;
  const my = (s.y + t.y) / 2;
  const mz = ((s.z || 0) + (t.z || 0)) / 2;
  const dx = t.x - s.x, dy = t.y - s.y, dz = (t.z || 0) - (s.z || 0);
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
  const camDist = Math.max(150, dist * 1.8);
  graph.cameraPosition(
    { x: mx, y: my + camDist * 0.4, z: mz + camDist },
    { x: mx, y: my, z: mz },
    900
  );
}

function focusOnCurrentReviewNode() {
  if (!reviewMode || reviewIndex >= reviewQueue.length) return;
  const node = allData.nodes[reviewQueue[reviewIndex]];
  if (!node || node.x === undefined) return;
  const dist = 110;
  const r = Math.hypot(node.x || 1, node.y || 1, node.z || 1);
  const ratio = 1 + dist / r;
  graph.cameraPosition(
    { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
    node, 900
  );
}

function nodeContextBlock(n) {
  let html = `<div style="background:var(--tool);padding:10px 12px;border-radius:5px;margin:6px 0;border-left:3px solid ${nodeColor(n)};">`;
  const sub = n.subtype ? ` · ${n.subtype}` : '';
  html += `<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">${n.type}${sub}</div>`;
  html += `<div style="font-size:14px;font-weight:600;margin:3px 0;color:var(--text);">${escapeHtml(n.label)}</div>`;
  if (n.detail) {
    html += `<div style="font-size:11.5px;color:var(--muted);line-height:1.5;margin-top:5px;">${escapeHtml(n.detail.slice(0, 280))}${n.detail.length > 280 ? '…' : ''}</div>`;
  }
  if (n.yue_comment) {
    html += `<div class="user-comment" style="margin-top:8px;font-size:11.5px;">${escapeHtml(n.yue_comment)}</div>`;
  }
  // Show 1 representative highlight for source nodes
  if (n.type === 'source' && n.highlights && n.highlights.length > 0) {
    const commented = n.highlights.find(h => h.yue_comment);
    const showHL = commented || n.highlights[0];
    html += `<div style="margin-top:8px;padding:6px 8px;background:var(--tool);border-radius:3px;font-size:11px;color:var(--muted);line-height:1.5;">`;
    if (showHL.page) html += `<span style="color:var(--muted);">p.${showHL.page}</span> `;
    html += escapeHtml(showHL.text.slice(0, 200)) + (showHL.text.length > 200 ? '…' : '');
    if (showHL.yue_comment) {
      html += `<br><span style="color:#f4a261;">💬 ${escapeHtml(showHL.yue_comment)}</span>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

function reviewHeader(themeColor, label) {
  const total = reviewQueue.length;
  const progress = ((reviewIndex / total) * 100).toFixed(0);
  return `<div style="margin:-8px -22px 12px -22px;padding:8px 22px;background:var(--user);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;">
    <span style="font-size:11px;color:${themeColor};">${label} · ${reviewIndex + 1} / ${total}</span>
    <button class="filter-btn" style="font-size:10px;padding:3px 8px;" onclick="exitReview()">⏹ Exit</button>
  </div>
  <div style="height:3px;background:var(--user);margin:-12px -22px 14px -22px;overflow:hidden;">
    <div style="height:100%;width:${progress}%;background:linear-gradient(90deg,${themeColor},#52b788);transition:width 0.3s;"></div>
  </div>`;
}

function reviewButtons(yesLabel, noLabel) {
  return `<div style="display:flex;gap:6px;margin-top:18px;">
    <button class="confirm-btn yes" style="flex:2;" onclick="reviewDecide('confirmed')">${yesLabel} <span style="opacity:0.6;font-size:10px;">Space</span></button>
    <button class="confirm-btn no" style="flex:2;" onclick="reviewDecide('rejected')">${noLabel} <span style="opacity:0.6;font-size:10px;">Esc</span></button>
    <button class="confirm-btn edit" style="flex:1;" onclick="reviewSkip()">⏭ Skip <span style="opacity:0.6;font-size:10px;">→</span></button>
  </div>
  <p style="color:var(--muted);font-size:10.5px;text-align:center;margin-top:14px;line-height:1.5;">Space = ✓ · Esc = ✗ · → skip<br>Skipped items come back; ✓/✗ are saved permanently</p>`;
}

function renderEdgeReviewSidebar() {
  const sb = document.getElementById('sidebar-content');
  if (!reviewMode || reviewIndex >= reviewQueue.length) return;
  const link = allData.links[reviewQueue[reviewIndex]];
  const s = allData.nodes.find(n => n.id === idOf(link.source));
  const t = allData.nodes.find(n => n.id === idOf(link.target));
  if (!s || !t) { reviewSkip(); return; }
  const relLabel = link.label || link.type;

  let html = reviewHeader('#9580ff', '🔍 Review links');
  html += `<h2 style="font-size:15px;margin-bottom:4px;">Is this link right?</h2>`;
  html += `<p style="color:var(--muted);font-size:11.5px;margin-bottom:14px;">AI says these two nodes are linked by <strong style="color:#9580ff;">${escapeHtml(relLabel)}</strong>.</p>`;
  html += nodeContextBlock(s);
  html += `<div style="text-align:center;color:#9580ff;font-size:13px;margin:6px 0;">↓ <strong>${escapeHtml(relLabel)}</strong> ↓</div>`;
  html += nodeContextBlock(t);
  html += reviewButtons('✓ Yes', '✗ Should not link');
  sb.innerHTML = html;
}

function renderNodeReviewSidebar() {
  const sb = document.getElementById('sidebar-content');
  if (!reviewMode || reviewIndex >= reviewQueue.length) return;
  const node = allData.nodes[reviewQueue[reviewIndex]];
  if (!node) { reviewSkip(); return; }

  let html = reviewHeader('#f4a261', '🔍 Review nodes');
  html += `<h2 style="font-size:15px;margin-bottom:4px;">Is this node real?</h2>`;
  html += `<p style="color:var(--muted);font-size:11.5px;margin-bottom:14px;">AI inferred this <strong style="color:#f4a261;">${node.type}</strong> from your highlights. Is it something you actually care about?</p>`;
  html += nodeContextBlock(node);

  // 📖 Sources — pull source highlights that gave rise to this node
  const contexts = findContextSources(node.id);
  if (contexts.length > 0) {
    html += `<h3 style="margin-top:14px;">📖 Sources</h3>`;
    contexts.slice(0, 2).forEach(({source}) => {
      const allH = source.highlights || [];
      const commented = allH.filter(h => h.yue_comment);
      const show = commented.slice(0, 2).length ? commented.slice(0, 2) : allH.slice(0, 1);
      if (show.length === 0) return;
      html += `<div style="margin-top:8px;"><div style="font-size:11px;color:#227a52;margin-bottom:4px;">📚 ${escapeHtml(source.label)}</div>`;
      show.forEach(h => {
        html += `<div class="quote">`;
        if (h.page) html += `<div class="meta">p.${h.page}</div>`;
        html += `${escapeHtml(h.text.slice(0, 220))}${h.text.length > 220 ? '…' : ''}</div>`;
        if (h.yue_comment) html += `<div class="user-comment">${escapeHtml(h.yue_comment)}</div>`;
      });
      html += `</div>`;
    });
  }

  html += reviewButtons('✓ Yes, add to my brain', '✗ No');
  sb.innerHTML = html;
}

// Keyboard shortcuts (only when in review mode AND focus isn't in an input)
document.addEventListener('keydown', e => {
  if (!reviewMode) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === ' ') { e.preventDefault(); reviewDecide('confirmed'); }
  else if (e.key === 'Escape') { e.preventDefault(); reviewDecide('rejected'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); reviewSkip(); }
});

// -------------------- Agent Q&A (same origin) --------------------
let agentOnline = null;

async function checkAgent() {
  try {
    const r = await fetch(`${API_BASE}/health`, {method: 'GET'});
    const data = await r.json();
    const el = document.getElementById('agentStatus');
    if (data.ok) {
      agentOnline = true;
      if (el) { el.className = 'agent-status online'; el.textContent = `● ${data.model || 'online'}`; }
    } else {
      agentOnline = false;
      if (el) { el.className = 'agent-status offline'; el.textContent = `● ${data.error || 'not ready'}`; }
    }
  } catch (e) {
    agentOnline = false;
    const el = document.getElementById('agentStatus');
    if (el) { el.className = 'agent-status offline'; el.textContent = '● check failed'; }
  }
}

async function loadAgentHistory(nodeId) {
  const histEl = document.getElementById(`agentHistory-${nodeId}`);
  if (!histEl) return;
  try {
    const r = await apiGet(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}/messages`);
    renderAgentHistory(nodeId, r.messages || []);
  } catch (e) {
    // silently ignore
  }
}

function renderAgentHistory(nodeId, messages) {
  const histEl = document.getElementById(`agentHistory-${nodeId}`);
  if (!histEl) return;
  if (!messages || messages.length === 0) {
    histEl.innerHTML = '';
    return;
  }
  histEl.innerHTML = messages.map(m => {
    const isUser = m.role === 'user';
    if (isUser) {
      return `<div style="background:var(--surface-3);color:var(--text);padding:6px 10px;border-radius:8px 8px 2px 8px;margin:6px 0 6px 30px;font-size:12.5px;line-height:1.5;">
        ${escapeHtml(m.content)}
      </div>`;
    }
    return `<div style="background:var(--agent-input-bg);color:var(--text);padding:8px 10px;border-radius:8px 8px 8px 2px;margin:6px 30px 6px 0;border-left:2px solid #9580ff;font-size:12.5px;line-height:1.6;white-space:pre-wrap;">
      ${escapeHtml(m.content)}
    </div>`;
  }).join('');
}

window.askAgent = async function(nodeId) {
  const input = document.getElementById(`agentInput-${nodeId}`);
  const histEl = document.getElementById(`agentHistory-${nodeId}`);
  const btn = input?.parentElement.querySelector('.agent-ask-btn');
  if (!input || !histEl) return;

  const question = input.value.trim() ||
    "What does this mean? Why is it in my brain? How might it relate to my research?";
  const displayedQ = input.value.trim() || "(default) What is this? How does it relate to my research?";

  // Optimistically append user message
  histEl.insertAdjacentHTML('beforeend',
    `<div style="background:var(--surface-3);color:var(--text);padding:6px 10px;border-radius:8px 8px 2px 8px;margin:6px 0 6px 30px;font-size:12.5px;line-height:1.5;">
       ${escapeHtml(displayedQ)}
     </div>`);
  // Streaming assistant bubble placeholder
  const aId = `streaming-${Date.now()}`;
  histEl.insertAdjacentHTML('beforeend',
    `<div id="${aId}" class="agent-cursor" style="background:var(--agent-input-bg);color:var(--text);padding:8px 10px;border-radius:8px 8px 8px 2px;margin:6px 30px 6px 0;border-left:2px solid #9580ff;font-size:12.5px;line-height:1.6;white-space:pre-wrap;"></div>`);
  input.value = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  // Auto-scroll
  histEl.scrollIntoView({block: 'end'});

  try {
    const r = await fetch(`${API_BASE}/explain`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({node_id: nodeId, question}),
    });
    if (!r.ok) {
      const txt = await apiErrorMessage(r);
      document.getElementById(aId).classList.remove('agent-cursor');
      document.getElementById(aId).textContent = `❌ ${txt}`;
      return;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      acc += decoder.decode(value, {stream: true});
      const el = document.getElementById(aId);
      if (el) el.textContent = acc;
    }
    document.getElementById(aId)?.classList.remove('agent-cursor');
  } catch (e) {
    const el = document.getElementById(aId);
    if (el) {
      el.classList.remove('agent-cursor');
      el.innerHTML = `❌ ${escapeHtml(String(e))}`;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Ask (⌘Enter)'; }
  }
};

window.clearAgentChat = async function(nodeId) {
  if (!confirm('Clear the chat history for this node?')) return;
  try {
    await apiPost(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}/messages/clear`, {});
    const histEl = document.getElementById(`agentHistory-${nodeId}`);
    if (histEl) histEl.innerHTML = '';
  } catch (e) {
    showSyncError('Clear failed: ' + e.message);
  }
};

// Cmd+Enter to submit
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    const target = e.target;
    if (target.classList.contains('agent-input')) {
      const nodeId = target.id.replace('agentInput-', '');
      askAgent(nodeId);
      e.preventDefault();
    }
  }
});

// Re-check agent status when sidebar re-renders
const _origRenderSidebar = renderSidebar;

// -------------------- Theme toggle --------------------
const THEME_KEY = 'brain-theme';
function applyTheme(theme) {
  // One look, the platform's light palette: the old dark / are.na themes are gone
  document.body.classList.remove('dark', 'light');
  if (graph && graph.backgroundColor) graph.backgroundColor('#f7f8fa');
}
window.toggleTheme = function() {
  const cur = document.body.classList.contains('dark') ? 'dark' : 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
};

const SIDEBAR_HIDDEN_KEY = 'brain-sidebar-hidden';
window.toggleSidebar = function() {
  const hidden = document.body.classList.toggle('sidebar-hidden');
  const btn = document.getElementById('sidebarToggle');
  if (btn) btn.textContent = hidden ? '⛶ Show' : '⛶';
  localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
};
(function restoreSidebarHidden() {
  if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1') {
    document.body.classList.add('sidebar-hidden');
  }
})();
(function restoreTheme() {
  // light = default (no class); add 'dark' only if explicitly saved
  const saved = localStorage.getItem(THEME_KEY);

  // Strip any stale 'light' class from older versions
  document.body.classList.remove('light');
})();

// -------------------- Sidebar resizer --------------------
const SIDEBAR_WIDTH_KEY = 'brain-sidebar-width';
function setSidebarWidth(px) {
  const clamped = Math.max(240, Math.min(900, Math.round(window.innerWidth * 0.45), px));
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  // explicitly resize the 3D canvas, otherwise three.js won't notice the parent div changed
  if (graph) {
    const w = Math.max(100, window.innerWidth - clamped);
    const h = window.innerHeight;
    if (graph.width)  graph.width(w);
    if (graph.height) graph.height(h);
    if (graph.refresh) graph.refresh();
  }
}

// also respond to window resizes (maximize/minimize, dragging)
window.addEventListener('resize', () => {
  const cur = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '400', 10);
  setSidebarWidth(cur);
});
// Restore saved width on load
(function restoreSidebarWidth() {
  const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '0', 10);
  if (saved > 0) setSidebarWidth(saved);
})();
(function wireResizer() {
  const r = document.getElementById('sidebar-resizer');
  if (!r) return;
  let dragging = false;
  r.addEventListener('mousedown', e => {
    dragging = true;
    r.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newWidth = window.innerWidth - e.clientX;
    setSidebarWidth(newWidth);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    r.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
  // Double-click resets to 400
  r.addEventListener('dblclick', () => setSidebarWidth(400));
})();

// Boot
init().catch(e => {
  document.getElementById('sidebar-content').innerHTML =
    `<div class="empty-state" style="color:#c95e5e;">Failed to load: ${escapeHtml(e.message)}<br><br>Check that the server and the <code style="background:var(--tool);padding:2px 6px;border-radius:3px;">/api/brain</code> endpoints are reachable, then reload.</div>`;
});


// -------------------- Zotero refresh (the same import the daily job runs) --------------------
(function initZoteroRefresh() {
  const btn = document.getElementById('zoteroRefresh');
  const tab = document.getElementById('openTab');
  if (tab && window.top !== window) tab.style.display = '';   // only useful when embedded in the platform
  if (!btn) return;
  const show = (s) => {
    const when = s && s.last && s.last.timestamp ? new Date(s.last.timestamp).toLocaleString() : 'never';
    btn.title = s && s.zotero_configured === false ? 'Zotero is not configured on the server'
      : `Import new Zotero highlights and notes · last import: ${when}`;
    btn.disabled = !!(s && (s.running || s.zotero_configured === false));
    btn.textContent = s && s.running ? '↻ Refreshing…' : '↻ Zotero';
  };
  const status = async () => (await fetch('/api/brain/import', { cache: 'no-store' })).json();
  status().then(show).catch(() => {});
  window.refreshZotero = async function () {
    try {
      const r = await fetch('/api/brain/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok) { alertBar(`Refresh failed: HTTP ${r.status}`); return; }
      show({ running: true });
      const t = setInterval(async () => {
        try {
          const s = await status();
          if (s.running) return;
          clearInterval(t);
          show(s);
          if (s.error) alertBar(`Refresh failed: ${s.error}`);
          else location.reload();
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e) { alertBar(`Refresh failed: ${e}`); }
  };
  function alertBar(msg) {
    const b = document.getElementById('update-banner');
    document.getElementById('update-banner-msg').textContent = msg;
    b.style.display = 'flex';
  }
})();
