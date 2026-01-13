import {
  ageInDays,
  centerPos,
  clamp,
  definedOr,
  fromTruncatedTime,
  geo,
  getMeshIdColor,
  haversineMiles,
  lerp,
  maxDistanceMiles,
  posFromHash,
  pushMap,
  sigmoid
} from './shared.js'

// --- Global Init ---
const map = L.map('map', {
  worldCopyJump: true,
  zoomControl: false,
}).setView(centerPos, 10);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 16,
  minZoom: 7,
  attribution: '© OpenStreetMap contributors | <a href="/howto" target="_blank">Contribute</a>'
}).addTo(map);

// Control state
let coloringMode = 'simple';
let repeaterRenderMode = 'none';
let repeaterSearch = '';
let showSamples = false;
let useColorScale = true;

// Data
let nodes = null; // Graph data from the last refresh
let idToRepeaters = null; // Index of id -> [repeater]
let hashToCoverage = null; // Index of geohash -> coverage
let edgeList = null; // List of connected repeater and coverage
let topRepeaters = null; // List of [repeater, count] with most hits
let rxData = null; // RxLog coverage
let hitRepeaters = new Set(); // Set of repeaters hit by tiles

// Map layers
const coverageLayer = L.layerGroup().addTo(map);
const edgeLayer = L.layerGroup().addTo(map);
const sampleLayer = L.layerGroup().addTo(map);
const repeaterLayer = L.layerGroup().addTo(map);

// --- Map controls ---
// Main Controls
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
            <option value="effective" title="Confidence of message success or fail (50 == inconclusive).">Effective Coverage</option>
            <option value="observedPct" title="Observed ping rate">Observed %</option>
            <option value="heardPct" title="Heard ping rate">Heard %</option>
            <option value="notRepeated" title="Ratio of heard to observed (Higher is worse)">Heard, Not Repeated</option>
            <option value="bySnr" title="SNR normalized as percentage">SNR</option>
            <option value="byRssi" title="RSSI normalized as percentage">RSSI</option>
            <option value="lastObserved" title="Higher is more recently observed">Last Observed</option>
            <option value="lastHeard" title="Higher is more recently heard">Last Heard</option>
            <option value="lastUpdated" title="Higher is more recently pinged">Last Updated</option>
            <option value="pastDay" title="Tiles updated in the past 1 day">Past Day</option>
            <option value="repeaterCount" title="Higher indicates more repeaters">Repeater Count</option>
            <option value="sampleCount" title="Higher indicates more samples">Sample Count</option>
            <option value="meshId" title="Color indicates the meshes that observed the pings">Mesh Id</option>
            <option value="rxLogRssi" title="RSSI normalized as percentage, RxLog data">RxLog RSSI</option>
            <option value="rxLogSnr" title="SNR normalized as percentage, RxLog data">RxLog SNR</option>
            <option value="rxLogRptrCnt" title="Higher indicates more repeaters, RxLog data">RxLog Repeater Count</option>
          </select>
        </label>
      </div>
      <div class="mesh-control-row">
        <label>
          Repeaters:
          <select id="repeater-filter-select">
            <option value="all" title="Show all repeaters">All</option>
            <option value="hit" title="Show repeaters hit by pings">Hit</option>
            <option value="none" title="Hide all repeaters" selected>None</option>
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
          <input type="checkbox" id="show-samples" />
        </label>
      </div>
      <div class="mesh-control-row">
        <div style="display: flex; gap: 10px;">
          <button type="button" id="refresh-map-button">Refresh map</button>
          <label style="gap: 1px;">
            🌈
            <input type="checkbox" id="use-colorscale" checked/>
          </label>
        </div>
      </div>
      <div class="mesh-control-row color-scale" id="color-scale">
        <span>12</span>
        <span>25</span>
        <span>37</span>
        <span>50</span>
        <span>62</span>
        <span>75</span>
        <span>87</span>
        <span>100</span>
      </div>
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
    .addEventListener("change", async (e) => {
      coloringMode = e.target.value;
      await redrawMap();
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
    .addEventListener("click", () => {
      rxData = null; // Will get refreshed next access.
      refreshCoverage();
    });

  div.querySelector("#use-colorscale")
    .addEventListener("change", async (e) => {
      const colorScaleEl = document.getElementById("color-scale");
      useColorScale = e.target.checked;

      if (useColorScale) {
        colorScaleEl.classList.remove("hidden");
        colorScaleEl.classList.add("mesh-control-row");
      } else {
        colorScaleEl.classList.add("hidden");
        colorScaleEl.classList.remove("mesh-control-row");
      }
      await redrawMap();
    });


  // Don’t let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  // Color the scale.
  const scale = div.querySelector("#color-scale");
  for (const span of scale.children) {
    const value = Number(span.textContent) / 100;
    span.style.backgroundColor = getColorForValue(value);
  }

  return div;
};
mapControl.addTo(map);

// Top Repeaters
const repeaterStatsControl = L.control({ position: 'topright' });
repeaterStatsControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'mesh-control leaflet-control');

  div.innerHTML = `
    <div id="topRepeatersSection" class="mesh-control-row mesh-control-title interactive">Top Repeaters</div>
    <div id="topRepeatersList" class="mesh-control-row hidden max-height-20"></div>
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
repeaterStatsControl.addTo(map);

// Top Contributors
const senderStatsControl = L.control({ position: 'topright' });
senderStatsControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'mesh-control leaflet-control');

  div.innerHTML = `
    <div id="topSendersSection" class="mesh-control-row mesh-control-title interactive">
      Top Contributors
    </div>
    <div id="topSendersList" class="mesh-control-row hidden max-height-20"></div>
  `;

  div.querySelector("#topSendersSection")
    .addEventListener("click", async () => {
      const topSendersList = document.getElementById("topSendersList");
      if (topSendersList.classList.contains("hidden")) {
        topSendersList.classList.remove("hidden");
        await refreshTopSenders(topSendersList);
      } else {
        topSendersList.classList.add("hidden");
      }
    });

  // Don’t let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  // Helper to refresh the stats.
  async function refreshTopSenders(topList) {
    const endpoint = "/get-senders";
    const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

    if (resp.ok) {
      const data = await resp.json();
      if (topList && data) {
        topList.innerHTML = '';
        let rank = 1;
        data.forEach(d => {
          topList.innerHTML += `<div class="top-row"><div>${rank++}</div><div>${escapeHtml(d.name)}</div><div>${d.tiles}</div></div>`;
        });
      }
    }
  }

  return div;
};
senderStatsControl.addTo(map);

// Max radius circle.
L.circle(centerPos, {
  radius: maxDistanceMiles * 1609.34, // meters in mile.
  color: '#a13139',
  weight: 3,
  fill: false
}).addTo(map);

// --- UX Helpers ---
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

// Gets a color for a value [0, 1].
function getColorForValue(v) {
  if (v > .875) return "#2B2D9F"; // indigo
  if (v > .75) return "#3F5CCB";  // royal blue
  if (v > .625) return "#2F8EDB"; // azure
  if (v > .5) return "#2EC7D3";   // cyan
  if (v > .375) return "#F1E04F"; // yellow
  if (v > .25) return "#F4B63D";  // amber
  if (v > .125) return "#F18F01"; // orange
  return "#E4572E";               // red-orange
}

function getCoverageStyle(coverage) {
  const obsColor = '#398821';  // Observed - Green
  const hrdColor = '#FEAA2C';  // Heard - Orange
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
    opacity: 0.75,
    weight: 1,
    pane: "overlayPane"
  };

  switch (coloringMode) {
    case 'effective': {
      // Hits get boosted. Only counting observations.
      const combined = coverage.obs * 0.25 - coverage.lost * 0.125;
      if (useColorScale) {
        style.fillColor = getColorForValue(lerp(combined, -1, 1));
        style.opacity = 0;
        style.fillOpacity = 0.8;
      } else {
        style.color = combined > 0 ? obsColor : missColor;
        style.opacity = 0.3;
        style.fillOpacity = clamp(Math.abs(combined), 0.1, 0.9);
      }
      break;
    }

    case 'observedPct': {
      const sampleCount = coverage.obs + coverage.lost;
      const observedPercent = coverage.obs / sampleCount;
      if (observedPercent > 0) {
        if (useColorScale) {
          style.color = getColorForValue(observedPercent);
        } else {
          style.opacity = 0.5;
          style.fillOpacity = clamp(observedPercent, 0.1, 0.9);
        }
      } else {
        style.opacity = 0.1;
        style.fillOpacity = 0.1;
      }
      break;
    }

    case 'heardPct': {
      const sampleCount = coverage.hrd + coverage.lost;
      const heardPercent = coverage.hrd / sampleCount;
      if (heardPercent > 0) {
        if (useColorScale) {
          style.color = getColorForValue(heardPercent);
        } else {
          style.opacity = 0.5;
          style.fillOpacity = clamp(heardPercent, 0.1, 0.9);
        }
      } else {
        style.opacity = 0.1;
        style.fillOpacity = 0.1;
      }
      break;
    }

    case 'notRepeated': {
      const diff = coverage.hrd - coverage.obs;
      if (diff > 0) {
        if (useColorScale) {
          style.color = getColorForValue(lerp(diff, 1, 8));
        } else {
          style.fillOpacity = lerp(diff, 1, 8, .4, .9);
        }
      } else {
        style.opacity = 0.1;
        style.fillOpacity = 0.1;
      }
      break;
    }

    case 'rxLogSnr':
    case 'bySnr': {
      if (coverage.snr != null) {
        if (useColorScale) {
          style.color = getColorForValue(lerp(coverage.snr, -8, 8));
          style.fillOpacity = 0.85;
        } else {
          const snr = coverage.snr / 8; // Normalize to about [-1, 1]
          style.color = snr > 0 ? obsColor : missColor;
          style.fillOpacity = Math.min(0.9, Math.abs(snr));
        }
      } else {
        style.opacity = 0.2;
        style.fillOpacity = 0;
      }
      break;
    }

    case 'rxLogRssi':
    case 'byRssi': {
      if (coverage.rssi != null) {
        if (useColorScale) {
          style.color = getColorForValue(lerp(coverage.rssi, -120, -40));
          style.fillOpacity = 0.85;
        } else {
          // Normalize to about [-1, 1], centered on -80
          const rssi = 2 * sigmoid(coverage.rssi, 0.05, -80) - 1;
          style.color = rssi > 0 ? obsColor : missColor;
          style.fillOpacity = Math.min(0.9, Math.abs(rssi));
        }
      } else {
        style.opacity = 0.2;
        style.fillOpacity = 0;
      }
      break;
    }

    case 'lastObserved': {
      const age = ageInDays(fromTruncatedTime(coverage.lot));
      if (useColorScale) {
        style.color = getColorForValue(lerp(age, 30, 0));
      } else {
        style.fillOpacity = Math.max(0.1, (-0.075 * age + 0.85));
      }
      break;
    }

    case 'lastHeard': {
      const age = ageInDays(fromTruncatedTime(coverage.lht));
      if (useColorScale) {
        style.color = getColorForValue(lerp(age, 30, 0));
      } else {
        style.fillOpacity = Math.max(0.1, (-0.075 * age + 0.85));
      }
      break;
    }

    case 'lastUpdated': {
      const age = ageInDays(fromTruncatedTime(coverage.ut));
      if (useColorScale) {
        style.color = getColorForValue(lerp(age, 30, 0));
      } else {
        style.fillOpacity = Math.max(0.1, (-0.075 * age + 0.85));
      }
      break;
    }

    case 'pastDay': {
      const age = ageInDays(fromTruncatedTime(coverage.ut));
      style.opacity = age <= 1 ? 0.75 : 0.1;
      style.fillOpacity = age <= 1 ? 0.75 : 0.1;
      break;
    }

    case 'rxLogRptrCnt':
    case 'repeaterCount': {
      const repeaterCount = coverage.rptr?.length;
      if (repeaterCount) {
        if (useColorScale) {
          style.color = getColorForValue(lerp(repeaterCount, 1, 5));
          style.fillOpacity = 0.8;
        } else {
          style.fillOpacity = Math.min(0.9, sigmoid(repeaterCount, 0.75, 1));
        }
      } else {
        style.opacity = 0.2;
        style.fillOpacity = 0;
      }
      break;
    }

    case 'sampleCount': {
      // Heard is a superset of Observed.
      const sampleCount = coverage.hrd + coverage.lost;
      if (useColorScale) {
        style.color = getColorForValue(lerp(sampleCount, 1, 10));
        style.fillOpacity = 0.8;
      } else {
        style.fillOpacity = Math.min(0.9, sigmoid(sampleCount, 0.5, 3));
      }
    }

    case 'meshId': {
      if (coverage.msh.length) {
        style.color = getMeshIdColor(coverage.msh);
        style.opacity = 0;
        style.fillOpacity = 0.9;
      } else {
        style.opacity = 0.2;
        style.fillOpacity = 0;
      }
    }

    default: break;
  }

  return style;
}

// --- Marker Builders ---
function rxCoverageMarker(c) {
  const [minLat, minLon, maxLat, maxLon] = geo.decode_bbox(c.hash);
  const updated = new Date(c.time);
  const rptrTable = c.rptr.map(r => {
    return `<div class="rx-repeater-table-row">
        <span>${r.id}</span>
        <span>${r.snr_avg.toFixed(1)}</span>
        <span>${r.rssi_avg.toFixed(1)}</span>
        <span>${r.count}</span>
      </div>`;
  });
  const style = getCoverageStyle(c);
  const rect = L.rectangle([[minLat, minLon], [maxLat, maxLon]], style);
  const details = `
    <div><b>${c.hash}</b>
    <span class="text-xs">${maxLat.toFixed(4)},${maxLon.toFixed(4)}</span></div>
    <div>SNR: ${c.snr.toFixed(2)} · RSSI: ${c.rssi.toFixed(2)}</div>
    <div class="rx-repeater-table">
    <div class="rx-repeater-table-row header">
      <span>Id</span><span>SNR</span><span>RSSI</span><span>#</span>
    </div>
    ${rptrTable.join('')}
    </div>
    <div class="text-xs">Updated: ${shortDateStr(updated)}</div>`;

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
    ${c.snr || c.rssi ? `<div>SNR: ${c.snr ?? '✕'} · RSSI: ${c.rssi ?? '✕'}</div>` : ''}
    ${c.rptr.length > 0 ? `<div>Repeaters: ${c.rptr.join(', ')}</div>` : ''}
    <div class="text-xs">
    ${c.ut ? `<div>Updated: ${shortDateStr(updateDate)}</div>` : ''}
    ${c.hrd ? `<div>Heard: ${shortDateStr(lastHeardDate)}</div>` : ''}
    ${c.obs ? `<div>Observed: ${shortDateStr(lastObservedDate)}</div>` : ''}
    ${c.msh.length ? `<div>Mesh Ids: ${c.msh.join(', ')}</div>` : ''}
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

// --- Repeater Helpers ---
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
    return hitRepeaters.has(r);
  } else if (repeaterRenderMode === 'none') {
    return false;
  }
  return true;
}

// --- Visibility ---
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

// --- Render Map ---
async function redrawMap() {
  hitRepeaters.clear()

  switch (coloringMode) {
    case "rxLogRssi":
    case "rxLogSnr":
    case "rxLogRptrCnt":
      await renderPassive();
      break;

    default:
      renderNodes(nodes);
      break;
  }
}

async function renderPassive() {
  map.closePopup(); // Ensure pop-up handlers don't fire while updating.
  coverageLayer.clearLayers();
  edgeLayer.clearLayers();
  sampleLayer.clearLayers();
  repeaterLayer.clearLayers();

  if (rxData === null) {
    try {
      const resp = await fetch("/get-rx-samples");
      rxData = (await resp.json()) ?? [];
      rxData.forEach(c => {
        c.pos = posFromHash(c.hash);
        c.rptr = c.repeaters;
        delete c.repeaters;
      });
      console.log(`Got ${rxData.length} rx-samples from service.`);
    } catch (e) {
      console.error("Getting rx-samples failed", e);
    }
  }

  const rxEdgeList = [];

  // Add coverage boxes.
  rxData.forEach(c => {
    coverageLayer.addLayer(rxCoverageMarker(c));

    c.rptr.forEach(r => {
      const candidateRepeaters = idToRepeaters.get(r.id);
      if (candidateRepeaters === undefined)
        return;

      const bestRepeater = getBestRepeater(c.pos, candidateRepeaters);
      rxEdgeList.push({ repeater: bestRepeater, coverage: c });
    });
  });

  // Add repeaters.
  nodes.repeaters.forEach(r => {
    repeaterLayer.addLayer(repeaterMarker(r));
  });

  // Add edges.
  // TODO: Render on the fly instead to keep object count down?
  rxEdgeList.forEach(e => {
    const style = {
      weight: 2,
      opacity: 0,
      dashArray: '2,4',
      interactive: false,
    };
    const line = L.polyline([e.repeater.pos, e.coverage.pos], style);
    line.ends = [e.repeater, e.coverage];
    line.addTo(edgeLayer);
    hitRepeaters.add(e.repeater);
  });
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
  nodes.repeaters.forEach(r => {
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
    hitRepeaters.add(e.repeater);
  });
}

function renderTopRepeaters() {
  const topList = document.getElementById('topRepeatersList');
  if (topList && topRepeaters) {
    topList.innerHTML = '';
    let rank = 1;
    topRepeaters.forEach(([id, count]) => {
      topList.innerHTML += `<div class="top-row"><div>${rank++}</div><div>${escapeHtml(id)}</div><div>${count}</div></div>`;
    });
  }
}

// --- Load and Init
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
        msh: null
      };
      hashToCoverage.set(key, coverage);
    }

    const meshIds = s.msh ?? [];
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
    meshIds.forEach(m => {
      if (!coverage.msh)
        coverage.msh = [m];
      else if (!coverage.msh.includes(m))
        coverage.msh.push(m);
    });
  });

  // Index repeaters.
  nodes.repeaters.forEach(r => {
    r.pos = posFromHash(r.hash);
    [r.lat, r.lon] = r.pos;
    pushMap(idToRepeaters, r.id, r);
  });

  // Build connections.
  hashToCoverage.entries().forEach(([key, coverage]) => {
    // Ensure meshIds are sorted.
    coverage.msh = coverage.msh?.sort() ?? [];

    coverage.rptr.forEach(r => {
      const candidateRepeaters = idToRepeaters.get(r);
      if (candidateRepeaters === undefined)
        return;

      const bestRepeater = getBestRepeater(coverage.pos, candidateRepeaters);
      edgeList.push({ repeater: bestRepeater, coverage: coverage });
    });
  });

  // Build top repeaters list (top 50).
  const repeaterGroups = Object.groupBy(edgeList, e => `[${e.repeater.id}] ${e.repeater.name}`);
  const sortedGroups = Object.entries(repeaterGroups).toSorted(([, a], [, b]) => b.length - a.length);
  topRepeaters = sortedGroups.slice(0, 50).map(([id, tiles]) => [id, tiles.length]);
}

export async function refreshCoverage() {
  const endpoint = "/get-nodes";
  const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  nodes = await resp.json();
  buildIndexes(nodes);
  await redrawMap();
  renderTopRepeaters();
}
