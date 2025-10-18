import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

interface Quake {
  id: string;
  latitude: number;
  longitude: number;
  depth: number;
  magnitude: number;
  place: string;
  occurred_at: string;
  source: 'phivolcs' | 'usgs';
}

const app = express();

// Helper timeout for fetch
const timeout = (ms: number) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Request timeout')), ms));

// 🟢 Fetch PHIVOLCS data
const fetchPhivolcs = async (): Promise<Quake[]> => {
  try {
    const response = await Promise.race([
      fetch('https://earthquake.phivolcs.dost.gov.ph/'),
      timeout(10000),
    ]);

    const html = await response.text();
    if (!html || html.length < 1000) return [];

    const $ = cheerio.load(html);
    const earthquakes: Quake[] = [];
    const MAX_QUAKES = 100;

    const outerTable = $('.MsoNormalTable').eq(2);
    const targetTable = outerTable.find('table').first().length
      ? outerTable.find('table').first()
      : outerTable;

    targetTable.find('tr').each((index, el) => {
      if (earthquakes.length >= MAX_QUAKES) return false;

      const tds = $(el).find('td');
      if (tds.length >= 6) {
        const dateTime = $(tds[0]).text().trim();
        const latitude = parseFloat($(tds[1]).text().trim());
        const longitude = parseFloat($(tds[2]).text().trim());
        const depth = parseFloat($(tds[3]).text().trim());
        const magnitude = parseFloat($(tds[4]).text().trim());
        const location = $(tds[5]).text().trim() || 'Philippines Region';

        if (!dateTime || isNaN(latitude) || isNaN(longitude) || isNaN(depth) || isNaN(magnitude))
          return;

        earthquakes.push({
          id: `phivolcs-${index}-${Date.now()}`,
          latitude,
          longitude,
          depth,
          magnitude,
          place: location,
          occurred_at: parsePhivolcsDate(dateTime),
          source: 'phivolcs',
        });
      }
    });

    return earthquakes;
  } catch (err) {
    console.error('❌ PHIVOLCS fetch error:', err);
    return [];
  }
};

// 🟢 Fetch USGS data
interface USGSGeoJSON {
  type: string;
  metadata: any;
  features: Array<{
    id: string;
    properties: {
      mag: number;
      place: string;
      time: number;
    };
    geometry: {
      coordinates: [number, number, number];
    };
  }>;
}

const fetchUSGS = async (): Promise<Quake[]> => {
  try {
    const response = await Promise.race([
      fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson'),
      timeout(10000),
    ]);

    // Tell TypeScript the expected shape
    const data: USGSGeoJSON = await response.json() as USGSGeoJSON;

    return data.features
      .filter((f) => f.properties.mag >= 2.5)
      .slice(0, 200)
      .map((f) => ({
        id: f.id,
        latitude: f.geometry.coordinates[1],
        longitude: f.geometry.coordinates[0],
        depth: f.geometry.coordinates[2],
        magnitude: f.properties.mag,
        place: f.properties.place,
        occurred_at: new Date(f.properties.time).toISOString(),
        source: 'usgs',
      }));
  } catch (err) {
    console.error('❌ USGS fetch error:', err);
    return [];
  }
};

// 🕓 Parse PHIVOLCS date string like "17 October 2025 - 09:13 PM"
function parsePhivolcsDate(str: string): string {
  try {
    const match = str.match(/(\d{1,2}) (\w+) (\d{4}) - (\d{1,2}):(\d{2}) (AM|PM)/);
    if (!match) return new Date().toISOString();

    const [, day, monthName, year, hourStr, minuteStr, ampm] = match;
    const months: { [key: string]: number } = {
      January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
      July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
    };

    let hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;

    const month = months[monthName];
    return new Date(Date.UTC(parseInt(year), month, parseInt(day), hour - 8, minute)).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ✅ Single endpoint returning both PHIVOLCS + USGS
app.get('/api/all-quakes', async (_req, res) => {
  try {
    const [phivolcs, usgs] = await Promise.all([fetchPhivolcs(), fetchUSGS()]);
    const allQuakes = [...phivolcs, ...usgs].sort((a, b) =>
      new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
    );
    res.json({ count: allQuakes.length, quakes: allQuakes });
  } catch (err) {
    console.error('❌ Fetch all quakes error:', err);
    res.status(500).json({ error: 'Failed to fetch earthquake data' });
  }
});

export default app;
