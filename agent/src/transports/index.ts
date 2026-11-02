import { AdbConnection, HttpConnection, IrConnection, SimulatedConnection, UdpConnection, WolConnection } from "./others.ts";
import { SerialConnection } from "./serial.ts";
import { TcpConnection } from "./tcp.ts";
import type { Connection, ConnectionSettings, TransportConfig } from "./types.ts";

export * from "./types.ts";
export { SimulatedConnection } from "./others.ts";

export function createConnection(cfg: TransportConfig, settings: ConnectionSettings, simulate = false): Connection {
  if (simulate) return new SimulatedConnection();
  switch (cfg.type) {
    case "tcp": return new TcpConnection(cfg, settings);
    case "udp": return new UdpConnection(cfg, settings);
    case "http": return new HttpConnection(cfg, settings);
    case "ir": return new IrConnection(cfg, settings);
    case "adb": return new AdbConnection(cfg, settings);
    case "wol": return new WolConnection(cfg, settings);
    case "serial": return new SerialConnection(cfg, settings);
  }
}
