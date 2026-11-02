import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRules, jsonPath } from "../../src/engine/parsers.ts";
import { render, renderValue, check } from "../../src/engine/template.ts";

test("templates render paths and filters", () => {
  const ctx = { db: -12.6, mute: true, zone: 2, settings: { zones: [{ name: "Bar" }] }, state: { "zones.2.gain": -30 } };
  assert.equal(render("ZoneGain_{{zone}}={{db | round}}", ctx), "ZoneGain_2=-13");
  assert.equal(render("{{mute | bool:1:0}}", ctx), "1");
  assert.equal(render("{{settings.zones.0.name}}", ctx), "Bar");
  assert.equal(render("{{state.zones.2.gain}}", ctx), "-30"); // flat dotted state keys
  assert.equal(render("{{50 | scale:0:100:-80:0}}", ctx), "-40");
  assert.equal(render("{{db | clamp:-10:0}}", ctx), "-10");
  assert.equal(render("{{255 | hex:4}}", ctx), "00FF");
  assert.equal(render("{{\"PowerOn\" | map:PowerOn=on,*=off}}", ctx), "on");
  assert.equal(render("{{\"Ready\" | map:PowerOn=on,*=off}}", ctx), "off");
  assert.equal(render("{{missing | default:n/a}}", ctx), "n/a");
  assert.equal(render("HDMI{{\"hdmi3\" | digits}}", ctx), "HDMI3");
  assert.equal(renderValue("{{db}}", ctx), -12.6); // single tag keeps its type
  assert.throws(() => render("{{db | explode}}", ctx), /Unknown filter "explode"/);
  assert.deepEqual(check("{{a | nope}} {{b | upper}}"), ['unknown filter "nope"']);
});

test("parse rules: regex matches repeatedly, xmlTag and jsonPath extract values", () => {
  const batch = '{"method":"update","params":[{"param":"ZoneGain_0","val":-20},{"param":"ZoneMute_1","val":1}]}';
  assert.deepEqual(
    applyRules([{ regex: '"param":"Zone(?<kind>Gain|Mute)_(?<z>\\d+)","val":(?<v>-?\\d+)', set: { "zones.{{z}}.{{kind | lower}}": "{{v}}" } }], batch),
    { "zones.0.gain": "-20", "zones.1.mute": "1" },
  );
  assert.deepEqual(
    applyRules([{ xmlTag: "power-mode", set: { power: "{{value | map:PowerOn=on,*=off}}" } }], "<x><power-mode>DisplayOff</power-mode></x>"),
    { power: "off" },
  );
  assert.deepEqual(applyRules([{ jsonPath: "$.status.inputs[1].name", set: { input: "{{value}}" } }], '{"status":{"inputs":[{"name":"a"},{"name":"b"}]}}'), { input: "b" });
  assert.equal(jsonPath({ a: [{ b: 3 }] }, "a.0.b"), 3);
  assert.deepEqual(applyRules([{ jsonPath: "$.x", set: { x: "{{value}}" } }], "not json"), {});
});
