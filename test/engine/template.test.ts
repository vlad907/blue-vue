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
  // [*] gives one match per item, and keys can use the item's fields.
  const control = '{"groups":[{"id":"main-wall","activePreset":"cam"},{"id":"double-wide","activePreset":""}]}';
  assert.deepEqual(applyRules([{ jsonPath: "$.groups[*]", set: { "groups.{{value.id}}.activePreset": "{{value.activePreset}}" } }], control), {
    "groups.main-wall.activePreset": "cam",
    "groups.double-wide.activePreset": "",
  });
  assert.deepEqual(applyRules([{ jsonPath: "$.groups", set: { groupList: "{{value}}" } }], control).groupList, JSON.parse(control).groups);
  assert.deepEqual(applyRules([{ jsonPath: "$.x", set: { x: "{{value}}" } }], "not json"), {});
  // [?field=value] keeps matching items, and `all` hands the rule every match as one list.
  const media = '{"files":[{"name":"logo.png","kind":"image"},{"name":"a.mp4","kind":"video"},{"name":"b.mov","kind":"video"}]}';
  assert.deepEqual(applyRules([{ jsonPath: "$.files[?kind=video]", all: true, set: { videos: "{{value}}" } }], media), { videos: [{ name: "a.mp4", kind: "video" }, { name: "b.mov", kind: "video" }] });
  assert.deepEqual(applyRules([{ jsonPath: "$.files[?kind=audio]", all: true, set: { sounds: "{{value}}" } }], media), { sounds: [] });
  assert.deepEqual(applyRules([{ jsonPath: "$.files[?kind=image]", set: { "pic.{{value.name}}": "yes" } }], media), { "pic.logo.png": "yes" });
});

test("a [name] in a path is filled in first, and carry keeps fields of matching items", () => {
  const ctx = {
    group: "wall", arrangement: "two",
    state: {
      "groups.wall.slots": [{ slot: 1, name: "Top left", ndiName: "CAM 1", signal: "ok" }, { slot: 2, name: "Top right", ndiName: "CAM 2", signal: "ok" }],
      "sim.slots.two": [{ slot: 1, name: "Left", ndiName: "", signal: "empty" }, { slot: 2, name: "Right", ndiName: "", signal: "empty" }, { slot: 3, name: "Extra", ndiName: "", signal: "empty" }],
    },
  };
  assert.equal((renderValue("{{state.groups.[group].slots}}", ctx) as unknown[]).length, 2);
  assert.equal(renderValue("{{state.groups.[missing].slots}}", ctx), undefined);
  assert.deepEqual(renderValue("{{state.sim.slots.[arrangement] | carry:slot:@state.groups.[group].slots:ndiName,signal}}", ctx), [
    { slot: 1, name: "Left", ndiName: "CAM 1", signal: "ok" },
    { slot: 2, name: "Right", ndiName: "CAM 2", signal: "ok" },
    { slot: 3, name: "Extra", ndiName: "", signal: "empty" },
  ]);
  assert.equal((ctx.state["sim.slots.two"][0] as { ndiName: string }).ndiName, ""); // the original is left alone
  assert.throws(() => render("{{state.nope | carry:slot:@state.groups.[group].slots:ndiName}}", ctx), /no list to fill/);
});

test("patch changes one field of one list item, reading arguments with @", () => {
  const ctx = { state: { outs: [{ id: "bar", volumeDb: 0 }, { id: "patio", volumeDb: -10 }] }, output: "patio", level: -3, min: -5 };
  assert.deepEqual(renderValue("{{state.outs | patch:id:@output:volumeDb:@level}}", ctx), [{ id: "bar", volumeDb: 0 }, { id: "patio", volumeDb: -3 }]);
  assert.equal(ctx.state.outs[1].volumeDb, -10); // the original is left alone
  assert.equal(render("{{level | clamp:@min:10}}", ctx), "-3");
  assert.throws(() => render("{{state.outs | patch:id:lobby:mute:true}}", ctx), /no item with id "lobby"/);
  assert.throws(() => render("{{state.missing | patch:id:bar:mute:true}}", ctx), /hasn't been read/);
});
