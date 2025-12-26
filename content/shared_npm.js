import geo from 'ngeohash';
import aes from 'aes-js';
import { colord } from 'colord';

export { aes, geo };  // export APIs.

// Generates 8 char geohash for the given lat/lon.
export function geohash8(lat, lon) {
  return geo.encode(lat, lon, 8);
}

// Generates 6 char geohash for the given lat/lon.
export function geohash6(lat, lon) {
  return geo.encode(lat, lon, 6);
}

// Gets [lat, lon] for the specified geohash.
export function posFromHash(geohash) {
  const { latitude: lat, longitude: lon } = geo.decode(geohash);
  return [lat, lon];
}

// Haversine distance between two [lat, lon] points, in miles.
export function haversineMiles(a, b) {
  const R = 3958.8; // Earth radius in miles
  const toRad = deg => deg * Math.PI / 180;

  const [lat1, lon1] = a;
  const [lat2, lon2] = b;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

// The center position to use for point filtering.
export const centerPos = [27.7700, -82.3899];
export const maxDistanceMiles = 100;

export function isValidLocation(p) {
  const [lat, lon] = p;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return false;
  }

  return haversineMiles(centerPos, p) < maxDistanceMiles;
}

function roundToFourPlaces(n) {
  // Really, Javascript?
  return Math.round(n * 10000) / 10000;
}

export function parseLocation(latStr, lonStr) {
  let lat = parseFloat(latStr);
  let lon = parseFloat(lonStr);

  if (isNaN(lat) || isNaN(lon)) {
    throw new Error(`Invalid location ${[latStr, lonStr]}`);
  }

  lat = roundToFourPlaces(lat);
  lon = roundToFourPlaces(lon);

  if (!isValidLocation([lat, lon])) {
    throw new Error(`${[lat, lon]} exceeds max distance`);
  }

  return [lat, lon];
}

export const dayInMillis = 24 * 60 * 60 * 1000; 

export function ageInDays(time) {
  return (Date.now() - new Date(time)) / dayInMillis;
}

// Adds the value to a list associated with key.
export function pushMap(map, key, value) {
  const items = map.get(key);
  if (items)
    items.push(value);
  else
    map.set(key, [value]);
}

export function getOrAdd(map, key, value) {
  const v = map.get(key);
  if (v) return v;
  
  map.set(key, value);
  return value;
}

export function sigmoid(value, scale = 0.25, center = 0) {
  const g = scale * (value - center)
  return 1 / (1 + Math.exp(-g));
}

// About 1 minute accuracy.
const TIME_TRUNCATION = 100000;

export function truncateTime(time) {
  return Math.round(time / TIME_TRUNCATION);
}

export function fromTruncatedTime(truncatedTime) {
  return truncatedTime * TIME_TRUNCATION;
}

export async function retry(func, maxRetries = 5, retryDelayMs = 500) {
  let attempt = 0;
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  while (true) {
    try {
      await func();
      return;
    } catch (err) {
      attempt++;

      if (attempt >= maxRetries)
        throw new Error(`Exceeded max retries. ${err}`);
      else
        console.log(`Attempt ${attempt} failed with ${err}`);
        await sleep(retryDelayMs * attempt);
    }
  }
}

export function definedOr(fn, a, b) {
  if (a != null && b != null)
    return fn(a, b);

  if (a == null && b == null)
    return null;

  return a != null ? a : b;
}

export function or(a, b) { return a || b; }
export function and(a, b) {return  a && b; }

export function fadeColor(color, amount) {
  const c = colord(color);
  const v = c.toHsv().v;
  return c.desaturate(amount).lighten(amount * (1 - (v / 255))).toHex();
}

export function toHex(num) {
  if (num == null) return num; // Nullish

  let numStr = num.toString(16);
  if (numStr.length % 2)
    numStr = numStr.padStart(numStr.length + 1, "0");
  return numStr;
}
