import type { Config } from "../config.ts";
import { IrQueue, sleep } from "../drivers/ir/transmitter.ts";
import type { StateStore } from "../state.ts";

// Remote buttons exposed to the UI. Names follow the LIRC key namespace and must
// match the button names in the box's lircd.conf remote.
export const REMOTE_KEYS = [
  "KEY_POWER", "KEY_CHANNELUP", "KEY_CHANNELDOWN", "KEY_LAST", "KEY_INFO", "KEY_EPG",
  "KEY_MENU", "KEY_EXIT", "KEY_OK", "KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_RIGHT",
  "KEY_PLAYPAUSE", "KEY_REWIND", "KEY_FASTFORWARD", "KEY_RECORD", "KEY_A", "KEY_B", "KEY_C", "KEY_D",
  "KEY_0", "KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5", "KEY_6", "KEY_7", "KEY_8", "KEY_9",
] as const;

export class CableBoxController {
  constructor(private cfg: Config, private ir: IrQueue, private state: StateStore) {}

  private box(id: string) {
    const box = this.cfg.cableBoxes.find((b) => b.id === id);
    if (!box) throw new Error(`Unknown cable box "${id}"`);
    return { box, emitter: this.cfg.emitters[box.emitter] };
  }

  async tune(id: string, channel: number) {
    if (!Number.isInteger(channel) || channel <= 0 || channel > 9999) throw new Error(`Invalid channel ${channel}`);
    const { box, emitter } = this.box(id);
    const digits = String(channel).split("");

    await this.ir.run(async (send) => {
      for (const [i, d] of digits.entries()) {
        await send(emitter, box.remote, `KEY_${d}`);
        if (i < digits.length - 1) await sleep(this.cfg.ir.interDigitDelayMs);
      }
      if (box.enterKey) await send(emitter, box.remote, box.enterKey);
    });

    this.state.update((s) => {
      s.boxes[id] = { channel, lastCommandAt: new Date().toISOString() };
    });
  }

  async key(id: string, key: string) {
    if (!(REMOTE_KEYS as readonly string[]).includes(key)) throw new Error(`Key "${key}" is not allowed`);
    const { box, emitter } = this.box(id);
    await this.ir.run((send) => send(emitter, box.remote, key));

    // Channel up/down/last make the tracked channel unknowable.
    if (["KEY_CHANNELUP", "KEY_CHANNELDOWN", "KEY_LAST"].includes(key)) {
      this.state.update((s) => {
        s.boxes[id] = { lastCommandAt: new Date().toISOString() };
      });
    }
  }
}
