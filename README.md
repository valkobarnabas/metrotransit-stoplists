# Metro Transit stop list posters

Unofficial printable “stops from here” stop list posters for [Madison Metro Transit](https://www.cityofmadison.com/metro), built from the same GTFS feed as the timetable generator.

## Use the site

1. Type a **stop number** or search by **stop name**.
2. Pick **one route** (school extras 60–64 stay hidden unless you uncheck **Exclude school extras**).
3. **Generate poster**. Each **route heading** (westbound R1, eastbound F, …) is its own letter-width sheet. Numbered variants (R1 / R2, D1 / D2) get separate posters; unnumbered parent trips (R to Segoe, rare D) appear on both, with an LED headsign where those trips end. School extras 601–642 each get their own sheet. Nearby transfers use a fixed 250 ft radius.
4. Print or Save as PDF from the poster chrome (same as the timetable site).

Print from the poster page: Letter, actual size, no headers or footers.

## GitHub Pages

This folder is a site root of its own. Put these files at the repository root (or in `/docs`) and enable Pages. Include `data/served.json.gz`, `data/locations.json`, and `data/metrologo-mark.png`. `.nojekyll` is already here. `data/pack.json.gz` is unused by this site and can be omitted.

Do not open `index.html` as a local file (the data is gzipped and needs HTTP):

```bash
npx serve .
```

## Rebuild the stop data

From the parent `mmt_gtfs` repo (the folder that contains `stops.txt`):

```bash
node github-stops-served/build-data.js
```

That writes `data/served.json.gz` (patterns + coordinates).
