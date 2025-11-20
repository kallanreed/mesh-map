import geo from 'ngeohash';

// TODO: consolidate shared JS and create bundle for web instead.

// Generates the key for a sample given lat/lon.
export function sampleKey(lat, lon) {
  return geo.encode(lat, lon, 8);
}