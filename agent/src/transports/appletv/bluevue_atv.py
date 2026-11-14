#!/usr/bin/env python3
"""Blue Vue's Apple TV helper.

Apple TVs speak Apple's Companion and AirPlay protocols, which the open-source
pyatv library implements. Blue Vue starts this one process and talks to it
with one JSON message per line:

  in   {"id": 1, "op": "open", "host": "192.168.5.40"}
       {"id": 2, "op": "send", "host": "...", "key": "select"}
       {"id": 3, "op": "send", "host": "...", "power": "on"}
       {"id": 4, "op": "send", "host": "...", "app": "com.netflix.Netflix"}
       {"id": 5, "op": "pair", "host": "...", "step": "start" | "finish" | "cancel", "code": "1234"}
       {"id": 6, "op": "scan", "hosts": ["192.168.5.1", ...]}     (no hosts: ask the whole network)
       {"id": 7, "op": "close", "host": "..."}
  out  {"id": 1, "ok": true, ...}  or  {"id": 1, "error": "..."}
       {"event": "status", "host": "...", "online": true}
       {"event": "data", "host": "...", "data": {"power": true, "app": "Netflix", ...}}
       {"event": "log", "host": "...", "level": "info" | "error", "text": "..."}

Pairing codes and the credentials they produce stay in the storage file given
with --storage; they never go to Blue Vue.
"""

import argparse
import asyncio
import json
import sys
import threading

try:
    import pyatv
    from pyatv import const as pyatv_const, exceptions
    from pyatv.const import DeviceState, FeatureName, FeatureState, OperatingSystem, PairingRequirement, PowerState, Protocol
    from pyatv.storage.file_storage import FileStorage
except Exception as err:  # pylint: disable=broad-except
    print(json.dumps({"event": "fatal", "error": f"Apple TV control needs Python with the pyatv package ({err})"}), flush=True)
    sys.exit(3)

# Remote keys Blue Vue may press, by pyatv's own names.
KEYS = {
    "up", "down", "left", "right", "select", "menu", "home", "home_hold", "top_menu",
    "play", "pause", "play_pause", "stop", "next", "previous", "skip_forward", "skip_backward",
    "volume_up", "volume_down", "screensaver", "control_center", "guide", "channel_up", "channel_down",
}
PAIR_ORDER = [Protocol.Companion, Protocol.AirPlay]  # Companion: keys, power, apps. AirPlay: what's playing.
PAIR_TIMEOUT = 300  # time to walk to the TV and read the code


def emit(message):
    print(json.dumps(message), flush=True)


def is_apple_tv(conf):
    return conf.device_info.operating_system == OperatingSystem.TvOS


def needs_pairing(service):
    return service.pairing in (PairingRequirement.Mandatory, PairingRequirement.Optional) and not service.credentials


class NotPaired(RuntimeError):
    pass


class Device:
    """One Apple TV: keeps a connection up and reports what the box says."""

    def __init__(self, hub, host):
        self.hub = hub
        self.host = host
        self.atv = None
        self.lost = asyncio.Event()
        self.retry_now = asyncio.Event()
        self.task = asyncio.ensure_future(self.run())

    def log(self, level, text):
        emit({"event": "log", "host": self.host, "level": level, "text": text})

    def data(self, values):
        emit({"event": "data", "host": self.host, "data": values})

    async def run(self):
        delay = 2
        while True:
            try:
                await self.session()
                delay = 2
            except asyncio.CancelledError:
                raise
            except NotPaired as err:
                self.log("error", str(err))
                delay = 30  # pairing wakes this up at once
            except Exception as err:  # pylint: disable=broad-except
                self.log("error", str(err) or type(err).__name__)
            self.drop()
            self.retry_now.clear()
            try:
                await asyncio.wait_for(self.retry_now.wait(), delay)
            except asyncio.TimeoutError:
                pass
            delay = min(delay * 2, 30)

    async def session(self):
        conf = await self.hub.find(self.host)
        if conf is None:
            self.data({"reachable": False})
            raise RuntimeError("no Apple TV answered at this address")
        companion = conf.get_service(Protocol.Companion)
        if companion is None:
            raise RuntimeError("this device has no Companion service, so it can't be controlled")
        if needs_pairing(companion):
            self.data({"paired": False, "name": conf.name, "model": conf.device_info.model_str})
            raise NotPaired("not paired yet: pair it from the admin's TV pairing page")
        self.atv = await pyatv.connect(conf, self.hub.loop, storage=self.hub.storage)
        self.lost.clear()
        self.atv.listener = self
        self.atv.power.listener = self
        info = self.atv.device_info
        self.data({"paired": True, "name": conf.name, "model": info.model_str, "os": f"tvOS {info.version}" if info.version else "", "mac": info.mac or ""})
        self.report_power(self.atv.power.power_state)
        try:
            self.atv.push_updater.listener = self
            self.atv.push_updater.start()
        except Exception as err:  # pylint: disable=broad-except
            self.log("info", f"no playback reports from this box ({err})")
        await self.report_apps()
        emit({"event": "status", "host": self.host, "online": True})
        self.log("info", f"connected to {conf.name}")
        await self.lost.wait()

    def drop(self):
        if self.atv is not None:
            try:
                self.atv.close()
            except Exception:  # pylint: disable=broad-except
                pass
            self.atv = None
            emit({"event": "status", "host": self.host, "online": False})

    def close(self):
        self.task.cancel()
        self.drop()

    async def report_apps(self):
        try:
            apps = await self.atv.apps.app_list()
            self.data({"apps": sorted(({"id": a.identifier, "name": a.name or a.identifier} for a in apps), key=lambda a: a["name"].lower())})
        except Exception as err:  # pylint: disable=broad-except
            self.log("info", f"couldn't list apps ({err})")

    def report_power(self, state):
        if state != PowerState.Unknown:
            self.data({"power": state == PowerState.On})

    # --- pyatv listeners -----------------------------------------------------
    def connection_lost(self, exception):
        self.log("error", f"connection lost: {exception}")
        self.lost.set()

    def connection_closed(self):
        self.lost.set()

    def powerstate_update(self, old_state, new_state):
        self.report_power(new_state)

    def playstatus_update(self, updater, playstatus):
        app = None
        try:
            if not self.atv.features.in_state(FeatureState.Unavailable, FeatureName.App):
                app = self.atv.metadata.app
        except Exception:  # pylint: disable=broad-except
            pass
        title = " - ".join(x for x in (playstatus.title, playstatus.artist or playstatus.series_name) if x)
        self.data({
            "playback": playstatus.device_state.name.lower() if isinstance(playstatus.device_state, DeviceState) else "",
            "title": title,
            "app": (app.name or app.identifier) if app else "",
            "appId": app.identifier if app else "",
        })

    def playstatus_error(self, updater, exception):
        self.log("info", f"playback reports stopped: {exception}")

    # --- commands --------------------------------------------------------------
    async def send(self, msg):
        if self.atv is None:
            raise RuntimeError(f"No connection to the Apple TV at {self.host}. Check it's on the network and paired.")
        if "power" in msg:
            on = msg["power"] == "on"
            want = "on" if on else "off"
            power = self.atv.power
            if power.power_state == (PowerState.On if on else PowerState.Off):
                return {"power": on, "result": f"already {want}"}
            # pyatv can't wait for the new state over Companion, so wait for the box's own report here.
            target = PowerState.On if on else PowerState.Off
            await (power.turn_on() if on else power.turn_off())
            for _ in range(40):
                if power.power_state == target:
                    return {"power": on, "result": f"{want}, reported by the Apple TV"}
                await asyncio.sleep(0.25)
            if power.power_state == PowerState.Unknown:
                return {"result": f"sent {want}; this Apple TV doesn't report its power"}
            return {"power": power.power_state == PowerState.On, "result": f"sent {want}; the Apple TV hasn't reported {want}"}
        if "app" in msg:
            await self.atv.apps.launch_app(str(msg["app"]))
            return {}
        key = str(msg.get("key", "")).lower()
        if key not in KEYS:
            raise RuntimeError(f'Unknown Apple TV key "{key}" (one of: {", ".join(sorted(KEYS))})')
        await getattr(self.atv.remote_control, key)()
        return {}


class Hub:
    def __init__(self, loop, storage):
        self.loop = loop
        self.storage = storage
        self.devices = {}
        self.pairings = {}  # host -> (handler, protocol, conf, expiry handle)

    async def find(self, host):
        found = await pyatv.scan(self.loop, hosts=[host], timeout=4, storage=self.storage)
        return found[0] if found else None

    async def handle(self, msg):
        op = msg.get("op")
        host = msg.get("host", "")
        if op == "open":
            if host not in self.devices:
                self.devices[host] = Device(self, host)
            return {}
        if op == "close":
            device = self.devices.pop(host, None)
            if device:
                device.close()
            return {}
        if op == "send":
            device = self.devices.get(host)
            if device is None:
                raise RuntimeError(f"{host} isn't open")
            return await device.send(msg)
        if op == "scan":
            hosts = msg.get("hosts") or None
            found = await pyatv.scan(self.loop, hosts=hosts, timeout=int(msg.get("timeout", 6)), storage=self.storage)
            return {"found": [
                {"host": str(c.address), "name": c.name, "model": c.device_info.model_str, "mac": c.device_info.mac or ""}
                for c in found if is_apple_tv(c)
            ]}
        if op == "pair":
            return await self.pair(host, msg.get("step"), str(msg.get("code", "")).strip())
        raise RuntimeError(f'Unknown request "{op}"')

    async def cancel_pairing(self, host):
        entry = self.pairings.pop(host, None)
        if entry:
            entry[3].cancel()
            try:
                await entry[0].close()
            except Exception:  # pylint: disable=broad-except
                pass

    async def begin_pairing(self, host, conf, protocol):
        handler = await pyatv.pair(conf, protocol, self.loop, storage=self.storage, name="Blue Vue")
        await handler.begin()
        if not handler.device_provides_pin:
            await handler.close()
            raise RuntimeError("This Apple TV wants a code typed on the TV instead of showing one, which Blue Vue doesn't do")
        expiry = self.loop.call_later(PAIR_TIMEOUT, lambda: asyncio.ensure_future(self.cancel_pairing(host)))
        self.pairings[host] = (handler, protocol, conf, expiry)

    async def pair(self, host, step, code):
        if step == "cancel":
            await self.cancel_pairing(host)
            self.wake(host)  # the first code may already have paired it for control
            return {}
        if step == "start":
            await self.cancel_pairing(host)
            conf = await self.find(host)
            if conf is None:
                raise RuntimeError(f"No Apple TV answered at {host}. Check the address, and that it's awake and on this network.")
            todo = [p for p in PAIR_ORDER if conf.get_service(p) is not None and needs_pairing(conf.get_service(p))]
            if not todo:
                self.wake(host)
                return {"done": True, "message": "Already paired."}
            await self.begin_pairing(host, conf, todo[0])
            return {"done": False}
        if step == "finish":
            entry = self.pairings.get(host)
            if entry is None:
                raise RuntimeError("No pairing in progress for this Apple TV (or it timed out). Start pairing again.")
            if not code.isdigit() or len(code) != 4:
                raise RuntimeError("The code is the 4 digits shown on the Apple TV")
            handler, protocol, conf, _ = entry
            handler.pin(code)
            try:
                await handler.finish()
            except exceptions.PairingError as err:
                await self.cancel_pairing(host)
                raise RuntimeError(f"Pairing failed. Start pairing again. ({err})") from err
            paired = handler.has_paired
            await self.cancel_pairing(host)
            if not paired:
                raise RuntimeError("That code doesn't match the one on the Apple TV. Start pairing again.")
            await self.storage.save()
            # Companion is what control needs. AirPlay comes second, for what's playing.
            if protocol == Protocol.Companion:
                airplay = conf.get_service(Protocol.AirPlay)
                if airplay is not None and needs_pairing(airplay):
                    try:
                        await self.begin_pairing(host, conf, Protocol.AirPlay)
                        return {"done": False, "more": True, "message": "The Apple TV now shows a second code. Type that one in too."}
                    except Exception as err:  # pylint: disable=broad-except
                        self.wake(host)
                        return {"done": True, "message": f"Paired for control. The second step (what's playing) didn't start: {err}"}
            self.wake(host)
            return {"done": True}
        raise RuntimeError(f'Unknown pairing step "{step}"')

    def wake(self, host):
        """Reconnect right away instead of waiting out the retry delay."""
        device = self.devices.get(host)
        if device:
            device.retry_now.set()
            device.lost.set()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--storage", required=True, help="file that keeps pairing credentials")
    args = parser.parse_args()
    loop = asyncio.get_running_loop()
    storage = FileStorage(args.storage, loop)
    await storage.load()
    hub = Hub(loop, storage)
    done = asyncio.Event()

    async def answer(msg):
        try:
            result = await hub.handle(msg)
            emit({"id": msg.get("id"), "ok": True, **(result or {})})
        except Exception as err:  # pylint: disable=broad-except
            emit({"id": msg.get("id"), "error": str(err) or type(err).__name__})

    def on_line(line):
        try:
            msg = json.loads(line)
        except ValueError:
            return
        asyncio.ensure_future(answer(msg))

    # A thread reads stdin, because Windows event loops can't watch a pipe.
    def reader():
        for line in sys.stdin:
            if line.strip():
                loop.call_soon_threadsafe(on_line, line)
        loop.call_soon_threadsafe(done.set)  # Blue Vue went away

    threading.Thread(target=reader, daemon=True).start()
    emit({"event": "ready", "pyatv": getattr(pyatv_const, "__version__", "")})
    await done.wait()
    for device in list(hub.devices.values()):
        device.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
