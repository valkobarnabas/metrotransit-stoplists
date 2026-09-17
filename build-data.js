/**
 * Pack remaining-stop patterns for github-stops-served.
 * Run from the repo root: node github-stops-served/build-data.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { loadGtfs, isSchoolSupplement, publicStopCode } = require("../generate_poster.js");
const served = require("./served.js");

function parseTime(t) {
  const [hh, mm] = String(t || "0:0").split(":");
  return { minutes: Number(hh) * 60 + Number(mm) };
}

const DIR = { 0: "NB", 90: "EB", 180: "SB", 270: "WB" };
const OUT = path.join(__dirname, "data");

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { stops, routes, trips, timesByTrip, feed } = loadGtfs();
  const stopById = Object.fromEntries(stops.map((s) => [s.stop_id, s]));
  const routeById = Object.fromEntries(routes.map((r) => [r.route_id, r]));

  const geo = {};
  for (const s of stops) {
    const code = publicStopCode(s);
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    geo[code] = {
      n: s.stop_name,
      lat,
      lon,
      street: (s.primary_street || "").trim(),
      cd: s.cardinal_direction || "",
      dir: DIR[Number(s.cardinal_direction)] || "",
    };
  }

  const agg = new Map();
  let tripN = 0;
  for (const trip of trips) {
    const route = routeById[trip.route_id];
    if (!route) continue;
    const seq = (timesByTrip.get(trip.trip_id) || [])
      .slice()
      .sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    if (seq.length < 2) continue;
    const codes = [];
    const mins = [];
    let t0 = null;
    for (const st of seq) {
      const stop = stopById[st.stop_id];
      if (!stop) continue;
      const code = publicStopCode(stop);
      const t = parseTime(st.departure_time || st.arrival_time);
      if (t0 == null) t0 = t.minutes;
      let m = t.minutes - t0;
      if (m < 0) m += 24 * 60;
      codes.push(code);
      mins.push(m);
    }
    if (codes.length < 2) continue;
    const board = served.formatHeadboard(route.route_short_name, trip.trip_headsign);
    const dirId = String(trip.direction_id ?? "");
    const key = [route.route_short_name, dirId, board.code, board.dest, codes.join(">")].join("\t");
    let row = agg.get(key);
    if (!row) {
      row = {
        r: route.route_short_name,
        d: dirId,
        k: board.code,
        e: board.dest,
        n: 0,
        s: codes,
        mSum: mins.map(() => 0),
      };
      agg.set(key, row);
    }
    row.n += 1;
    for (let i = 0; i < mins.length; i++) row.mSum[i] += mins[i];
    tripN += 1;
    if (tripN % 5000 === 0) console.log(`  grouped ${tripN} trips`);
  }

  const patterns = [];
  for (const row of agg.values()) {
    patterns.push({
      r: row.r,
      d: row.d,
      k: row.k,
      e: row.e,
      n: row.n,
      s: row.s,
      m: row.mSum.map((sum) => Math.round((sum / row.n) * 10)),
    });
  }

  const routeList = routes
    .slice()
    .sort(
      (a, b) =>
        Number(a.route_sort_order || 0) - Number(b.route_sort_order || 0) ||
        String(a.route_short_name || "").localeCompare(String(b.route_short_name || ""), undefined, { numeric: true })
    )
    .map((r) => ({
      n: r.route_short_name,
      c: `#${r.route_color || "333366"}`,
      t: `#${r.route_text_color || "FFFFFF"}`,
      s: isSchoolSupplement(r),
      o: Number(r.route_sort_order || 0),
    }));

  const stopRoutes = {};
  for (const p of patterns) {
    const route = routeList.find((r) => r.n === p.r);
    const pill = route ? { n: route.n, c: route.c, t: route.t, s: route.s } : { n: p.r, c: "#333366", t: "#FFFFFF" };
    const seen = new Set();
    const seq = p.s;
    for (let i = 0; i < seq.length - 1; i++) {
      const code = seq[i];
      if (seen.has(code)) continue;
      seen.add(code);
      if (!stopRoutes[code]) stopRoutes[code] = [];
      if (!stopRoutes[code].some((x) => x.n === pill.n)) stopRoutes[code].push({ ...pill });
    }
  }
  for (const list of Object.values(stopRoutes)) {
    list.sort((a, b) => served.compareBoardCodes(a.n, b.n));
  }

  const index = Object.keys(stopRoutes)
    .map((code) => {
      const g = geo[code] || {};
      return {
        code,
        name: g.n || code,
        street: g.street || "",
        dir: g.dir || "",
        routes: stopRoutes[code],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));

  const pack = {
    feed: {
      v: feed.feed_version || "",
      feed_version: feed.feed_version || "",
      feed_start_date: feed.feed_start_date || "",
      feed_end_date: feed.feed_end_date || "",
    },
    routes: routeList,
    stops: index,
    geo,
    stopRoutes,
    patterns,
    radius: { recommended: served.DEFAULT_RADIUS, unit: "ft" },
    mapQr: Object.fromEntries(
      routeList
        .filter((r) => !r.s)
        .map((r) => [r.n, served.qrBits(served.routeMapUrl(r.n))])
        .filter(([, bits]) => bits)
    ),
  };

  const gzPath = path.join(OUT, "served.json.gz");
  const raw = Buffer.from(JSON.stringify(pack));
  fs.writeFileSync(gzPath, zlib.gzipSync(raw, { level: 9 }));
  const mb = (fs.statSync(gzPath).size / 1e6).toFixed(2);
  console.log(`Wrote ${index.length} stops, ${patterns.length} patterns, ${tripN} trips → data/served.json.gz (${mb} MB)`);

  const locPath = path.join(OUT, "locations.json");
  if (!fs.existsSync(locPath)) {
    fs.writeFileSync(locPath, JSON.stringify({ reviewed: [], stops: {} }, null, 2) + "\n");
    console.log("Wrote empty data/locations.json");
  }

  const packSrc = path.join(__dirname, "../github/data/pack.json.gz");
  if (copyIfExists(packSrc, path.join(OUT, "pack.json.gz"))) {
    console.log("Copied github/data/pack.json.gz");
  }

  const logoCandidates = [
    path.join(__dirname, "../github/data/metrologo-mark.png"),
    path.join(__dirname, "../metrologo-mark.png"),
    path.join(__dirname, "../data/metrologo-mark.png"),
  ];
  const logo = logoCandidates.find((p) => fs.existsSync(p));
  if (logo) {
    fs.copyFileSync(logo, path.join(OUT, "metrologo-mark.png"));
    console.log(`Copied logo from ${logo}`);
  }

  probe(pack);
}

function probe(pack) {
  const samples = ["0716", "2197", "0010", "9624"];
  console.log("\nSample posters:");
  for (const code of samples) {
    if (!pack.geo[code]) continue;
    try {
      const { posters } = served.generateServedHtml(pack, code, { radius: served.DEFAULT_RADIUS, excludeSchool: true });
      const summary = posters
        .map((p) => `${p.titleCode} ${p.heading} (${p.rows.filter((r) => r.type === "stop").length} stops)`)
        .join("; ");
      console.log(`  #${code} ${pack.geo[code].n}: ${summary || "(none)"}`);
    } catch (e) {
      console.log(`  #${code}: ${e.message}`);
    }
  }

  const pairs = [
    ["0716", "10061"],
    ["2197", "2198"],
    ["0010", "0011"],
    ["0100", "1400"],
  ];
  console.log("\nTransfer distances (recommend 250 ft — same intersection, not the next):");
  for (const [a, b] of pairs) {
    if (!pack.geo[a] || !pack.geo[b]) continue;
    const d = served.distM(pack.geo[a], pack.geo[b]);
    console.log(`  ${a} ↔ ${b}: ${served.metersToFeet(d)} ft`);
  }
}

main();
