/**
 * Sightings data structure from NBN Atlas (subset of fields)
 */
export interface Sighting {
  id: string;
  decimalLatitude: string;
  decimalLongitude: string;
  year: number;
  species?: string;
  raw_commonName?: string;
  occurrenceDate?: string;
  dataResourceName?: string;
  isTrapping?: boolean;
  gridReference?: string;
}

export interface SightingsResponse {
  occurrences: Sighting[];
  totalRecords: number;
}
