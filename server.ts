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
  grey: [],
  marten: []
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
  grey: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle' },
  marten: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle' }
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
      console.log(`[Persistence] Loaded ${bulkStore.red?.length || 0} red, ${bulkStore.grey?.length || 0} grey, and ${bulkStore.marten?.length || 0} marten records from file.`);
      
      // Ensure keys exist if it's an old file
      if (!bulkStore.red) bulkStore.red = [];
      if (!bulkStore.grey) bulkStore.grey = [];
      if (!bulkStore.marten) bulkStore.marten = [];
    }
  } catch (error) {
    console.error(`[Persistence] Error loading data:`, error);
  }
}

async function fetchAllSightings(species: 'red' | 'grey' | 'marten', forceReset: boolean = false) {
  if (syncStatus[species]?.isLoading && !forceReset) {
    console.log(`[Sync] Already in progress for ${species}.`);
    return;
  }
  
  syncStatus[species] = { 
    ...syncStatus[species],
    isLoading: true, 
    phase: 'Initializing',
    currentYear: 2008
  };
  
  console.log(`[Bulk Load] Starting sync for ${species} in Scotland (Year by Year)...`);
  
  const taxonFilter = species === "red" 
    ? `(scientificName:"Sciurus vulgaris" OR taxonConceptID:NBNSYS0000005108 OR lsid:NHMSYS0000080188)`
    : species === "grey"
      ? `(scientificName:"Sciurus carolinensis" OR taxonConceptID:NBNSYS0000005107 OR lsid:NHMSYS0000080184)`
      : `(scientificName:"Martes martes" OR taxonConceptID:NBNSYS0000005111 OR lsid:NHMSYS0000080190)`;
  
  const ssrsUids = ['dr382', 'dr1711', 'dr1712', 'dr1713', 'dr2140', 'dr383', 'dr659'];
  const uidFilter = `(dataResourceUid:(${ssrsUids.join(' OR ')}) OR dataResourceName:("Saving Scotland's Red Squirrels" OR "SSRS"))`;
  
  // For squirrels, we ONLY want SSRS data. For Martens, we want all occurrences.
  const query = species === 'marten' ? taxonFilter : `(${taxonFilter} AND ${uidFilter})`;
  
  const url = `https://records-ws.nbnatlas.org/occurrences/search`;
  const currentYear = new Date().getFullYear();
  
  // Use existing records as base for incremental update
  const existingRecords = bulkStore[species] || [];
  const recordMap = new Map(existingRecords.map(r => [r.id, r]));
  
  try {
    // Get accurate global total first
    const globalCheck = await axios.get(url, {
      params: {
        q: query,
        fq: [
          `decimalLatitude:[54.0 TO 62.0]`,
          `decimalLongitude:[-11.0 TO 2.0]`,
          `year:[2008 TO ${currentYear}]`
        ],
        pageSize: 0
      }
    });

    const totalExpected = globalCheck.data.totalRecords || 0;
    syncStatus[species].totalEstimated = totalExpected;
    syncStatus[species].count = recordMap.size;

    console.log(`[Sync] ${species}: Global check found ${totalExpected} records.`);

    if (forceReset) {
      recordMap.clear();
      bulkStore[species] = [];
      syncStatus[species].count = 0;
    }

    // Sync most recent years first for immediate feedback
    for (let year = currentYear; year >= 2008; year--) {
      syncStatus[species].currentYear = year;
      
      const yearCheck = await axios.get(url, {
        params: {
          q: query,
          fq: [
            `decimalLatitude:[54.0 TO 62.0]`,
            `decimalLongitude:[-11.0 TO 2.0]`,
            `year:[${year} TO ${year}]`
          ],
          pageSize: 0
        }
      });
      const yearTotal = yearCheck.data.totalRecords || 0;
      if (yearTotal === 0) {
        console.log(`[Sync] ${species} ${year}: 0 records, skipping.`);
        continue;
      }

      const months = yearTotal > 4500 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [null];

      for (const month of months) {
        syncStatus[species].phase = `Fetching ${species} records for ${year}${month ? '-' + month : ''}`;
        
        let startOffset = 0;
        const pageSize = 1000;
        let hasMoreInPeriod = true;

        const fq = [
          `decimalLatitude:[54.0 TO 62.0]`,
          `decimalLongitude:[-11.0 TO 2.0]`,
          `year:[${year} TO ${year}]`
        ];
        if (month) fq.push(`month:[${month} TO ${month}]`);

        while (hasMoreInPeriod) {
          try {
            const response = await axios.get(url, {
              params: {
                q: query,
                fq: fq,
                pageSize: pageSize,
                start: startOffset,
                fl: "id,decimalLatitude,decimalLongitude,year,scientificName,raw_commonName,occurrenceDate,dataResourceName,dataResourceUid",
              },
              timeout: 60000
            });

            const responseData = response.data;
            let records = responseData.occurrences || [];
            const totalInRequest = responseData.totalRecords || 0;
            
            if (records.length === 0) {
              hasMoreInPeriod = false;
              continue;
            }

            const rawFetchedCount = records.length;
            const scientificNameTarget = (
              species === "red" ? "Sciurus vulgaris" : 
              species === "grey" ? "Sciurus carolinensis" : 
              "Martes martes"
            ).toLowerCase();
            
            let matchedInBatch = 0;
            records.forEach((r: any) => {
              const rSciName = (r.scientificName || "").toLowerCase();
              const rCommonName = (r.raw_commonName || "").toLowerCase();
              const searchSpecies = species === 'marten' ? 'marten' : species;
              
              const matchesSpecies = rSciName.includes(scientificNameTarget) || 
                                     rCommonName.includes(searchSpecies) ||
                                     rSciName.includes("sciurus") || 
                                     (species === 'marten' && rSciName.includes("martes"));

              if (matchesSpecies && r.id) {
                recordMap.set(r.id, r);
                matchedInBatch++;
              }
            });

            console.log(`[Sync] ${species} ${year}: Fetched ${rawFetchedCount}, Matched ${matchedInBatch}. Map size: ${recordMap.size}`);
            syncStatus[species].count = recordMap.size;
            bulkStore[species] = Array.from(recordMap.values());
            
            if (rawFetchedCount < pageSize || startOffset + rawFetchedCount >= totalInRequest || startOffset + rawFetchedCount >= 5000) {
              hasMoreInPeriod = false;
            } else {
              startOffset += rawFetchedCount;
            }
          } catch (err: any) {
            console.error(`[Bulk Load] Error at ${year}${month ? '-' + month : ''}, offset ${startOffset}:`, err.message);
            hasMoreInPeriod = false; 
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
    }

    console.log(`[Bulk Load] ${species} SYNC FINISHED. total=${recordMap.size}`);
    bulkStore[species] = Array.from(recordMap.values());
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
  // If we have very few records, trigger a fresh sync
  if (bulkStore.red.length < 10000) fetchAllSightings('red');
  if (bulkStore.grey.length < 500) fetchAllSightings('grey');
  if (bulkStore.marten.length < 500) fetchAllSightings('marten');
})();

const isSSRS = (s: any) => {
  if (!s) return false;
  // Broad acceptance for Martens as per user request
  const sciName = s.scientificName?.toLowerCase() || "";
  const commonName = s.raw_commonName?.toLowerCase() || "";
  if (sciName.includes("martes") || commonName.includes("marten")) {
    return true;
  }
  const ssrsUids = ['dr382', 'dr1711', 'dr1712', 'dr1713', 'dr2140', 'dr383', 'dr659'];
  const drName = (s.dataResourceName || "").toLowerCase();
  
  // Be permissive: match if it mentions "Saving Scotland's Red Squirrel" or SSRS
  const nameMatch = drName.includes("saving scotland") && drName.includes("squirrel");
  const ssrsAcroMatch = drName.includes("ssrs");
  const uidMatch = s.dataResourceUid && ssrsUids.includes(s.dataResourceUid);
  
  return !!(nameMatch || ssrsAcroMatch || uidMatch);
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route to fetch bulk or filtered sightings
  app.get("/api/sightings", async (req, res) => {
    const { species, startYear, endYear, latMin, latMax, lonMin, lonMax, zoom, forceRefresh } = req.query;
    
    // Validate speciesKey
    const speciesInQuery = species as string;
    const speciesKey = (['red', 'grey', 'marten'].includes(speciesInQuery) ? speciesInQuery : 'red') as 'red' | 'grey' | 'marten';

  // Start background sync for species immediately if needed
  const targetSpecies = Array.isArray(species) ? species : [species];
  targetSpecies.forEach(async (s) => {
    const sKey = s as 'red' | 'grey' | 'marten';
    if (['red', 'grey', 'marten'].includes(sKey) && (!bulkStore[sKey] || bulkStore[sKey].length === 0 || forceRefresh === 'true')) {
      fetchAllSightings(sKey, forceRefresh === 'true'); 
    }
  });

  // Proceed with filtering current data
  const responseSpecies = Array.isArray(species) ? species : [species];
  const resultsBySpecies = await Promise.all(responseSpecies.map(async (s) => {
    const sKey = (['red', 'grey', 'marten'].includes(s as string) ? s : 'red') as 'red' | 'grey' | 'marten';
    let results = (bulkStore[sKey] || []).filter(isSSRS);

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
    return results;
  }));

  let results = resultsBySpecies.flat();
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
      isSyncing: syncStatus[speciesKey]?.isLoading || false
    });
  });

  app.get("/api/population-stats", async (req, res) => {
    const { latMin, latMax, lonMin, lonMax, startYear, endYear } = req.query;
    
    const start = parseInt(startYear as string) || 2008;
    const end = parseInt(endYear as string) || new Date().getFullYear();
    
    const stats: Record<number, { red: number; grey: number; marten: number }> = {};
    for (let y = start; y <= end; y++) {
      stats[y] = { red: 0, grey: 0, marten: 0 };
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
    bulkStore.marten.filter(filterInBounds).forEach(s => {
      if (stats[s.year]) stats[s.year].marten++;
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
      const allSightings = [...bulkStore.red, ...bulkStore.grey, ...bulkStore.marten];
      
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
    if (species === "red" || species === "grey" || species === "marten") {
      fetchAllSightings(species as 'red' | 'grey' | 'marten', true);
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
