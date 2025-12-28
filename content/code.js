import {
  ageInDays,
  centerPos,
  definedOr,
  geo,
  haversineMiles,
  maxDistanceMiles,
  posFromHash,
  pushMap,
  sigmoid,
  fromTruncatedTime,
} from './shared.js'

// Global Init
const map = L.map('map', {
  worldCopyJump: true,
  zoomControl: false,
}).setView(centerPos, 10);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 16,
  minZoom: 8,
  attribution: '© OpenStreetMap contributors | <a href="/howto" target="_blank">Contribute</a>'
}).addTo(map);

// Control state
let coloringMode = 'simple';
let repeaterRenderMode = 'hit';
let repeaterSearch = '';
let showSamples = false;

// Data
let nodes = null; // Graph data from the last refresh
let idToRepeaters = null; // Index of id -> [repeater]
let hashToCoverage = null; // Index of geohash -> coverage
let edgeList = null; // List of connected repeater and coverage
let topRepeaters = null; // List of [repeater, count] with most hits

// Map layers
const coverageLayer = L.layerGroup().addTo(map);
const edgeLayer = L.layerGroup().addTo(map);
const sampleLayer = L.layerGroup().addTo(map);
const repeaterLayer = L.layerGroup().addTo(map);

// Map controls
const mapControl = L.control({ position: 'topleft' });
mapControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'mesh-control leaflet-control');

  div.innerHTML = `
    <div id="meshMapControlsSection" class="mesh-control-row mesh-control-title interactive">Map Controls</div>
    <div id="meshMapControls" class="mesh-control-row">
      <div class="mesh-control-row">
        <label>
          Coloring:
          <select id="coverage-colormode-select">
            <option value="simple" title="Green for heard, Red for lost" selected>Simple</option>
            <option value="effective" title="Darker is confidence of message success or fail">Effective Coverage</option>
            <option value="observedPct" title="Darker is higher observed rate">Observed %</option>
            <option value="heardPct" title="Darker is higher heard rate">Heard %</option>
            <option value="notRepeated" title="Darker is high heard to observed ratio.">Heard, Not Repeated</option>
            <option value="bySnr" title="Darker better SNR.">SNR</option>
            <option value="byRssi" title="Darker better RSSI.">RSSI</option>
            <option value="lastObserved" title="Darker is more recently observed">Last Observed</option>
            <option value="lastHeard" title="Darker is more recently heard">Last Heard</option>
            <option value="lastUpdated" title="Darker is more recently pinged">Last Updated</option>
            <option value="pastDay" title="Tiles updated in the past 1 day are dark">Past Day</option>
            <option value="repeaterCount" title="Darker indicates more repeaters">Repeater Count</option>
            <option value="sampleCount" title="Darker indicates more samples">Sample Count</option>
          </select>
        </label>
      </div>
      <div class="mesh-control-row">
        <label>
          Repeaters:
          <select id="repeater-filter-select">
            <option value="all" title="Show all repeaters">All</option>
            <option value="hit" title="Show repeaters hit by pings" selected>Hit</option>
            <option value="none" title="Hide all repeaters">None</option>
          </select>
        </label>
      </div>
      <div class="mesh-control-row">
        <label>
          Find Id:
          <input type="text" id="repeater-search" />
        </label>
      </div>
      <div class="mesh-control-row">
        <label>
          Show Samples:
          <input type="checkbox" id="show-samples" disabled />
        </label>
      </div>
      <div class="mesh-control-row">
        <button type="button" id="refresh-map-button">Refresh map</button>
        <!--<label>
          🌈
          <input type="checkbox" id="use-colorscale" />
        </label>-->
      </div>
      <!--<div class="mesh-control-row color-scale" id="color-scale">
        <span>12</span>
        <span>25</span>
        <span>37</span>
        <span>50</span>
        <span>62</span>
        <span>75</span>
        <span>87</span>
        <span>100</span>
      </div>-->
    </div>
  `;

  div.querySelector("#meshMapControlsSection")
    .addEventListener("click", () => {
      const topRepeatersList = document.getElementById("meshMapControls");
      if (topRepeatersList.classList.contains("hidden"))
        topRepeatersList.classList.remove("hidden");
      else
        topRepeatersList.classList.add("hidden");
    });

  div.querySelector("#coverage-colormode-select")
    .addEventListener("change", (e) => {
      coloringMode = e.target.value;
      renderNodes(nodes);
    });

  div.querySelector("#repeater-filter-select")
    .addEventListener("change", (e) => {
      repeaterRenderMode = e.target.value;
      updateAllRepeaterMarkers();
    });

  div.querySelector("#repeater-search")
    .addEventListener("input", (e) => {
      repeaterSearch = e.target.value.toLowerCase();
      updateAllRepeaterMarkers();
    });

  div.querySelector("#show-samples")
    .addEventListener("change", (e) => {
      showSamples = e.target.checked;
      sampleLayer.eachLayer(s => updateSampleMarkerVisibility(s));
    });

  div.querySelector("#refresh-map-button")
    .addEventListener("click", () => refreshCoverage());


  // Don’t let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  // // Color the scale.
  // const scale = div.querySelector("#color-scale");
  // for (const span of scale.children) {
  //   const value = Number(span.textContent) / 100;
  //   span.style.backgroundColor = getColorForValue(value);
  // }

  return div;
};
mapControl.addTo(map);

const statsControl = L.control({ position: 'topright' });
statsControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'mesh-control leaflet-control');

  div.innerHTML = `
    <div id="topRepeatersSection" class="mesh-control-row mesh-control-title interactive">Top Repeaters</div>
    <div id="topRepeatersList" class="mesh-control-row hidden"></div>
  `;

  div.querySelector("#topRepeatersSection")
    .addEventListener("click", () => {
      const topRepeatersList = document.getElementById("topRepeatersList");
      if (topRepeatersList.classList.contains("hidden"))
        topRepeatersList.classList.remove("hidden");
      else
        topRepeatersList.classList.add("hidden");
    });

  // Don’t let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  renderTopRepeaters();

  return div;
};
statsControl.addTo(map);

// Max radius circle.
L.circle(centerPos, {
  radius: maxDistanceMiles * 1609.34, // meters in mile.
  color: '#a13139',
  weight: 3,
  fill: false
}).addTo(map);

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function shortDateStr(d) {
  return d.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// Gets a color for a value [0, 1]
function getColorForValue(v) {
  if (v > .875) return "#1EB100";
  if (v > .75) return "#00A1FE";
  if (v > .625) return "#1EE5CE";
  if (v > .5) return "#F9E231";
  if (v > .375) return "#FF9400";
  if (v > .25) return "#FF634D";
  if (v > .125) return "#ED230D";
  return "#B51700";
}

function getCoverageStyle(coverage) {
  const obsColor = '#398821'; // Observed - Green
  const hrdColor = '#FEAA2C'; // Heard - Orange
  const missColor = '#E04748'; // Lost - Red

  const color =
    coverage.obs > 0
      ? obsColor
      : coverage.hrd > 0
        ? hrdColor
        : missColor;

  // Default to "simple" style.
  const style = {
    color: color,
    fillOpacity: 0.6,
    opacity: 0.8,
    weight: 1,
    pane: "overlayPane"
  };

  switch (coloringMode) {
    case 'effective': {
      // Hits get a little boost. Only counting actual observations.
      const combined = coverage.obs * 0.25 - coverage.lost * 0.125;
      style.color = combined > 0 ? obsColor : missColor;
      style.fillOpacity = Math.min(0.9, Math.abs(combined));
      break;
    }

    case 'observedPct': {
      const sampleCount = coverage.obs + coverage.lost;
      const observedPercent = coverage.obs / sampleCount;
      style.fillOpacity = Math.min(0.9, Math.max(0.1, observedPercent));
      //style.color = getColorForValue(observedPercent);
      //style.fillOpacity = 0.8;
      break;
    }

    case 'heardPct': {
      const sampleCount = coverage.hrd + coverage.lost;
      const heardPercent = coverage.hrd / sampleCount;
      style.fillOpacity = Math.min(0.9, Math.max(0.1, heardPercent));
      break;
    }

    case 'notRepeated': {
      const sum = coverage.obs * 3 + coverage.hrd;
      if (sum > 0) {
        const heardRatio = coverage.hrd / sum;
        style.fillOpacity = Math.min(0.9, Math.max(0.1, heardRatio));
      } else {
        style.fillOpacity = 0.1;
      }
      break;
    }

    case 'bySnr': {
      if (coverage.snr != null) {
        const snr = coverage.snr / 12; // Normalize to about [-1, 1]
        style.color = snr > 0 ? obsColor : missColor;
        style.fillOpacity = Math.min(0.9, Math.abs(snr));
      } else {
        style.opacity = 0.2;
        style.fillOpacity = 0;
      }
      break;
    }

    case 'byRssi': {
      if (coverage.rssi != null) {
        // Normalize to about [-1, 1], centered on -80
        const rssi = 2 * sigmoid(coverage.rssi, 0.05, -80) - 1;
        style.color = rssi > 0 ? obsColor : missColor;
        style.fillOpacity = Math.min(0.9, Math.abs(rssi));
      } else {
        style.opacity = 0.2;
        style.fillOpacity = 0;
      }
      break;
    }

    case 'lastObserved': {
      const age = ageInDays(fromTruncatedTime(coverage.lot));
      style.fillOpacity = Math.max(0.1, (-0.075 * age + 0.85));
      break;
    }

    case 'lastHeard': {
      const age = ageInDays(fromTruncatedTime(coverage.lht));
      style.fillOpacity = Math.max(0.1, (-0.075 * age + 0.85));
      break;
    }

    case 'lastUpdated': {
      const age = ageInDays(fromTruncatedTime(coverage.ut));
      style.fillOpacity = Math.max(0.1, (-0.02 * age + 0.85));
      break;
    }

    case 'pastDay': {
      const age = ageInDays(fromTruncatedTime(coverage.ut));
      style.fillOpacity = age <= 1 ? 0.75 : 0.1;
      break;
    }

    case 'repeaterCount': {
      if (coverage.rptr?.length)
        style.fillOpacity = Math.min(0.9, sigmoid((coverage.rptr?.length ?? 0), 0.75, 1));
      else
        style.fillOpacity = 0;
      break;
    }

    case 'sampleCount': {
      // Heard is a superset of Observed.
      const sampleCount = coverage.hrd + coverage.lost;
      style.fillOpacity = Math.min(0.9, sigmoid(sampleCount, 0.5, 3));
    }

    default: break;
  }

  return style;
}

function coverageMarker(c) {
  const [minLat, minLon, maxLat, maxLon] = geo.decode_bbox(c.id);
  const totalSamples = c.hrd + c.lost;
  const obsRatio = c.obs / totalSamples;
  const updateDate = new Date(fromTruncatedTime(c.ut));
  const lastHeardDate = new Date(fromTruncatedTime(c.lht));
  const lastObservedDate = new Date(fromTruncatedTime(c.lot));
  const style = getCoverageStyle(c);
  const rect = L.rectangle([[minLat, minLon], [maxLat, maxLon]], style);
  const details = `
    <div><b>${c.id} · (${(100 * obsRatio).toFixed(0)}%)</b>
    <span class="text-xs">${maxLat.toFixed(4)},${maxLon.toFixed(4)}</span></div>
    <div>Observed: ${c.obs} · Heard: ${c.hrd} · Lost: ${c.lost}</div>
    ${c.snr ? `<div>SNR: ${c.snr ?? '✕'} · RSSI: ${c.rssi ?? '✕'}</div>` : ''}
    ${c.rptr.length > 0 ? `<div>Repeaters: ${c.rptr.join(', ')}</div>` : ''}
    <div class="text-xs">
    <div>Updated: ${shortDateStr(updateDate)}</div>
    ${c.hrd ? `<div>Heard: ${shortDateStr(lastHeardDate)}</div>` : ''}
    ${c.obs ? `<div>Observed: ${shortDateStr(lastObservedDate)}</div>` : ''}
    </div>`;

  rect.coverage = c;
  rect.bindPopup(details, { maxWidth: 320 });
  rect.on('popupopen', e => updateAllEdgeVisibility(e.target.coverage, false));
  rect.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    rect.on('mouseover', e => updateAllEdgeVisibility(e.target.coverage, false));
    rect.on('mouseout', () => updateAllEdgeVisibility());
  }

  c.marker = rect;
  return rect;
}

function sampleMarker(s) {
  const [lat, lon] = posFromHash(s.id);
  const path = s.path ?? [];
  const color =
    s.obs
      ? '#07ac07'    // Green
      : path.length > 0
        ? '#feaa2c'  // Orange
        : '#e96767'; // Red
  const style = {
    radius: 4,
    weight: 1,
    opacity: .9,
    color: "white",
    fillColor: color,
    fillOpacity: .75,
    pane: "markerPane",
    className: "marker-shadow"
  };
  const marker = L.circleMarker([lat, lon], style);
  const date = new Date(fromTruncatedTime(s.time));
  const details = `
    <div><b>${lat.toFixed(4)}, ${lon.toFixed(4)}</b></div>
    ${s.snr && s.rssi ? `<div>SNR: ${s.snr} · RSSI: ${s.rssi}</div>` : ''}
    ${path.length > 0 ? `<div>Hit: ${path.join(', ')}</div>` : ''}
    <div class="text-xs">${shortDateStr(date)}</div>
    <div class="text-xs">Geohash: ${s.id}</div>`;
  marker.bindPopup(details, { maxWidth: 320 });
  marker.on('add', () => updateSampleMarkerVisibility(marker));
  return marker;
}

function repeaterMarker(r) {
  const time = fromTruncatedTime(r.time);
  const stale = ageInDays(time) > 2;
  const dead = ageInDays(time) > 8;
  const ageClass = (dead ? "dead" : (stale ? "stale" : ""));
  const icon = L.divIcon({
    className: '', // Don't use default Leaflet style.
    html: `<div class="repeater-dot ${ageClass}"><span>${r.id}</span></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  const details = `
    <div><b>${escapeHtml(r.name)} [${r.id}]</b></div>
    <div>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} · <em>${(r.elev).toFixed(0)}m</em></div>
    <div class="text-xs">Last advert: ${shortDateStr(new Date(time))}</div>
    <div class="text-xs">Geohash: ${r.hash}</div>`;
  const marker = L.marker([r.lat, r.lon], { icon: icon });

  marker.repeater = r;
  marker.bindPopup(details, { maxWidth: 320 });
  marker.on('add', () => updateRepeaterMarkerVisibility(marker));
  marker.on('popupopen', e => updateAllEdgeVisibility(e.target.repeater, true));
  marker.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    marker.on('mouseover', e => updateAllEdgeVisibility(e.target.repeater, true));
    marker.on('mouseout', () => updateAllEdgeVisibility());
  }

  r.marker = marker;
  return marker;
}

function getBestRepeater(fromPos, repeaterList) {
  if (repeaterList.length === 1) {
    return repeaterList[0];
  }

  let minRepeater = null;
  let minDist = 30000; // Bigger than any valid dist.

  repeaterList.forEach(r => {
    const to = [r.lat, r.lon];
    const elev = r.elev ?? 0; // Allow height to impact distance.
    const dist = haversineMiles(fromPos, to) - (0.5 * Math.sqrt(elev));
    if (dist < minDist) {
      minDist = dist;
      minRepeater = r;
    }
  });

  return minRepeater;
}

function shouldShowRepeater(r) {
  // Prioritize searching
  if (repeaterSearch !== '') {
    return r.id.toLowerCase().startsWith(repeaterSearch);
  } else if (repeaterRenderMode === "hit") {
    return r.hitBy.length > 0;
  } else if (repeaterRenderMode === 'none') {
    return false;
  }
  return true;
}

function updateSampleMarkerVisibility(s) {
  const el = s.getElement();
  if (showSamples) {
    el.classList.remove("hidden");
    el.classList.add("leaflet-interactive");
  } else {
    el.classList.add("hidden");
    el.classList.remove("leaflet-interactive");
  }
}

function updateRepeaterMarkerVisibility(m, forceVisible = false, highlight = false) {
  const el = m.getElement();
  if (forceVisible || shouldShowRepeater(m.repeater)) {
    el.classList.remove("hidden");
    el.classList.add("leaflet-interactive");
  } else {
    el.classList.add("hidden");
    el.classList.remove("leaflet-interactive");
  }

  if (highlight) {
    el.querySelector(".repeater-dot").classList.add("highlighted");
  } else {
    el.querySelector(".repeater-dot").classList.remove("highlighted");
  }
}

function updateAllRepeaterMarkers() {
  repeaterLayer.eachLayer(m => updateRepeaterMarkerVisibility(m));
}

function updateCoverageMarkerHighlight(m, { highlight = false, dim = false } = {}) {
  const el = m.getElement();
  el.classList.remove("highlighted-path");
  el.classList.remove("dimmed-path");

  if (highlight) {
    el.classList.add("highlighted-path");
  } else if (dim) {
    el.classList.add("dimmed-path");
  }
}

function updateAllCoverageMarkers(dim = false) {
  coverageLayer.eachLayer(m => updateCoverageMarkerHighlight(m, { dim: dim }));
}

function updateAllEdgeVisibility(end, dimTiles = false) {
  const markersToOverride = [];
  const coverageToHighlight = [];

  // Reset markers to default.
  updateAllRepeaterMarkers();
  updateAllCoverageMarkers(dimTiles && end !== undefined);

  edgeLayer.eachLayer(e => {
    if (end !== undefined && e.ends.includes(end)) {
      // e.ends is [repeater, coverage]
      markersToOverride.push(e.ends[0].marker);
      coverageToHighlight.push(e.ends[1].marker);
      e.setStyle({ opacity: 0.5 });
    } else {
      e.setStyle({ opacity: 0 });
    }
  });

  // Force connected repeaters to be shown.
  markersToOverride.forEach(m => updateRepeaterMarkerVisibility(m, true, true));

  // Highlight connected coverage markers.
  coverageToHighlight.forEach(m => updateCoverageMarkerHighlight(m, { highlight: true }));
}

function renderNodes(nodes) {
  map.closePopup(); // Ensure pop-up handlers don't fire while updating.
  coverageLayer.clearLayers();
  edgeLayer.clearLayers();
  sampleLayer.clearLayers();
  repeaterLayer.clearLayers();

  // Add coverage boxes.
  hashToCoverage.entries().forEach(([key, coverage]) => {
    coverageLayer.addLayer(coverageMarker(coverage));
  });

  // Add recent samples.
  nodes.samples.forEach(s => {
    sampleLayer.addLayer(sampleMarker(s));
  });

  // Add repeaters.
  const repeatersToAdd = [...idToRepeaters.values()].flat();
  repeatersToAdd.forEach(r => {
    repeaterLayer.addLayer(repeaterMarker(r));
  });

  // Add edges.
  // TODO: Render on the fly instead to keep object count down?
  edgeList.forEach(e => {
    const style = {
      weight: 2,
      opacity: 0,
      dashArray: '2,4',
      interactive: false,
    };
    const line = L.polyline([e.repeater.pos, e.coverage.pos], style);
    line.ends = [e.repeater, e.coverage];
    line.addTo(edgeLayer);
  });
}

function renderTopRepeaters() {
  const topList = document.getElementById('topRepeatersList');
  if (topList && topRepeaters) {
    topList.innerHTML = '';
    topRepeaters.forEach(([id, count]) => {
      topList.innerHTML += `<div class="top-rpt-row"><div>${escapeHtml(id)}</div><div>${count}</div></div>`;
    });
  }
}

function buildIndexes(nodes) {
  hashToCoverage = new Map();
  idToRepeaters = new Map();
  edgeList = [];

  // Index coverage items.
  nodes.coverage.forEach(c => {
    c.pos = posFromHash(c.id);
    if (c.rptr === undefined) c.rptr = [];
    hashToCoverage.set(c.id, c);
  });

  // Add samples to coverage items.
  // TODO: shared helper for coverage ctor.
  nodes.samples.forEach(s => {
    const key = s.id.substring(0, 6);
    let coverage = hashToCoverage.get(key);
    if (!coverage) {
      coverage = {
        id: key,
        pos: posFromHash(key),
        obs: 0,
        hrd: 0,
        lost: 0,
        snr: null,
        rssi: null,
        ut: 0,
        lht: 0,
        lot: 0,
        rptr: [],
      };
      hashToCoverage.set(key, coverage);
    }

    const path = s.path ?? [];
    const observed = s.obs;
    const heard = path.length > 0;
    coverage.obs += observed ? 1 : 0;
    coverage.hrd += heard ? 1 : 0;
    coverage.lost += !heard ? 1 : 0;
    coverage.ut = Math.max(coverage.ut, s.time);
    coverage.lht = Math.max(coverage.lht, heard ? s.time : 0);
    coverage.lot = Math.max(coverage.lot, observed ? s.time : 0);
    coverage.snr = definedOr(Math.max, coverage.snr, s.snr);
    coverage.rssi = definedOr(Math.max, coverage.rssi, s.rssi);
    path.forEach(p => {
      const lp = p.toLowerCase();
      if (!coverage.rptr.includes(lp))
        coverage.rptr.push(lp);
    });
  });

  // Index repeaters.
  nodes.repeaters.forEach(r => {
    r.hitBy = [];
    r.pos = posFromHash(r.hash);
    [r.lat, r.lon] = r.pos;
    pushMap(idToRepeaters, r.id, r);
  });

  // Build connections.
  hashToCoverage.entries().forEach(([key, coverage]) => {
    coverage.rptr.forEach(r => {
      const candidateRepeaters = idToRepeaters.get(r);
      if (candidateRepeaters === undefined)
        return;

      const bestRepeater = getBestRepeater(coverage.pos, candidateRepeaters);
      bestRepeater.hitBy.push(coverage);
      edgeList.push({ repeater: bestRepeater, coverage: coverage });
    });
  });

  // Build top repeaters list (top 15).
  const repeaterGroups = Object.groupBy(edgeList, e => `[${e.repeater.id}] ${e.repeater.name}`);
  const sortedGroups = Object.entries(repeaterGroups).toSorted(([, a], [, b]) => b.length - a.length);
  topRepeaters = sortedGroups.slice(0, 15).map(([id, tiles]) => [id, tiles.length]);
}

export async function refreshCoverage() {
  const endpoint = "/get-nodes";
  const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  nodes = await resp.json();
  buildIndexes(nodes);
  renderNodes(nodes);
  renderTopRepeaters();
}
