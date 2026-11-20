#!/usr/bin/env python3
"""Blue Vue's NDI reader: small pictures of NDI streams, straight off the network.

Started by the server (src/ndi/receiver.ts). One JSON message per line on
stdin, one answer per line on stdout:

  {"id": 1, "op": "sources"}
      -> {"id": 1, "sources": ["BOX1 (Stream)", ...]}
  {"id": 2, "op": "frame", "name": "BOX1 (Stream)", "width": 480}
      -> {"id": 2, "jpeg": "<base64>", "signal": "ok" | "lost"}
      -> {"id": 2, "waiting": true}          no picture yet (still connecting)
      -> {"id": 2, "error": "..."}

Each stream asked for is received at NDI's low-bandwidth (preview) quality and
dropped again when nobody has asked for it for a while. Needs the cyndilib and
Pillow packages; cyndilib carries the NDI library itself.
"""
import base64
import io
import json
import queue
import sys
import threading
import time

IDLE_SECONDS = 15  # stop receiving a stream nobody is looking at
LOST_SECONDS = 4  # no new frame for this long: the stream has stopped
SEARCH_SECONDS = 6  # after starting, how long finding the streams on the network can take
MIN_FRAME_GAP = 0.2  # don't make a new picture more often than this per stream


def say(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


try:
    from cyndilib.finder import Finder
    from cyndilib.receiver import Receiver
    from cyndilib.video_frame import VideoFrameSync
    from cyndilib.wrapper.ndi_recv import RecvBandwidth, RecvColorFormat
    from PIL import Image
except Exception as err:  # noqa: BLE001 - reported to the server in words
    say({"event": "fatal", "error": f"Reading NDI needs the cyndilib and Pillow Python packages ({err})"})
    sys.exit(1)


class Stream:
    """One NDI stream being received, and the last picture made from it."""

    def __init__(self, source):
        self.receiver = Receiver(color_format=RecvColorFormat.RGBX_RGBA, bandwidth=RecvBandwidth.lowest)
        self.frame = VideoFrameSync()
        self.receiver.frame_sync.set_video_frame(self.frame)
        self.receiver.set_source(source)
        self.used = time.monotonic()
        self.made = 0.0
        self.width = 0
        self.jpeg = None
        self.stamp = None
        self.fresh = time.monotonic()

    def picture(self, width):
        now = time.monotonic()
        self.used = now
        if self.jpeg is None or self.width != width or now - self.made >= MIN_FRAME_GAP:
            self.receiver.frame_sync.capture_video()
            w, h = self.frame.xres, self.frame.yres
            if w and h:
                stamp = self.frame.get_timestamp_posix()
                if stamp != self.stamp or self.jpeg is None or self.width != width:
                    if stamp != self.stamp:
                        self.fresh = now
                    self.stamp = stamp
                    image = Image.frombuffer("RGBA", (w, h), bytes(self.frame.get_array()), "raw", "RGBA", self.frame.get_line_stride(), 1).convert("RGB")
                    if w > width:
                        image = image.resize((width, max(1, round(h * width / w))), Image.BILINEAR)
                    out = io.BytesIO()
                    image.save(out, "JPEG", quality=70)
                    self.jpeg = out.getvalue()
                    self.width = width
                self.made = now
        if self.jpeg is None:
            return {"waiting": True}
        return {"jpeg": base64.b64encode(self.jpeg).decode("ascii"), "signal": "lost" if now - self.fresh > LOST_SECONDS else "ok"}

    def close(self):
        try:
            self.receiver.disconnect()
        except Exception:  # noqa: BLE001
            pass


def main():
    finder = Finder()
    finder.open()
    streams = {}
    inbox = queue.Queue()

    def read():
        for line in sys.stdin:
            inbox.put(line)
        inbox.put(None)

    threading.Thread(target=read, daemon=True).start()
    started = time.monotonic()
    say({"event": "ready"})

    def find(name):
        names = finder.get_source_names()
        match = name if name in names else next((n for n in names if n.lower() == name.lower()), None)
        return finder.get_source(match) if match else None

    while True:
        try:
            line = inbox.get(timeout=5)
        except queue.Empty:
            line = ""
        if line is None:
            break
        now = time.monotonic()
        for name in [n for n, s in streams.items() if now - s.used > IDLE_SECONDS]:
            streams.pop(name).close()
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        reply = {"id": msg.get("id")}
        try:
            if msg.get("op") == "sources":
                reply["sources"] = sorted(finder.get_source_names())
            elif msg.get("op") == "frame":
                name = str(msg.get("name", ""))
                width = max(64, min(1280, int(msg.get("width") or 480)))
                stream = streams.get(name)
                if stream is None:
                    source = find(name)
                    if source is None and now - started < SEARCH_SECONDS:
                        reply["waiting"] = True  # still finding out what's on the network
                    elif source is None:
                        reply["error"] = "This stream isn't on the network right now"
                    else:
                        stream = streams[name] = Stream(source)
                if stream is not None:
                    reply.update(stream.picture(width))
            else:
                reply["error"] = f"Unknown request: {msg.get('op')}"
        except Exception as err:  # noqa: BLE001
            stream = streams.pop(str(msg.get("name", "")), None)
            if stream:
                stream.close()
            reply["error"] = f"{type(err).__name__}: {err}"
        say(reply)

    for stream in streams.values():
        stream.close()
    finder.close()


if __name__ == "__main__":
    main()
