import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import NodeCache from "node-cache";
import fs from "fs/promises";
import { existsSync } from "fs";

// Initialize cache with 24 hour TTL
const sightingsCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "squirrel_sightings.json");

// In-memory store for bulk sightings
let bulkStore: Record<string, any[]> = {
  red: [],
  grey: []
};

let syncStatus: Record<string, { 
  isLoading: boolean, 
  count: number, 
  totalEstimated: number, 
  phase: string,
  currentYear?: number,
  lastSync?: string
}> = {
  red: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle' },
  grey: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle' }
};

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

async function saveDataToFile() {
  try {
    await ensureDataDir();
    await fs.writeFile(DATA_FILE, JSON.stringify(bulkStore, null, 2));
    console.log(`[Persistence] Data saved to ${DATA_FILE}`);
  } catch (error) {
    console.error(`[Persistence] Error saving data:`, error);
  }
}

async function loadDataFromFile() {
  try {
    if (existsSync(DATA_FILE)) {
      const data = await fs.readFile(DATA_FILE, 'utf-8');
      bulkStore = JSON.parse(data);
      console.log(`[Persistence] Loaded ${bulkStore.red.length} red and ${bulkStore.grey.length} grey records from file.`);
    }
  } catch (error) {
    console.error(`[Persistence] Error loading data:`, error);
  }
}

async function fetchAllSightings(species: 'red' | 'grey', forceReset: boolean = false) {
  if (syncStatus[species].isLoading && !forceReset) {
    console.log(`[Sync] Already in progress for ${species}.`);
    return;
  }
  
  syncStatus[species] = { 
    ...syncStatus[species],
    isLoading: true, 
    count: 0, 
    totalEstimated: 0, 
    phase: 'Initializing',
    currentYear: 2008
  };
  
  console.log(`[Bulk Load] Starting sync for ${species} squirrels in Scotland (Year by Year)...`);
  const lsid = species === "grey" ? "NHMSYS0000080184" : "NHMSYS0000080188";
  const query = species === "red" 
    ? `(scientificName:"Sciurus vulgaris" OR taxonConceptID:NBNSYS0000005108 OR lsid:NHMSYS0000080188)`
    : `(scientificName:"Sciurus carolinensis" OR taxonConceptID:NBNSYS0000005107 OR lsid:NHMSYS0000080184)`;
  const url = `https://records-ws.nbnatlas.org/occurrences/search`;
  const currentYear = new Date().getFullYear();
  let allRecords: any[] = [];
  const foundSources = new Set<string>();

  try {
    // Get accurate global total first
    const ssrsFilter = `(dataResourceUid:dr382 OR dataResourceUid:dr1711 OR dataResourceUid:dr1712 OR dataResourceUid:dr659 OR dataResourceName:"Saving Scotland's Red Squirrels"*)`;
    const globalCheck = await axios.get(url, {
      params: {
        q: query,
        fq: [`decimalLatitude:[54.0 TO 62.0]`, `decimalLongitude:[-9.0 TO 0.0]`, `year:[2008 TO ${currentYear}]`, ssrsFilter],
        pageSize: 0
      }
    });
    syncStatus[species].totalEstimated = globalCheck.data.totalRecords || 0;
    syncStatus[species].count = 0;

    // Reset current store for this species if force resetting to ensure only SSRS data remains
    if (forceReset) {
      bulkStore[species] = [];
    }

    for (let year = 2008; year <= currentYear; year++) {
      syncStatus[species].currentYear = year;
      
      const yearCheck = await axios.get(url, {
        params: {
          q: query,
          fq: [`decimalLatitude:[54.0 TO 62.0]`, `decimalLongitude:[-9.0 TO 0.0]`, `year:${year}`, ssrsFilter],
          pageSize: 0
        }
      });
      const yearTotal = yearCheck.data.totalRecords || 0;
      if (yearTotal === 0) continue;

      const months = yearTotal > 4500 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [null];

      for (const month of months) {
        syncStatus[species].phase = `Fetching ${species} records for ${year}${month ? '-' + month : ''}`;
        
        let startOffset = 0;
        const pageSize = 1000;
        let hasMoreInPeriod = true;

        const fq = [
          `decimalLatitude:[54.0 TO 62.0]`,
          `decimalLongitude:[-9.0 TO 0.0]`,
          `year:${year}`,
          ssrsFilter
        ];
        if (month) fq.push(`month:${month}`);

        while (hasMoreInPeriod) {
          try {
            const response = await axios.get(url, {
              params: {
                q: query,
                fq: fq,
                pageSize: pageSize,
                start: startOffset,
                fl: "id,decimalLatitude,decimalLongitude,year,species,scientificName,raw_commonName,occurrenceDate,dataResourceName,dataResourceUid",
              },
              timeout: 90000 // Increased timeout for potentially large responses
            });

            let records = response.data.occurrences || [];
            const totalResults = response.data.totalRecords || 0;
            
            if (records.length === 0) {
              hasMoreInPeriod = false;
              continue;
            }

            const rawFetchedCount = records.length;
            const scientificNameTarget = (species === "red" ? "Sciurus vulgaris" : "Sciurus carolinensis").toLowerCase();
            
            // Be more permissive with name matching to avoid dropping valid records due to metadata variations
            records = records.filter((r: any) => {
              const rSciName = (r.scientificName || r.species || "").toLowerCase();
              const rCommonName = (r.raw_commonName || "").toLowerCase();
              return rSciName.includes(scientificNameTarget) || rCommonName.includes(species);
            });

            allRecords = [...allRecords, ...records];
            syncStatus[species].count = allRecords.length;
            
            if (rawFetchedCount < pageSize || startOffset + pageSize >= totalResults || startOffset + pageSize >= 5000) {
              hasMoreInPeriod = false;
            } else {
              startOffset += pageSize;
            }
          } catch (err: any) {
            console.error(`[Bulk Load] Error at ${year}${month ? '-' + month : ''}, offset ${startOffset}:`, err.message);
            hasMoreInPeriod = false; 
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
    }

    console.log(`[Bulk Load] ${species} SYNC FINISHED. total=${allRecords.length}`);
    bulkStore[species] = allRecords;
    syncStatus[species].phase = 'Saving to disk';
    syncStatus[species].lastSync = new Date().toISOString();
    await saveDataToFile();
    syncStatus[species].phase = 'Complete';
  } catch (error) {
    console.error(`[Bulk Load] Fatal error syncing ${species}:`, error);
    syncStatus[species].phase = 'Error';
  } finally {
    syncStatus[species].isLoading = false;
  }
}

// Start initial background sync and load from file
(async () => {
  await loadDataFromFile();
  // If we have very few records (like the old query results), trigger a fresh sync
  if (bulkStore.red.length < 10000) fetchAllSightings('red');
  if (bulkStore.grey.length < 500) fetchAllSightings('grey');
})();

const isSSRS = (s: any) => {
  const ssrsUids = ['dr382', 'dr1711', 'dr1712', 'dr1713', 'dr2140', 'dr383', 'dr659'];
  const nameMatch = s.dataResourceName && s.dataResourceName.includes("Saving Scotland's Red Squirrels");
  const uidMatch = s.dataResourceUid && ssrsUids.includes(s.dataResourceUid);
  return !!(nameMatch || uidMatch);
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route to fetch bulk or filtered sightings
  app.get("/api/sightings", async (req, res) => {
    const { species, startYear, endYear, latMin, latMax, lonMin, lonMax, zoom, forceRefresh } = req.query;
    
    const speciesKey = (species as 'red' | 'grey') || 'red';

    // Check if we need to trigger a load
    if (bulkStore[speciesKey].length === 0 || forceRefresh === 'true') {
      if (bulkStore[speciesKey].length === 0) {
        await fetchAllSightings(speciesKey);
      } else {
        // Trigger background sync but don't wait for it
        fetchAllSightings(speciesKey, forceRefresh === 'true'); 
      }
    }

    // Strictly filter to SSRS only, even for cached data
    let results = bulkStore[speciesKey].filter(isSSRS);

    // 1. Time Filter
    if (startYear || endYear) {
      const start = parseInt(startYear as string) || 2008;
      const end = parseInt(endYear as string) || new Date().getFullYear();
      results = results.filter(s => s.year >= start && s.year <= end);
    }

    // 2. Bounds Filter
    if (latMin && latMax && lonMin && lonMax) {
      const l1 = parseFloat(latMin as string);
      const l2 = parseFloat(latMax as string);
      const ln1 = parseFloat(lonMin as string);
      const ln2 = parseFloat(lonMax as string);
      results = results.filter(s => {
        const lat = parseFloat(s.decimalLatitude);
        const lon = parseFloat(s.decimalLongitude);
        return lat >= l1 && lat <= l2 && lon >= ln1 && lon <= ln2;
      });
    }

    const totalCountInBounds = results.length;
    const currentZoom = parseInt(zoom as string) || 10;
    
    // 3. Thinning Logic
    // If zoomed in (e.g. village level) or if few records, don't thin
    const shouldThin = totalCountInBounds > 10000 && currentZoom < 13;
    const isThinned = shouldThin;
    
    if (shouldThin) {
      const MAX_POINTS = 10000;
      // Grid-based spatial sampling to preserve local clusters and geographic distribution
      // Default bounding box or provided bounds
      const minLat = latMin ? parseFloat(latMin as string) : 54.5;
      const maxLat = latMax ? parseFloat(latMax as string) : 61.0;
      const minLon = lonMin ? parseFloat(lonMin as string) : -8.5;
      const maxLon = lonMax ? parseFloat(lonMax as string) : -0.5;
      
      const gridSize = 60; 
      const grid: Record<string, any[]> = {};
      
      for (const sighting of results) {
        const lat = parseFloat(sighting.decimalLatitude);
        const lon = parseFloat(sighting.decimalLongitude);
        const x = Math.floor(((lat - minLat) / (maxLat - minLat)) * gridSize);
        const y = Math.floor(((lon - minLon) / (maxLon - minLon)) * gridSize);
        const cellKey = `${x},${y}`;
        if (!grid[cellKey]) grid[cellKey] = [];
        grid[cellKey].push(sighting);
      }
      
      const sampled = [];
      const cells = Object.values(grid);
      const pointsPerCell = Math.max(1, Math.ceil(MAX_POINTS / cells.length));
      
      for (const cellRecords of cells) {
        cellRecords.sort((a, b) => (b.year || 0) - (a.year || 0));
        const toTake = Math.min(cellRecords.length, pointsPerCell);
        for (let i = 0; i < toTake; i++) {
          sampled.push(cellRecords[i]);
          if (sampled.length >= MAX_POINTS) break;
        }
        if (sampled.length >= MAX_POINTS) break;
      }
      results = sampled;
    }

    res.json({
      occurrences: results,
      total: totalCountInBounds,
      thinned: isThinned,
      isSyncing: syncStatus[speciesKey].isLoading
    });
  });

  app.get("/api/population-stats", async (req, res) => {
    const { latMin, latMax, lonMin, lonMax, startYear, endYear } = req.query;
    
    const start = parseInt(startYear as string) || 2008;
    const end = parseInt(endYear as string) || new Date().getFullYear();
    
    const stats: Record<number, { red: number; grey: number }> = {};
    for (let y = start; y <= end; y++) {
      stats[y] = { red: 0, grey: 0 };
    }

    const l1 = latMin ? parseFloat(latMin as string) : -90;
    const l2 = latMax ? parseFloat(latMax as string) : 90;
    const ln1 = lonMin ? parseFloat(lonMin as string) : -180;
    const ln2 = lonMax ? parseFloat(lonMax as string) : 180;

    const filterInBounds = (s: any) => {
      const lat = parseFloat(s.decimalLatitude);
      const lon = parseFloat(s.decimalLongitude);
      const inBounds = lat >= l1 && lat <= l2 && lon >= ln1 && lon <= ln2;
      const inTime = s.year >= start && s.year <= end;
      return inBounds && inTime && isSSRS(s);
    };

    bulkStore.red.filter(filterInBounds).forEach(s => {
      if (stats[s.year]) stats[s.year].red++;
    });
    bulkStore.grey.filter(filterInBounds).forEach(s => {
      if (stats[s.year]) stats[s.year].grey++;
    });

    const timeline = Object.entries(stats).map(([year, counts]) => ({
      year: parseInt(year),
      ...counts
    })).sort((a, b) => a.year - b.year);

    res.json(timeline);
  });

  // API Route to export data source statistics as CSV
  app.get("/api/stats-csv", async (req, res) => {
    try {
      const sourceCounts: Record<string, number> = {};
      const allSightings = [...bulkStore.red, ...bulkStore.grey];
      
      allSightings.forEach(s => {
        const source = s.dataResourceName || "Unknown Source";
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;
      });

      const sortedSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]);

      let csv = "DataSource,RecordCount\n";
      sortedSources.forEach(([source, count]) => {
        const escapedSource = source.replace(/"/g, '""');
        csv += `"${escapedSource}",${count}\n`;
      });

      // Also save to a 'downloads' folder on the server
      const downloadsDir = path.join(process.cwd(), "downloads");
      if (!existsSync(downloadsDir)) {
        await fs.mkdir(downloadsDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const serverFilePath = path.join(downloadsDir, `data_source_stats_${timestamp}.csv`);
      await fs.writeFile(serverFilePath, csv);
      console.log(`[Export] Stats saved to server at ${serverFilePath}`);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=squirrel_sources_${timestamp}.csv`);
      res.send(csv);
    } catch (error) {
      console.error("CSV Export error:", error);
      res.status(500).json({ error: "Failed to generate CSV" });
    }
  });

  // Diagnostic route to find data sources for a species in Scotland
  app.get("/api/sources-diagnostic", async (req, res) => {
    try {
      const { species } = req.query;
      const lsid = species === "grey" ? "NHMSYS0000080184" : "NHMSYS0000080188";
      const taxonId = species === "grey" ? "NBNSYS0000005107" : "NBNSYS0000005108";
      const sciName = species === "grey" ? "Sciurus carolinensis" : "Sciurus vulgaris";
      const url = `https://records-ws.nbnatlas.org/occurrences/search`;
      
      const response = await axios.get(url, {
        params: {
          q: `scientificName:"${sciName}" OR taxonConceptID:${taxonId} OR lsid:${lsid} OR dataResourceUid:dr949`,
          fq: `decimalLatitude:[54.0 TO 61.0]`,
          facets: "dataResourceName",
          pageSize: 0,
          flimit: 100
        }
      });
      
      res.json({
        totalRecords: response.data.totalRecords,
        sources: response.data.facetResults?.[0]?.fieldResult || []
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/force-refresh", async (req, res) => {
    const { species } = req.query;
    if (species === "red" || species === "grey") {
      fetchAllSightings(species as 'red' | 'grey', true);
      res.json({ message: `Sync started for ${species}` });
    } else {
      res.status(400).json({ error: "Invalid species" });
    }
  });

  // End point for sync status
  app.get("/api/sync-status", (req, res) => {
    res.json(syncStatus);
  });

  // End point to export full database as JSON
  app.get("/api/export", async (req, res) => {
    if (existsSync(DATA_FILE)) {
      res.download(DATA_FILE, "scottish_squirrel_sightings.json");
    } else {
      res.status(404).json({ error: "Data file not found. Try syncing first." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
