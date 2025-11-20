import { ageInDays, haversineMiles } from './shared.js'

// Global Init
const map = L.map('map', { worldCopyJump: true }).setView([47.76837, -122.06078], 10);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let edgeLayer = L.layerGroup().addTo(map);
let sampleLayer = L.layerGroup().addTo(map);
let repeaterLayer = L.layerGroup().addTo(map);
let nodes = null; // Holds fetched results.
let repeaterRenderMode = 'hit';
let repeaterSearch = '';
let showEdges = true;

const mapControl = L.control({ position: 'topright' });
mapControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'mesh-control leaflet-control');

  div.innerHTML = `
    <div class="mesh-control-row">
      <label>
        Repeaters:
        <select id="repeater-filter-select">
          <option value="all">All</option>
          <option value="hit" selected="true">Hit</option>
          <option value="none">None</option>
        </select>
      </label>
    </div>
    <div class="mesh-control-row">
      <label>
        Show Edges:
        <input type="checkbox" checked="true" id="show-edges" />
      </label>
    </div>
    <div class="mesh-control-row">
      <label>
        Find Id:
        <input type="text" id="repeater-search" />
      </label>
    </div>
    <div class="mesh-control-row">
      <button type="button" id="refresh-map-button">Refresh map</button>
    </div>
  `;

  div.querySelector("#repeater-filter-select")
    .addEventListener("change", (e) => {
      repeaterRenderMode = e.target.value;
      renderNodes(nodes);
    });

  div.querySelector("#show-edges")
    .addEventListener("change", (e) => {
      showEdges = e.target.checked;
      renderNodes(nodes);
    });

  div.querySelector("#repeater-search")
    .addEventListener("input", (e) => {
      repeaterSearch = e.target.value.toLowerCase();
      renderNodes(nodes);
    });

  div.querySelector("#refresh-map-button")
    .addEventListener("click", () => refreshCoverage());


  // Don’t let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  return div;
};

mapControl.addTo(map);

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sampleMarker(s) {
  const color = s.path.length > 0 ? '#07ac07' : '#e96767';
  const style = { radius: 6, weight: 1, color: color, fillOpacity: .9 };
  const marker = L.circleMarker([s.lat, s.lon], style);
  const date = new Date(s.time);
  const details = `
    ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}<br/>
    ${date.toLocaleString()}
    ${s.path.length === 0 ? '' : '<br/>Hit: ' + s.path.join(',')}`;
  marker.bindPopup(details, { maxWidth: 320 });
  return marker;
}

function repeaterMarker(r) {
  const stale = ageInDays(r.time) > 2;
  const dead = ageInDays(r.time) > 8;
  const ageClass = (dead ? "dead" : (stale ? "stale" : ""));
  const icon = L.divIcon({
    className: '', // Don't use default Leaflet style.
    html: `<div class="repeater-dot ${ageClass}"><span>${r.id}</span></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  const marker = L.marker([r.lat, r.lon], { icon: icon });
  const details = [
    `<strong>${escapeHtml(r.name)} [${r.id}]</strong>`,
    `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} · <em>${(r.elev).toFixed(0)}m</em>`,
    `${new Date(r.time).toLocaleString()}`
  ].join('<br/>');
  marker.bindPopup(details, { maxWidth: 320 });
  return marker;
}

function getNearestRepeater(fromPos, repeaterList) {
  if (repeaterList.length === 1) {
    return repeaterList[0];
  }

  let minRepeater = null;
  let minDist = 30000; // Bigger than any valid dist.

  repeaterList.forEach(r => {
    const to = [r.lat, r.lon];
    const elev = r.elev ?? 0; // Allow height to impact distance.
    const dist = haversineMiles(fromPos, to) - (0.25 * Math.sqrt(elev));
    if (dist < minDist) {
      minDist = dist;
      minRepeater = r;
    }
  });

  return minRepeater;
}

function renderNodes(nodes) {
  sampleLayer.clearLayers();
  repeaterLayer.clearLayers();
  edgeLayer.clearLayers();
  const outEdges = [];
  const idToRepeaters = new Map();

  // Add samples.
  nodes.samples.forEach(s => {
    sampleLayer.addLayer(sampleMarker(s));
    s.path.forEach(p => {
      outEdges.push({ id: p, pos: [s.lat, s.lon] });
    });
  });

  // Are repeaters/edges needed?
  if (repeaterRenderMode === 'none') return;

  // TODO: Build indexes once.
  // Index repeaters.
  nodes.repeaters.forEach(r => {
    if (repeaterSearch !== '') {
      if (!r.id.toLowerCase().startsWith(repeaterSearch))
        return; // Skip nodes that don't match.
    }

    const repeaterList = idToRepeaters.get(r.id) ?? [];
    repeaterList.push(r);
    idToRepeaters.set(r.id, repeaterList);
  });

  // TODO: render paths only when hovered over a sample.

  // Draw edges, determine hit repeaters.
  const hitRepeaters = new Set();
  const showAll = repeaterRenderMode === 'all';
  outEdges.forEach(edge => {
    const candidates = idToRepeaters.get(edge.id);
    if (candidates === undefined) {
      //console.log(`Missing repeater ${edge.id}`);
      return;
    }

    const from = edge.pos;
    const nearest = getNearestRepeater(from, candidates);
    const to = [nearest.lat, nearest.lon];
    hitRepeaters.add(nearest);
    if (showEdges === true) {
      L.polyline([from, to], { weight: 2, opacity: 0.6, dashArray: '1,6' }).addTo(edgeLayer);
    }
  });

  // Add repeaters.
  const repeatersToAdd = showAll ? [...idToRepeaters.values()].flat() : hitRepeaters;
  repeatersToAdd.forEach(r => {
    repeaterLayer.addLayer(repeaterMarker(r));
  });
}

export async function refreshCoverage() {
  const endpoint = "/get-nodes";
  const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  nodes = await resp.json();
  renderNodes(nodes);
}
