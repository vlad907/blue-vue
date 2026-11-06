// Android key codes the remote protocol accepts (android.view.KeyEvent).
// Profiles can name a key ("HOME" or "KEYCODE_HOME") or give its number.
// Whether a given TV acts on a key is up to the TV; HDMI keys in particular
// need testing on each model.

export const KEYCODES: Record<string, number> = {
  HOME: 3, BACK: 4,
  "0": 7, "1": 8, "2": 9, "3": 10, "4": 11, "5": 12, "6": 13, "7": 14, "8": 15, "9": 16,
  DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26,
  ENTER: 66, DEL: 67, MENU: 82, SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85, MEDIA_STOP: 86, MEDIA_NEXT: 87, MEDIA_PREVIOUS: 88, MEDIA_REWIND: 89, MEDIA_FAST_FORWARD: 90,
  MUTE: 91, ESCAPE: 111, MEDIA_PLAY: 126, MEDIA_PAUSE: 127,
  VOLUME_MUTE: 164, INFO: 165, CHANNEL_UP: 166, CHANNEL_DOWN: 167, GUIDE: 172, CAPTIONS: 175, SETTINGS: 176,
  TV_POWER: 177, TV_INPUT: 178,
  PROG_RED: 183, PROG_GREEN: 184, PROG_YELLOW: 185, PROG_BLUE: 186,
  SLEEP: 223, WAKEUP: 224,
  TV_INPUT_HDMI_1: 243, TV_INPUT_HDMI_2: 244, TV_INPUT_HDMI_3: 245, TV_INPUT_HDMI_4: 246,
};

/** "HOME", "KEYCODE_HOME", "home" or "3" -> 3. */
export function keyCode(name: string | number): number {
  if (typeof name === "number") return name;
  const s = name.trim().toUpperCase().replace(/^KEYCODE_/, "");
  if (/^\d+$/.test(s) && !(s in KEYCODES && s.length === 1)) return Number(s);
  const code = KEYCODES[s];
  if (code === undefined) throw new Error(`Unknown key "${name}"`);
  return code;
}

export function keyName(code: number): string {
  const name = Object.keys(KEYCODES).find((k) => KEYCODES[k] === code);
  return name ? `KEYCODE_${name}` : `key ${code}`;
}
