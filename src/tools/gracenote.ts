// Setup helper for finding your Xfinity lineup and station IDs.
//   npm run gracenote -- lineups <zip>
//   npm run gracenote -- channels <lineupId>
const BASE = "http://data.tmsapi.com/v1.1";
const key = process.env.GRACENOTE_API_KEY;
const [cmd, arg] = process.argv.slice(2);

if (!key || !cmd || !arg) {
  console.error("Usage: GRACENOTE_API_KEY=... npm run gracenote -- lineups <zip> | channels <lineupId>");
  process.exit(1);
}

const url =
  cmd === "lineups"
    ? `${BASE}/lineups?country=USA&postalCode=${encodeURIComponent(arg)}&api_key=${key}`
    : `${BASE}/lineups/${encodeURIComponent(arg)}/channels?api_key=${key}`;

const res = await fetch(url);
if (!res.ok) {
  console.error(`Gracenote ${res.status} ${await res.text()}`);
  process.exit(1);
}
const data: any[] = await res.json();

if (cmd === "lineups") {
  for (const l of data) console.log(`${l.lineupId.padEnd(24)} ${l.type.padEnd(10)} ${l.name}${l.location ? ` (${l.location})` : ""}`);
} else {
  // Printed as config entries ready to paste into "channels".
  for (const c of data.sort((a, b) => Number(a.channel) - Number(b.channel))) {
    console.log(JSON.stringify({ number: Number(c.channel), name: c.affiliateCallSign ?? c.callSign, callSign: c.callSign, stationId: c.stationId }) + ",");
  }
}
