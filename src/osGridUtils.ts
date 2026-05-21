// OS National Grid (OSGB36) and GPS (WGS84) Coordinate Conversion Utilities
// Developed using standard Transverse Mercator (Airy 1830 ellipsoid) equations.

const gridLetters: Record<string, [number, number]> = {
  SV: [0, 0], SW: [1, 0], SX: [2, 0], SY: [3, 0], SZ: [4, 0], TV: [5, 0], TW: [6, 0],
  SQ: [0, 1], SR: [1, 1], SS: [2, 1], ST: [3, 1], SU: [4, 1], TQ: [5, 1], TR: [6, 1],
  SL: [0, 2], SM: [1, 2], SN: [2, 2], SO: [3, 2], SP: [4, 2], TL: [5, 2], TM: [6, 2],
  SF: [0, 3], SG: [1, 3], SH: [2, 3], SJ: [3, 3], SK: [4, 3], TF: [5, 3], TG: [6, 3],
  SA: [0, 4], SB: [1, 4], SC: [2, 4], SD: [3, 4], SE: [4, 4], TA: [5, 4], TB: [6, 4],
  NW: [1, 5], NX: [2, 5], NY: [3, 5], NZ: [4, 5],
  NS: [2, 6], NT: [3, 6], NU: [4, 6],
  NL: [0, 7], NM: [1, 7], NN: [2, 7], NO: [3, 7], NP: [4, 7],
  NF: [0, 8], NG: [1, 8], NH: [2, 8], NJ: [3, 8], NK: [4, 8],
  NA: [0, 9], NB: [1, 9], NC: [2, 9], ND: [3, 9], NE: [4, 9],
  HW: [1, 10], HX: [2, 10], HY: [3, 10], HZ: [4, 10],
  HT: [3, 11], HU: [4, 11],
  HP: [4, 12]
};

export function latLonToEastingNorthing(lat: number, lon: number): { Easting: number; Northing: number } {
  const deg2rad = Math.PI / 180;
  const phi = lat * deg2rad;
  const lam = lon * deg2rad;

  const a = 6377563.396; // Airy 1830 major semi-axis
  const b = 6356256.909; // Airy 1830 minor semi-axis
  const F0 = 0.9996012717; // National Grid scale factor on central meridian
  const phi0 = 49 * deg2rad; // National Grid true origin latitude
  const lam0 = -2 * deg2rad; // Central meridian longitude
  const E0 = 400000; // False Easting of true origin
  const N0 = -100000; // False Northing of true origin

  const e2 = 1 - (b * b) / (a * a); // eccentricity squared
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n * n * n;

  const cosPhi = Math.sin(phi) === 0 ? 0.00001 : Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinPhi * sinPhi, 1.5);
  const eta2 = nu / rho - 1;

  const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (phi - phi0);
  const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(phi - phi0) * Math.cos(phi + phi0);
  const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (phi - phi0)) * Math.cos(2 * (phi + phi0));
  const Md = (35 / 24) * n3 * Math.sin(3 * (phi - phi0)) * Math.cos(3 * (phi + phi0));
  const M = b * F0 * (Ma - Mb + Mc - Md);

  const I = M + N0;
  const II = (nu / 2) * sinPhi * cosPhi;
  const III = (nu / 24) * sinPhi * Math.pow(cosPhi, 3) * (5 - Math.pow(Math.tan(phi), 2) + 9 * eta2);
  const IIIA = (nu / 720) * sinPhi * Math.pow(cosPhi, 5) * (61 - 58 * Math.pow(Math.tan(phi), 2) + Math.pow(Math.tan(phi), 4));
  const IV = nu * cosPhi;
  const V = (nu / 6) * Math.pow(cosPhi, 3) * (nu / rho - Math.pow(Math.tan(phi), 2));
  const VI = (nu / 120) * Math.pow(cosPhi, 5) * (5 - 18 * Math.pow(Math.tan(phi), 2) + Math.pow(Math.tan(phi), 4) + 14 * eta2 - 58 * Math.pow(Math.tan(phi), 2) * eta2);

  const dLam = lam - lam0;
  const dLam2 = dLam * dLam;
  const dLam3 = dLam * dLam2;
  const dLam4 = dLam3 * dLam;
  const dLam5 = dLam4 * dLam;
  const dLam6 = dLam5 * dLam;

  const Northing = I + II * dLam2 + III * dLam4 + IIIA * dLam6;
  const Easting = E0 + IV * dLam + V * dLam3 + VI * dLam5;

  return { Easting, Northing };
}

export function eastingNorthingToLatLon(E: number, N: number): { lat: number; lon: number } {
  const deg2rad = Math.PI / 180;
  const rad2deg = 180 / Math.PI;

  const a = 6377563.396;
  const b = 6356256.909;
  const F0 = 0.9996012717;
  const phi0 = 49 * deg2rad;
  const lam0 = -2 * deg2rad;
  const E0 = 400000;
  const N0 = -100000;

  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n * n * n;

  let phi = phi0 + (N - N0) / (a * F0);
  let M = 0;

  // 5 iterations is standard and extremely precise
  for (let i = 0; i < 5; i++) {
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (phi - phi0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(phi - phi0) * Math.cos(phi + phi0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (phi - phi0)) * Math.cos(2 * (phi + phi0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (phi - phi0)) * Math.cos(3 * (phi + phi0));
    M = b * F0 * (Ma - Mb + Mc - Md);
    phi = phi + (N - N0 - M) / (a * F0);
  }

  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const tanPhi = Math.tan(phi);
  const tanPhi2 = tanPhi * tanPhi;
  const tanPhi4 = tanPhi2 * tanPhi2;

  const nu = a * F0 / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinPhi * sinPhi, 1.5);
  const eta2 = nu / rho - 1;

  const VII = tanPhi / (2 * rho * nu);
  const VIII = tanPhi / (24 * rho * Math.pow(nu, 3)) * (5 + 3 * tanPhi2 + eta2 - 9 * tanPhi2 * eta2);
  const IX = tanPhi / (720 * rho * Math.pow(nu, 5)) * (61 + 90 * tanPhi2 + 45 * tanPhi4);
  const X = 1 / (cosPhi * nu);
  const XI = 1 / (6 * cosPhi * Math.pow(nu, 3)) * (nu / rho + 2 * tanPhi2);
  const XII = 1 / (120 * cosPhi * Math.pow(nu, 5)) * (5 + 28 * tanPhi2 + 24 * tanPhi4);
  const XIIA = 1 / (5040 * cosPhi * Math.pow(nu, 7)) * (61 + 662 * tanPhi2 + 1320 * tanPhi4 + 720 * Math.pow(tanPhi2, 3));

  const dE = E - E0;
  const dE2 = dE * dE;
  const dE3 = dE2 * dE;
  const dE4 = dE3 * dE;
  const dE5 = dE4 * dE;
  const dE6 = dE5 * dE;
  const dE7 = dE6 * dE;

  const latRad = phi - VII * dE2 + VIII * dE4 - IX * dE6;
  const lonRad = lam0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  return { lat: latRad * rad2deg, lon: lonRad * rad2deg };
}

export function get100kmSquareLetters(E: number, N: number): string {
  const col = Math.floor(E / 100000);
  const row = Math.floor(N / 100000);

  for (const [key, val] of Object.entries(gridLetters)) {
    if (val[0] === col && val[1] === row) {
      return key;
    }
  }
  return '??';
}

export function getContourColor(count: number, maxCount: number): { fillColor: string; color: string; fillOpacity: number; weight: number } {
  const ratio = maxCount > 1 ? count / maxCount : 1;
  
  if (ratio <= 0.2) {
    return {
      fillColor: '#22c55e', // Soft translucent Green (low density lowland)
      color: '#16a34a',
      fillOpacity: 0.35,
      weight: 1
    };
  } else if (ratio <= 0.4) {
    return {
      fillColor: '#84cc16', // Soft Lime/Yellow-Green
      color: '#65a30d',
      fillOpacity: 0.42,
      weight: 1.2
    };
  } else if (ratio <= 0.6) {
    return {
      fillColor: '#eab308', // Amber/Yellow (medium density hills)
      color: '#ca8a04',
      fillOpacity: 0.48,
      weight: 1.4
    };
  } else if (ratio <= 0.8) {
    return {
      fillColor: '#f97316', // Orange (mountain slopes)
      color: '#ea580c',
      fillOpacity: 0.54,
      weight: 1.6
    };
  } else {
    return {
      fillColor: '#dc2626', // Deep Crimson Red (high peaks)
      color: '#b91c1c',
      fillOpacity: 0.6,
      weight: 1.8
    };
  }
}
