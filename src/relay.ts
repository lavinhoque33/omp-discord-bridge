import http from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

/**
 * Local collab relay: the routing contract of omp's relay (`wss://my.omp.sh`), mirrored from
 * oh-my-pi `packages/collab-web/scripts/local-relay.ts`. It never decrypts anything.
 *
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket; the host creates the room.
 * - A second host gets close 4009; a guest for a missing room gets close 4004.
 * - Host frames carry a 4-byte big-endian peer id: 0 broadcasts to every guest, N targets guest N.
 * - Guest frames have their first 4 bytes rewritten to the sender's peer id and go to the host.
 * - The host is told `{"t":"peer-joined"|"peer-left","peer":N}`; when it leaves, guests get
 *   `{"t":"room-closed"}` and close 4001.
 */
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;

type Room = { host: WebSocket; guests: Map<number, WebSocket>; nextPeerId: number };

export interface CollabRelay {
  /** ws://127.0.0.1:<port> — the value for omp's `collab.relayUrl`. */
  url: string;
  close(): Promise<void>;
}

export async function startCollabRelay(port: number, host = "127.0.0.1"): Promise<CollabRelay> {
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" }).end("websocket upgrade required");
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const roomId = ROOM_PATH_RE.exec(url.pathname)?.[1];
    const role = url.searchParams.get("role");
    if (!roomId || (role !== "host" && role !== "guest")) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => (role === "host" ? hostJoined(roomId, ws) : guestJoined(roomId, ws)));
  });

  function hostJoined(roomId: string, ws: WebSocket): void {
    if (rooms.has(roomId)) {
      ws.close(4009, "a host is already connected for this room");
      return;
    }
    const room: Room = { host: ws, guests: new Map(), nextPeerId: 1 };
    rooms.set(roomId, room);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = toBuffer(data);
      if (frame.byteLength < ENVELOPE_HEADER_LENGTH) return;
      const peerId = frame.readUInt32BE(0);
      if (peerId === 0) for (const guest of room.guests.values()) guest.send(frame);
      else room.guests.get(peerId)?.send(frame);
    });
    ws.on("close", () => {
      if (rooms.get(roomId) !== room) return;
      rooms.delete(roomId);
      for (const guest of room.guests.values()) {
        guest.send(JSON.stringify({ t: "room-closed" }));
        guest.close(4001, "room closed");
      }
      room.guests.clear();
    });
  }

  function guestJoined(roomId: string, ws: WebSocket): void {
    const room = rooms.get(roomId);
    if (!room) {
      ws.close(4004, "no such room");
      return;
    }
    const peerId = room.nextPeerId++;
    room.guests.set(peerId, ws);
    room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = toBuffer(data);
      if (frame.byteLength < ENVELOPE_HEADER_LENGTH) return;
      frame.writeUInt32BE(peerId, 0);
      room.host.send(frame);
    });
    ws.on("close", () => {
      if (room.guests.delete(peerId)) room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
    });
  }

  const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(port, host, () => resolve());
  await listening;
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `ws://${host}:${boundPort}`,
    close: async () => {
      for (const room of rooms.values()) {
        for (const guest of room.guests.values()) guest.close(4001, "room closed");
        room.host.close(1001, "relay shutting down");
      }
      rooms.clear();
      wss.close();
      const { promise, resolve: closed } = Promise.withResolvers<void>();
      server.close(() => closed());
      server.closeAllConnections();
      await promise;
    },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
