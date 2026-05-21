import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import NodeCache from "node-cache";
import fs from "fs/promises";
import { existsSync } from "fs";
import { SQUIRREL_GROUPS } from "./src/groups_data";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isPointInPolygon(lat: number, lon: number, polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Initialize cache with 24 hour TTL
const sightingsCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

let DATA_DIR = path.join(process.cwd(), "data");
if (existsSync(path.join(__dirname, "data"))) {
  DATA_DIR = path.join(__dirname, "data");
} else if (existsSync(path.join(__dirname, "../data"))) {
  DATA_DIR = path.join(__dirname, "../data");
}

const DATA_FILE = path.join(DATA_DIR, "squirrel_sightings.json");
const PROGRESS_FILE = path.join(DATA_DIR, "sync_progress_v2.json");

// In-memory store for bulk sightings (now loaded dynamically on-demand)
let bulkStore: Record<string, any[]> = {
  red: [],
  grey: [],
  marten: [],
  grey_trapping: []
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
  marten: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle' },
  grey_trapping: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle' }
};

let syncProgressStore: Record<string, {
  completedYears: number[],
  isComplete: boolean,
  count?: number,
  lastSync?: string
}> = {
  red: { completedYears: [], isComplete: false },
  grey: { completedYears: [], isComplete: false },
  marten: { completedYears: [], isComplete: false },
  grey_trapping: { completedYears: [], isComplete: false }
};

function getSpeciesFilePath(species: string) {
  if (species === 'red') return path.join(DATA_DIR, 'red.json');
  if (species === 'grey') return path.join(DATA_DIR, 'grey.json');
  if (species === 'marten') return path.join(DATA_DIR, 'marten.json');
  if (species === 'grey_trapping') return path.join(DATA_DIR, 'grey_trapping.json');
  return path.join(DATA_DIR, `${species}.json`);
}

function getSpeciesYearFilePath(species: string, year: number) {
  return path.join(DATA_DIR, `${species}_${year}.json`);
}

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

async function saveProgressToFile() {
  try {
    await ensureDataDir();
    await fs.writeFile(PROGRESS_FILE, JSON.stringify(syncProgressStore, null, 2));
    console.log(`[Persistence] Sync progress saved to ${PROGRESS_FILE}`);
  } catch (error) {
    console.error(`[Persistence] Error saving progress:`, error);
  }
}

async function loadProgressFromFile() {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const data = await fs.readFile(PROGRESS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
          const sKey = species as 'red' | 'grey' | 'marten' | 'grey_trapping';
          if (parsed[sKey]) {
            syncProgressStore[sKey] = {
              completedYears: Array.isArray(parsed[sKey].completedYears) ? parsed[sKey].completedYears : [],
              isComplete: !!parsed[sKey].isComplete,
              count: typeof parsed[sKey].count === 'number' ? parsed[sKey].count : 0,
              lastSync: parsed[sKey].lastSync
            };
          }
        });
      }
    }
    console.log(`[Persistence] Loaded sync progress from disk. Completed years count: red=${syncProgressStore.red.completedYears.length}, grey=${syncProgressStore.grey.completedYears.length}, marten=${syncProgressStore.marten.completedYears.length}, grey_trapping=${syncProgressStore.grey_trapping.completedYears.length}`);
  } catch (err) {
    console.error("[Persistence] Error loading progress file:", err);
  }
}

async function saveSpeciesYearToFile(species: 'red' | 'grey' | 'marten' | 'grey_trapping', year: number, records: any[]) {
  try {
    await ensureDataDir();
    const filePath = getSpeciesYearFilePath(species, year);
    const tsNow = new Date().toISOString();
    const wrapper = {
      downloadedAt: tsNow,
      year: year,
      records: records
    };
    await fs.writeFile(filePath, JSON.stringify(wrapper, null, 2));
    console.log(`[Persistence] Saved ${records.length} records to ${filePath}`);
  } catch (error) {
    console.error(`[Persistence] Error saving ${species} for year ${year}:`, error);
  }
}

async function saveSpeciesToFile(species: 'red' | 'grey' | 'marten' | 'grey_trapping') {
  try {
    await ensureDataDir();
    const dataToSave = bulkStore[species] || [];
    
    // Split the dataToSave by year and write separate files for each year
    const recordsByYear: Record<number, any[]> = {};
    for (const r of dataToSave) {
      if (!r) continue;
      const y = parseInt(r.year) || 2000;
      if (!recordsByYear[y]) recordsByYear[y] = [];
      recordsByYear[y].push(r);
    }

    const currentYear = new Date().getFullYear();
    // Save each year that has records, or if it's the current year
    for (let year = 2000; year <= currentYear; year++) {
      const yearRecords = recordsByYear[year] || [];
      if (yearRecords.length > 0 || year === currentYear || existsSync(getSpeciesYearFilePath(species, year))) {
        await saveSpeciesYearToFile(species, year, yearRecords);
      }
    }

    const tsNow = syncStatus[species]?.lastSync || new Date().toISOString();
    
    // Save count to progress store to stay aligned
    syncProgressStore[species].count = dataToSave.length;
    syncProgressStore[species].lastSync = tsNow;
    await saveProgressToFile();
  } catch (error) {
    console.error(`[Persistence] Error saving ${species} data:`, error);
  }
}

async function saveDataToFile(species?: 'red' | 'grey' | 'marten' | 'grey_trapping') {
  if (species) {
    await saveSpeciesToFile(species);
  } else {
    await saveSpeciesToFile('red');
    await saveSpeciesToFile('grey');
    await saveSpeciesToFile('marten');
    await saveSpeciesToFile('grey_trapping');
  }
}

async function ensureSpeciesLoaded(species: 'red' | 'grey' | 'marten' | 'grey_trapping') {
  if (bulkStore[species] && bulkStore[species].length > 0) {
    return; // Already loaded in memory cache
  }
  
  await ensureDataDir();
  const currentYear = new Date().getFullYear();
  let allRecords: any[] = [];
  let foundAnyYearFiles = false;

  for (let year = 2000; year <= currentYear; year++) {
    const yearFilePath = getSpeciesYearFilePath(species, year);
    if (existsSync(yearFilePath)) {
      try {
        const data = await fs.readFile(yearFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
          allRecords = allRecords.concat(parsed.records);
          foundAnyYearFiles = true;
          if (parsed.downloadedAt) {
            if (!syncStatus[species].lastSync || parsed.downloadedAt > syncStatus[species].lastSync) {
              syncStatus[species].lastSync = parsed.downloadedAt;
            }
          }
        }
      } catch (err) {
        console.error(`[Persistence] Error reading separate year file ${yearFilePath}:`, err);
      }
    }
  }

  if (foundAnyYearFiles) {
    // Unique list to make absolutely sure no duplicates are loaded
    const uniqueMap = new Map();
    allRecords.forEach(r => {
      const rid = r.uuid || r.id;
      if (rid) uniqueMap.set(rid, r);
    });
    const dedupedRecords = Array.from(uniqueMap.values());
    bulkStore[species] = dedupedRecords;
    syncStatus[species].count = dedupedRecords.length;
    console.log(`[Persistence] Loaded ${dedupedRecords.length} records for ${species} from separate year files.`);
    return;
  }

  // Fallback to legacy master file /data/species.json, or base backup squirrel_sightings.json
  const filePath = getSpeciesFilePath(species);
  try {
    let records: any[] = [];
    if (existsSync(filePath)) {
      console.log(`[Persistence] Loading ${species} on-demand from master file ${filePath} with on-demand migration...`);
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        records = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
        records = parsed.records;
        if (parsed.downloadedAt) {
          syncStatus[species].lastSync = parsed.downloadedAt;
        }
      }
    } else if (existsSync(DATA_FILE) || existsSync(path.join(process.cwd(), "squirrel_sightings.json"))) {
      const activeDataFile = existsSync(DATA_FILE) ? DATA_FILE : path.join(process.cwd(), "squirrel_sightings.json");
      console.log(`[Persistence] Split and legacy files not found. Bootstrapping species ${species} from ${activeDataFile}...`);
      const data = await fs.readFile(activeDataFile, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        const tsNow = new Date().toISOString();
        if (species === 'grey_trapping') {
          let rawGreyList = Array.isArray(parsed.grey) ? parsed.grey : [];
          rawGreyList.forEach(isSSRS);
          records = rawGreyList.filter(r => r.isTrapping);
        } else {
          let rawList = Array.isArray(parsed[species]) ? parsed[species] : [];
          rawList.forEach(isSSRS);
          records = rawList;
          if (species === 'grey') {
            records = rawList.filter(r => !r.isTrapping);
          }
        }
        syncStatus[species].lastSync = tsNow;
      }
    }

    if (records.length > 0) {
      // Migrate loaded records to separate year files immediately!
      console.log(`[Persistence] Migrating ${records.length} bootstrapped records of ${species} to separate year files...`);
      const recordsByYear: Record<number, any[]> = {};
      for (const r of records) {
        const y = parseInt(r.year) || 2000;
        if (!recordsByYear[y]) recordsByYear[y] = [];
        recordsByYear[y].push(r);
      }
      for (const [yearStr, yearRecords] of Object.entries(recordsByYear)) {
        const y = parseInt(yearStr);
        await saveSpeciesYearToFile(species, y, yearRecords);
      }
      bulkStore[species] = records;
      syncStatus[species].count = records.length;
      await saveProgressToFile();
    }
  } catch (error) {
    console.error(`[Persistence] Error bootstrapping ${species} on-demand:`, error);
  }
}

async function loadDataFromFile() {
  try {
    // We do NOT load massive data files on startup to optimize startup speed and heap size. Load them on-demand!
    ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
      const sKey = species as 'red' | 'grey' | 'marten' | 'grey_trapping';
      
      // Bootstrap counts and metadata from our lightweight progress file
      syncStatus[sKey].count = syncProgressStore[sKey]?.count || 0;
      if (syncProgressStore[sKey]?.lastSync) {
        syncStatus[sKey].lastSync = syncProgressStore[sKey].lastSync;
      }
    });

    console.log(`[Persistence] On-demand file loader initialized. Synced counts: red=${syncStatus.red.count}, grey=${syncStatus.grey.count}, marten=${syncStatus.marten.count}, grey_trapping=${syncStatus.grey_trapping.count}`);
  } catch (error) {
    console.error(`[Persistence] Error initializing data counts:`, error);
  }
}

async function fetchAllSightings(species: 'red' | 'grey' | 'marten' | 'grey_trapping', forceReset: boolean = false) {
  if (syncStatus[species]?.isLoading && !forceReset) {
    console.log(`[Sync] Already in progress for ${species}.`);
    return;
  }
  
  await ensureSpeciesLoaded(species);
  
  syncStatus[species] = { 
    ...syncStatus[species],
    isLoading: true, 
    phase: 'Initializing',
    currentYear: 2008
  };
  
  console.log(`[Bulk Load] Starting sync for ${species} in Scotland (Year by Year)...`);
  
  const taxonFilter = species === "red" 
    ? `taxa:"Sciurus vulgaris"`
    : (species === "grey" || species === "grey_trapping")
      ? `(taxa:"Sciurus carolinensis" OR dataResourceUid:dr637 OR dataResourceUid:dr1595 OR dataResourceUid:dr1596 OR dataResourceUid:dr1597 OR dataResourceUid:dr1598 OR dataResourceUid:dr1593 OR dataResourceName:*Squirrel*)`
      : `taxa:"Martes martes"`;

  const query = taxonFilter;

  const url = `https://records-ws.nbnatlas.org/occurrences/search`;
  const currentYear = new Date().getFullYear();

  // Use existing records as base for incremental update
  const existingRecords = bulkStore[species] || [];
  const recordMap = new Map(existingRecords.filter(r => r && (r.id || r.uuid)).map(r => [r.id || r.uuid, r]));

  try {
    // Large geographic box covering Scotland
    const geoFq = `decimalLatitude:[54.0 TO 62.0] AND decimalLongitude:[-11.0 TO 2.0]`;
    // Include both present and absent records for trapping effort
    const statusFq = (species === "grey" || species === "grey_trapping") ? `(occurrenceStatus:present OR occurrenceStatus:absent)` : `occurrenceStatus:present`;

    const globalCheck = await axios.get(url, {
      params: {
        q: query,
        fq: `${geoFq} AND ${statusFq} AND year:[2000 TO ${currentYear}]`,
        pageSize: 0
      },
      timeout: 30000
    });

    console.log(`[Sync] ${species}: Global check URL: ${url}?q=${encodeURIComponent(query)}&fq=${encodeURIComponent(geoFq)}`);
    const totalExpected = globalCheck.data.totalRecords || 0;
    syncStatus[species].totalEstimated = totalExpected;
    syncStatus[species].count = recordMap.size;

    console.log(`[Sync] ${species}: Found ${totalExpected} records in total search.`);

    if (forceReset) {
      if (syncProgressStore[species]?.isComplete) {
        // It was fully complete previously. This is a brand new request to fully refresh.
        console.log(`[Sync] ${species} was fully complete previously. Wiping and starting fresh.`);
        syncProgressStore[species].completedYears = [];
        syncProgressStore[species].isComplete = false;
        await saveProgressToFile();
        
        recordMap.clear();
        bulkStore[species] = [];
        syncStatus[species].count = 0;
      } else {
        // Resume incomplete/stalled download! Keep years already marked as completed.
        const completedYears = syncProgressStore[species]?.completedYears || [];
        if (completedYears.length === 0) {
          recordMap.clear();
          bulkStore[species] = [];
          syncStatus[species].count = 0;
        } else {
          const completedYearsSet = new Set(completedYears.map(Number));
          const filteredRecords = existingRecords.filter(r => r && completedYearsSet.has(Number(r.year)));
          recordMap.clear();
          filteredRecords.forEach((r: any) => {
            const recordId = r.uuid || r.id;
            if (recordId) recordMap.set(recordId, r);
          });
          bulkStore[species] = filteredRecords;
          syncStatus[species].count = recordMap.size;
          console.log(`[Sync] Resuming incomplete ${species} sync with ${completedYears.length} completed years. Retained ${recordMap.size} records.`);
        }
      }
    }

    // Sync from year 2000 to current
    for (let year = currentYear; year >= 2000; year--) {
      // If we are NOT on the current year, and a file for this year already exists in the data directory, we ignore/skip it!
      if (year < currentYear) {
        const yearFilePath = getSpeciesYearFilePath(species, year);
        if (existsSync(yearFilePath)) {
          console.log(`[Sync] ${species} ${year} already exists in data folder as split JSON. Skipping download.`);
          if (!syncProgressStore[species].completedYears) {
            syncProgressStore[species].completedYears = [];
          }
          if (!syncProgressStore[species].completedYears.includes(year)) {
            syncProgressStore[species].completedYears.push(year);
          }
          continue;
        }
      }

      // If it's the current year, we always fetch it in full. Clear existing records for currentYear from recordMap first to avoid duplicates.
      if (year === currentYear) {
        for (const [key, val] of recordMap.entries()) {
          if (val && Number(val.year) === currentYear) {
            recordMap.delete(key);
          }
        }
      }
      
      syncStatus[species].currentYear = year;
      let yearHasError = false;
      let yearTotal = 0;
      
      try {
        const yearCheck = await axios.get(url, {
          params: {
            q: query,
            fq: `${geoFq} AND ${statusFq} AND year:${year}`,
            pageSize: 0
          },
          timeout: 20000
        });
        yearTotal = yearCheck.data.totalRecords || 0;
        console.log(`[Sync] ${species} ${year}: ${yearTotal} records`);
      } catch (err: any) {
        console.error(`[Sync] Error during year check for ${species} ${year}:`, err.message);
        yearHasError = true;
      }
      
      if (yearTotal > 0 && !yearHasError) {
        // If more than 4000 records in a year, fetch month by month to stay under NBN's 10k limit per export
        const months = yearTotal > 4000 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [null];
 
        for (const month of months) {
          if (yearHasError) break;
          syncStatus[species].phase = `Downloading ${year}${month ? '-' + month : ''}`;
          
          let startOffset = 0;
          const pageSize = 1000;
          let hasMoreInPeriod = true;
 
          const periodFq = `${geoFq} AND ${statusFq} AND year:${year}${month ? ' AND month:' + month : ''}`;
 
          while (hasMoreInPeriod) {
            try {
              const response = await axios.get(url, {
                params: {
                  q: query,
                  fq: periodFq,
                  pageSize: pageSize,
                  start: startOffset,
                  fl: "id,uuid,decimalLatitude,decimalLongitude,year,scientificName,raw_commonName,vernacularName,occurrenceDate,eventDate,dataResourceName,dataResourceUid,collectionCode,raw_collectionCode,coordinateUncertaintyInMeters,gridReference,institutionCode,raw_institutionCode,individualCount,occurrenceRemarks,raw_occurrenceRemarks,occurrenceStatus,raw_occurrenceStatus,occurrenceID",
                },
                timeout: 30000
              });
 
              const responseData = response.data;
              let records = responseData.occurrences || [];
              const totalInRequest = responseData.totalRecords || 0;
              
              if (records.length === 0) {
                 hasMoreInPeriod = false;
                 continue;
              }
 
              const rawFetchedCount = records.length;
              records.forEach((r: any) => {
                const recordId = r.uuid || r.id;
                if (recordId) {
                  isSSRS(r); // Tag it
                  
                  // Filter based on species requested and trapping status
                  if (species === 'grey' && r.isTrapping) return;
                  if (species === 'grey_trapping' && !r.isTrapping) return;
 
                  recordMap.set(recordId, r);
                  r.id = recordId;
                }
              });
 
              syncStatus[species].count = recordMap.size;
              // Immediate update to store for visibility
              bulkStore[species] = Array.from(recordMap.values());
              
              if (rawFetchedCount < pageSize || startOffset + rawFetchedCount >= totalInRequest || startOffset + rawFetchedCount >= 10000) {
                hasMoreInPeriod = false;
              } else {
                startOffset += rawFetchedCount;
              }
            } catch (err: any) {
              console.error(`[Sync] Error at ${year}${month ? '-' + month : ''}, offset ${startOffset}:`, err.message);
              yearHasError = true;
              hasMoreInPeriod = false; 
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      }
 
      if (!yearHasError) {
        if (!syncProgressStore[species].completedYears) {
          syncProgressStore[species].completedYears = [];
        }
        if (!syncProgressStore[species].completedYears.includes(year)) {
          syncProgressStore[species].completedYears.push(year);
        }
        await saveProgressToFile();
        
        // Save ONLY the records of this year to its corresponding year file!
        const yearRecords = Array.from(recordMap.values()).filter((r: any) => r && Number(r.year) === year);
        
        // Inform user on UI about saving this year's file
        const savedFilename = `${species}_${year}.json`;
        syncStatus[species].phase = `Saving ${savedFilename}`;
        await new Promise(r => setTimeout(r, 600)); // Brief sleep so the UI registers this event
        
        await saveSpeciesYearToFile(species, year, yearRecords);
        
        // Maintain local bulk store alignment
        bulkStore[species] = Array.from(recordMap.values());
        syncStatus[species].count = recordMap.size;
        syncStatus[species].lastSync = new Date().toISOString();
      } else {
        console.warn(`[Sync] ${species} ${year} had fetch errors, not marking as complete.`);
      }
    }
 
    console.log(`[Bulk Load] ${species} SYNC FINISHED. total=${recordMap.size}`);
    bulkStore[species] = Array.from(recordMap.values());
    syncStatus[species].phase = 'Saving final state';
    syncStatus[species].lastSync = new Date().toISOString();
    
    // Set isComplete to true and save progress!
    syncProgressStore[species].isComplete = true;
    syncProgressStore[species].lastSync = syncStatus[species].lastSync;
    await saveProgressToFile();
 
    await saveDataToFile(species);
    syncStatus[species].phase = 'Complete';
  } catch (error) {
    console.error(`[Bulk Load] Fatal error syncing ${species}:`, error);
    syncStatus[species].phase = 'Error';
  } finally {
    syncStatus[species].isLoading = false;
  }
}

// Start initial background sync and load from file - moved inside startServer
// (async () => { ... })();

function getActualSpecies(s: any): "red" | "grey" | "marten" | "other" {
  if (!s) return "other";
  const sciName = String(s.scientificName || s.species || "").toLowerCase();
  const commonName = String(s.raw_commonName || s.vernacularName || "").toLowerCase();
  
  if (sciName.includes("vulgaris") || commonName.includes("red squirrel")) {
    return "red";
  }
  if (
    sciName.includes("carolinensis") || 
    commonName.includes("grey squirrel") || 
    commonName.includes("gray squirrel")
  ) {
    return "grey";
  }
  if (sciName.includes("martes") || commonName.includes("marten")) {
    return "marten";
  }
  return "other";
}

function isSSRS(s: any): boolean {
  try {
    if (!s) return false;
    
    // Standardize property names in-place to handle Solr raw/prefixed/timestamp names
    s.id = s.uuid || s.id;
    s.occurrenceID = s.occurrenceID || s.raw_occurrenceId || '';
    s.collectionCode = s.collectionCode || s.raw_collectionCode || '';
    s.institutionCode = s.institutionCode || s.raw_institutionCode || '';
    s.raw_commonName = s.raw_commonName || s.vernacularName || '';
    s.occurrenceRemarks = s.occurrenceRemarks || s.raw_occurrenceRemarks || '';
    s.occurrenceStatus = s.occurrenceStatus || s.raw_occurrenceStatus || 'present';

    if (s.eventDate && !s.occurrenceDate) {
      try {
        s.occurrenceDate = new Date(s.eventDate).toISOString();
      } catch (e) {
        // ignore parsing errors for malformed timestamps
      }
    }
    
    const rawName = String(s.raw_commonName || s.vernacularName || s.scientificName || s.species || '').toLowerCase();
    const resourceName = String(s.dataResourceName || '').toLowerCase();
    const remarks = String(s.occurrenceRemarks || s.raw_occurrenceRemarks || '').toLowerCase();
    const institution = String(s.institutionCode || s.raw_institutionCode || '').toLowerCase();
    const resUid = String(s.dataResourceUid || '');
    const collectionCodeVal = String(s.collectionCode || s.raw_collectionCode || '').toUpperCase();
    
    // Official Trapping/Control Datasets (including dr949 - The Scottish Squirrel Database)
    const isTrappingDataset = 
      resUid === "dr949" ||   // The Scottish Squirrel Database (actual NBN ID containing SWT records)
      resUid === "dr637" ||   // SSRS Standardised Survey
      resUid === "dr1595" ||  // SSRS GSSRS Private
      resUid === "dr1596" ||  // SSRS GSSRS Staff/Vol
      resUid === "dr1597" ||  // SSRS Effort Vol
      resUid === "dr1598" ||  // SSRS Effort Staff
      resUid === "dr1593" ||  // SSRS Generalised
      resUid === "dr171" ||   // SSRS Sightings (sometimes includes GSSRS)
      resUid === "dr1089" ||  // Older/Alternative list ID
      resUid === "dr1738" ||  // FLS Red and Grey records
      resUid === "dr649" ||   // Borders
      resUid === "dr723" ||   // Angus
      resUid === "dr703" ||   // Grampian
      resUid === "dr361";     // Tayside
      
    // Tag records as trapping if they match SSRS criteria or explicitly mention control/trapping
    const isSSRSProject = 
      collectionCodeVal.includes("SSRS") || 
      collectionCodeVal.includes("GSSRS") || 
      resourceName.includes("gssrs") ||
      resourceName.includes("saving scotland's red squirrels") ||
      resourceName.includes("ssrs") ||
      resourceName.includes("borders red squirrel") ||
      resourceName.includes("saving scotlands red squirrels") ||
      resourceName.includes("the scottish squirrel database");

    const combinedText = `${rawName} ${remarks} ${resourceName} ${institution}`;

    const hasTrappingKeywords = 
      combinedText.includes('trap') || 
      combinedText.includes('control') || 
      combinedText.includes('effort') ||
      combinedText.includes('catch') ||
      combinedText.includes('dispatch') ||
      combinedText.includes('despatch') ||
      combinedText.includes('cull') ||
      combinedText.includes('removal') ||
      combinedText.includes('shoot') ||
      combinedText.includes('shot') ||
      combinedText.includes('kill') ||
      combinedText.includes('euthaniz') ||
      combinedText.includes('euthanis') ||
      combinedText.includes('eradication') ||
      combinedText.includes('rifle') ||
      combinedText.includes('shooting') ||
      combinedText.includes('managed') ||
      combinedText.includes('humane') ||
      combinedText.includes('station') ||
      combinedText.includes('box') ||
      combinedText.includes('tunnel') ||
      institution.includes('forestry') ||
      institution.includes('fls');

    const actualSpecies = getActualSpecies(s);
    const isGrid10km = Number(s.coordinateUncertaintyInMeters) === 7071.1 || (typeof s.gridReference === 'string' && s.gridReference.length === 4);
    const isAbsent = String(s.occurrenceStatus).toLowerCase() === 'absent';
    
    if (actualSpecies === 'grey' && (isSSRSProject || isTrappingDataset || isGrid10km || hasTrappingKeywords || isAbsent)) {
      s.isTrapping = true;
    } else {
      s.isTrapping = false;
    }
  } catch (err) {
    if (s && typeof s === 'object') {
      s.isTrapping = false;
    }
  }
  return true;
}

// Sequential Serialization Queue to prevent race conditions & write corruption
let syncQueue: { species: 'red' | 'grey' | 'marten' | 'grey_trapping'; forceReset: boolean }[] = [];
let isProcessingQueue = false;

async function processSyncQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  
  while (syncQueue.length > 0) {
    const task = syncQueue.shift();
    if (task) {
      try {
        console.log(`[Queue] Starting queued sync for ${task.species} (forceReset: ${task.forceReset})`);
        await fetchAllSightings(task.species, task.forceReset);
      } catch (err: any) {
        console.error(`[Queue] Error syncing ${task.species}:`, err.message);
      }
    }
  }
  isProcessingQueue = false;
}

function enqueueSync(species: 'red' | 'grey' | 'marten' | 'grey_trapping', forceReset: boolean = false) {
  const alreadyInQueue = syncQueue.some(t => t.species === species);
  const isCurrentlySyncing = syncStatus[species]?.isLoading;
  
  if (!alreadyInQueue && !isCurrentlySyncing) {
    syncQueue.push({ species, forceReset });
    console.log(`[Queue] Enqueued ${species} sync. Queue size: ${syncQueue.length}`);
  }
  processSyncQueue();
}

async function startServer() {
  try {
    const app = express();
    const PORT = 3000;

    // Load initial data
    await loadProgressFromFile();
    await loadDataFromFile();

    console.log(`[Server] Starting in ${process.env.NODE_ENV || 'development'} mode`);

    app.use(express.json({ limit: "200mb" }));
    app.use(express.urlencoded({ limit: "200mb", extended: true }));

  // Log all API requests
  app.use("/api", (req, res, next) => {
    console.log(`[API Request] ${req.method} ${req.url}`);
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      counts: {
        red: syncStatus.red.count || bulkStore.red.length,
        grey: syncStatus.grey.count || bulkStore.grey.length,
        marten: syncStatus.marten.count || bulkStore.marten.length,
        grey_trapping: syncStatus.grey_trapping.count || bulkStore.grey_trapping.length
      },
      syncStatus
    });
  });

  // Database analysis report of datasets and references
  app.get("/api/db-report", async (req, res) => {
    await ensureSpeciesLoaded('red');
    await ensureSpeciesLoaded('grey');
    await ensureSpeciesLoaded('marten');
    await ensureSpeciesLoaded('grey_trapping');

    const report: Record<string, {
      species: string;
      resourceUid: string;
      resourceName: string;
      count: number;
      trappingCount: number;
    }> = {};

    ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
      const records = bulkStore[species] || [];
      records.forEach(r => {
        const uid = r.dataResourceUid || r.data_resource_uid || 'unknown_uid';
        const name = r.dataResourceName || 'Unknown Resource';
        const key = `${species}_${uid}`;
        if (!report[key]) {
          report[key] = {
            species,
            resourceUid: uid,
            resourceName: name,
            count: 0,
            trappingCount: 0
          };
        }
        report[key].count++;
        if (r.isTrapping) {
          report[key].trappingCount++;
        }
      });
    });

    res.json(Object.values(report).sort((a,b) => b.count - a.count));
  });

  // API Route to fetch bulk or filtered sightings
  app.get("/api/sightings", async (req, res, next) => {
    try {
      const { species, startYear, endYear, latMin, latMax, lonMin, lonMax, zoom, forceRefresh, groupName } = req.query;
      
      const responseSpecies = Array.isArray(species) ? species : (species ? [species] : ['red']);
      
      // Start background sync for species immediately if needed
      responseSpecies.forEach((s) => {
        const sQuery = s as string;
        const sKey = (sQuery === 'grey_effort' ? 'grey_trapping' : sQuery) as 'red' | 'grey' | 'marten' | 'grey_trapping';
        
        if (['red', 'grey', 'marten', 'grey_trapping'].includes(sKey)) {
          const count = syncStatus[sKey]?.count || 0;
          if (count < 10 || forceRefresh === 'true') {
            enqueueSync(sKey, forceRefresh === 'true'); 
          }
        }
      });

      const group = groupName ? SQUIRREL_GROUPS.find(g => g.name === groupName) : null;

      // Proceed with filtering current data
      const resultsBySpecies = await Promise.all(responseSpecies.map(async (s) => {
        const sQuery = s as string;
        const sKey = (sQuery === 'grey_effort' ? 'grey_trapping' : sQuery) as 'red' | 'grey' | 'marten' | 'grey_trapping';
        
        await ensureSpeciesLoaded(sKey);
        let results = bulkStore[sKey] || [];

        if (sQuery === 'grey_effort') {
          const grouped: Record<string, any> = {};
          results.forEach(r => {
            const key = `${r.decimalLatitude},${r.decimalLongitude}`;
            const count = parseInt(r.individualCount) || 1;
            if (!grouped[key]) {
              grouped[key] = { ...r, recordCount: count };
            } else {
              grouped[key].recordCount += count;
              if (r.year > (grouped[key].year || 0)) {
                grouped[key].year = r.year;
                grouped[key].occurrenceDate = r.occurrenceDate;
              }
            }
          });
          results = Object.values(grouped);
          console.log(`[Diagnostic] Grouped grey_effort: ${results.length} locations found.`);
        }

        // 1. Time Filter
        if (startYear || endYear) {
          const start = parseInt(startYear as string) || 2008;
          const end = parseInt(endYear as string) || new Date().getFullYear();
          results = results.filter(s => s.year >= start && s.year <= end);
        }

        // 2. Bounds or Group Filter
        if (group) {
          results = results.filter(s => {
            const lat = parseFloat(s.decimalLatitude);
            const lon = parseFloat(s.decimalLongitude);
            return isPointInPolygon(lat, lon, group.polygon as [number, number][]);
          });
        } else if (latMin && latMax && lonMin && lonMax) {
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
        return results.map(r => ({ ...r, speciesType: sQuery }));
      }));

      let results = resultsBySpecies.flat();
      const totalCountIncluded = results.length;
      const currentZoom = parseInt(zoom as string) || 10;
      
      // 3. Thinning Logic
      // If zoomed in (e.g. village level) or if few records, don't thin
      const shouldThin = totalCountIncluded > 10000 && currentZoom < 13;
      const isThinned = shouldThin;
      
      if (shouldThin) {
        const MAX_POINTS = 10000;
        // Grid-based spatial sampling
        let minLat = latMin ? parseFloat(latMin as string) : 54.5;
        let maxLat = latMax ? parseFloat(latMax as string) : 61.0;
        let minLon = lonMin ? parseFloat(lonMin as string) : -8.5;
        let maxLon = lonMax ? parseFloat(lonMax as string) : -0.5;

        if (group) {
          const lats = group.polygon.map(p => p[0]);
          const lons = group.polygon.map(p => p[1]);
          minLat = Math.min(...lats);
          maxLat = Math.max(...lats);
          minLon = Math.min(...lons);
          maxLon = Math.max(...lons);
        }
        
        const gridSize = 60; 
        const grid: Record<string, any[]> = {};
        
        for (const sighting of results) {
          const lat = parseFloat(sighting.decimalLatitude);
          const lon = parseFloat(sighting.decimalLongitude);
          const x = Math.floor(((lat - minLat) / (maxLat - minLat + 0.0001)) * gridSize);
          const y = Math.floor(((lon - minLon) / (maxLon - minLon + 0.0001)) * gridSize);
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

      const anySyncing = responseSpecies.some(s => {
        const sQuery = s as string;
        const sKey = (sQuery === 'grey_effort' ? 'grey_trapping' : sQuery) as 'red' | 'grey' | 'marten' | 'grey_trapping';
        return sKey && syncStatus[sKey]?.isLoading;
      });

      res.json({
        occurrences: results,
        total: totalCountIncluded,
        thinned: isThinned,
        isSyncing: anySyncing
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/population-stats", async (req, res, next) => {
    try {
      const { latMin, latMax, lonMin, lonMax, startYear, endYear, groupName } = req.query;
      
      await ensureSpeciesLoaded('red');
      await ensureSpeciesLoaded('grey');
      await ensureSpeciesLoaded('marten');
      await ensureSpeciesLoaded('grey_trapping');

      const currentYear = new Date().getFullYear();
      let start = parseInt(startYear as string) || 2008;
      let end = parseInt(endYear as string) || currentYear;
      
      if (isNaN(start) || start < 1900) start = 2008;
      if (isNaN(end) || end > currentYear + 2) end = currentYear;
      if (end < start) {
        const temp = start;
        start = end;
        end = temp;
      }
      
      const stats: Record<number, { red: number; grey: number; grey_effort: number; marten: number }> = {};
      for (let y = start; y <= end; y++) {
        stats[y] = { red: 0, grey: 0, grey_effort: 0, marten: 0 };
      }

      const l1 = latMin ? parseFloat(latMin as string) : -90;
      const l2 = latMax ? parseFloat(latMax as string) : 90;
      const ln1 = lonMin ? parseFloat(lonMin as string) : -180;
      const ln2 = lonMax ? parseFloat(lonMax as string) : 180;

      const group = groupName ? SQUIRREL_GROUPS.find(g => g.name === groupName) : null;

      const filterInBounds = (s: any) => {
        const lat = parseFloat(s.decimalLatitude);
        const lon = parseFloat(s.decimalLongitude);
        const inTime = s.year >= start && s.year <= end;
        
        if (!(inTime && isSSRS(s))) return false;
        
        if (group) {
          return isPointInPolygon(lat, lon, group.polygon as [number, number][]);
        }
        
        const inBounds = lat >= l1 && lat <= l2 && lon >= ln1 && ln2 >= lon;
        return inBounds;
      };

      bulkStore.red.filter(filterInBounds).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'red' && stats[s.year]) stats[s.year].red++;
      });
      bulkStore.grey.filter(filterInBounds).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'grey' && stats[s.year]) {
          stats[s.year].grey++;
        }
      });
      bulkStore.grey_trapping.filter(filterInBounds).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'grey' && stats[s.year]) {
          stats[s.year].grey_effort++;
        }
      });
      bulkStore.marten.filter(filterInBounds).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'marten' && stats[s.year]) stats[s.year].marten++;
      });

      const timeline = Object.entries(stats).map(([year, counts]) => ({
        year: parseInt(year),
        ...counts
      })).sort((a, b) => a.year - b.year);

      res.json(timeline);
    } catch (err) {
      next(err);
    }
  });

  // API Route to export data source statistics as CSV
  app.get("/api/stats-csv", async (req, res) => {
    try {
      await ensureSpeciesLoaded('red');
      await ensureSpeciesLoaded('grey');
      await ensureSpeciesLoaded('marten');
      await ensureSpeciesLoaded('grey_trapping');

      const sourceCounts: Record<string, number> = {};
      const allSightings = [
        ...(bulkStore.red || []),
        ...(bulkStore.grey || []),
        ...(bulkStore.marten || []),
        ...(bulkStore.grey_trapping || [])
      ];
      
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
      const taxonId = species === "grey" ? "NBNSYS0000005107" : species === "marten" ? "NBNSYS0000005111" : "NBNSYS0000005108";
      const url = `https://records-ws.nbnatlas.org/occurrences/search`;
      
      const response = await axios.get(url, {
        params: {
          q: `taxonConceptID:${taxonId}`,
          fq: `decimalLatitude:[54.0 TO 62.0] AND decimalLongitude:[-11.0 TO 2.0]`,
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
    if (species === "red" || species === "grey" || species === "marten" || species === "grey_trapping") {
      enqueueSync(species as 'red' | 'grey' | 'marten' | 'grey_trapping', true);
      res.json({ message: `Sync started for ${species}` });
    } else {
      // Enqueue all in sequence!
      enqueueSync('red', true);
      enqueueSync('grey', true);
      enqueueSync('marten', true);
      enqueueSync('grey_trapping', true);
      res.json({ message: `Sequential sync started for all four categories (red, grey, marten, grey_trapping)` });
    }
  });

  // End point for sync status
  app.get("/api/sync-status", (req, res) => {
    res.json(syncStatus);
  });

  // End point to export full database as JSON
  app.get("/api/export", async (req, res) => {
    try {
      await ensureSpeciesLoaded('red');
      await ensureSpeciesLoaded('grey');
      await ensureSpeciesLoaded('marten');
      await ensureSpeciesLoaded('grey_trapping');
      
      const combined = {
        red: bulkStore.red || [],
        grey: bulkStore.grey || [],
        marten: bulkStore.marten || [],
        grey_trapping: bulkStore.grey_trapping || []
      };
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=scottish_squirrel_sightings.json');
      res.send(JSON.stringify(combined, null, 2));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // End point to import/load a local copy of full database as JSON
  app.post("/api/import", async (req, res) => {
    try {
      const data = req.body;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: "Invalid data. Expected a JSON object." });
      }

      const red = Array.isArray(data.red) ? data.red : [];
      const grey = Array.isArray(data.grey) ? data.grey : [];
      const marten = Array.isArray(data.marten) ? data.marten : [];
      const grey_trapping = Array.isArray(data.grey_trapping) ? data.grey_trapping : [];

      if (red.length === 0 && grey.length === 0 && marten.length === 0 && grey_trapping.length === 0) {
        return res.status(400).json({ error: "No records found in the uploaded file, or invalid JSON structure." });
      }

      // Update in-memory bulk store
      bulkStore.red = red;
      bulkStore.grey = grey;
      bulkStore.marten = marten;
      bulkStore.grey_trapping = grey_trapping;

      // Re-apply SSRS tagging logic to all imported records
      ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
        bulkStore[species].forEach(isSSRS);
      });

      // Maintain syncProgressStore since we imported a complete copy
      const limitYear = new Date().getFullYear();
      const allYears = [];
      for (let y = 2000; y <= limitYear; y++) {
        allYears.push(y);
      }
      
      const tsNow = new Date().toISOString();
      syncProgressStore.red = { completedYears: [...allYears], isComplete: true, count: red.length, lastSync: tsNow };
      syncProgressStore.grey = { completedYears: [...allYears], isComplete: true, count: grey.length, lastSync: tsNow };
      syncProgressStore.marten = { completedYears: [...allYears], isComplete: true, count: marten.length, lastSync: tsNow };
      syncProgressStore.grey_trapping = { completedYears: [...allYears], isComplete: true, count: grey_trapping.length, lastSync: tsNow };
      await saveProgressToFile();

      // Save to server local disk/file
      await saveDataToFile();

      // Also reset/update syncStatus counts so frontend sees them immediately
      syncStatus.red.count = bulkStore.red.length;
      syncStatus.grey.count = bulkStore.grey.length;
      syncStatus.marten.count = bulkStore.marten.length;
      syncStatus.grey_trapping.count = bulkStore.grey_trapping.length;

      syncStatus.red.lastSync = tsNow;
      syncStatus.grey.lastSync = tsNow;
      syncStatus.marten.lastSync = tsNow;
      syncStatus.grey_trapping.lastSync = tsNow;

      console.log(`[Import] Local copy successfully uploaded. New counts: red=${bulkStore.red.length}, grey=${bulkStore.grey.length}, marten=${bulkStore.marten.length}, grey_trapping=${bulkStore.grey_trapping.length}`);

      res.json({
        success: true,
        message: "Database imported successfully!",
        counts: {
          red: bulkStore.red.length,
          grey: bulkStore.grey.length,
          marten: bulkStore.marten.length,
          grey_trapping: bulkStore.grey_trapping.length
        }
      });
    } catch (err: any) {
      console.error("[Import] Error loading local copy:", err);
      res.status(500).json({ error: "Failed to import database", message: err.message });
    }
  });

  // Global error handler for API routes
  app.use("/api", (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`[API Error] ${req.method} ${req.url}:`, err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  });

  // Explicit 404 for missing API routes to avoid returning SPA HTML
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: "API route not found" });
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

    // If we have very few records or no records, trigger a fresh sequential sync in background in development
    if (process.env.NODE_ENV !== "production") {
      setTimeout(() => {
        try {
          ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
            const sKey = species as 'red' | 'grey' | 'marten' | 'grey_trapping';
            if (!bulkStore || typeof bulkStore !== 'object') {
              bulkStore = { red: [], grey: [], marten: [], grey_trapping: [] };
            }
            if (!bulkStore[sKey] || !Array.isArray(bulkStore[sKey])) {
              bulkStore[sKey] = [];
            }
            if (bulkStore[sKey].length < 10) {
              console.log(`[Server] Proactive sync enqueue for ${sKey} (current count: ${bulkStore[sKey].length})`);
              enqueueSync(sKey, false);
            }
          });
        } catch (err) {
          console.error("[Server] Error in proactive sync timer:", err);
        }
      }, 5000);
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Server] Squirrel Explorer API running on port ${PORT}`);
      console.log(`[Server] Health check: http://0.0.0.0:${PORT}/api/health`);
    });
  } catch (err) {
    console.error("[Server] Fatal error during startup:", err);
    process.exit(1);
  }
}

startServer();
