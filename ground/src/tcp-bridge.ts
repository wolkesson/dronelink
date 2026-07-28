import { createServer, type Server, type Socket } from "node:net";
import type { RTCDataChannel } from "werift";

const TCP_PORT = Number(process.env.BRIDGE_TCP_PORT ?? 5761);

let server: Server | null = null;
let tcpClient: Socket | null = null;

export function startBridge(dataChannel: RTCDataChannel): void {
  if (server) {
    stopBridge();
  }

  dataChannel.onMessage.subscribe((data) => {
    if (tcpClient && !tcpClient.destroyed) {
      if (Buffer.isBuffer(data)) {
        tcpClient.write(data);
      } else {
        console.warn("TCP bridge: unexpected non-Buffer data from data channel, dropping");
      }
    }
  });

  server = createServer((socket: Socket) => {
    if (tcpClient && !tcpClient.destroyed) {
      socket.destroy();
      return;
    }

    tcpClient = socket;
    console.log("TCP client connected");

    socket.on("data", (chunk: Buffer) => {
      if (dataChannel.readyState === "open") {
        dataChannel.send(chunk);
      }
    });

    socket.on("close", () => {
      console.log("TCP client disconnected");
      tcpClient = null;
    });

    socket.on("error", (err: Error) => {
      console.error("TCP client error:", err.message);
      tcpClient = null;
    });
  });

  server.on("error", (err: Error) => {
    console.error("TCP bridge error:", err.message);
  });

  server.listen(TCP_PORT, () => {
    console.log(`TCP bridge listening on port ${TCP_PORT}`);
  });
}

export function stopBridge(): void {
  if (tcpClient) {
    tcpClient.destroy();
    tcpClient = null;
  }

  if (server) {
    server.close((err) => {
      if (err) console.error("TCP bridge close error:", err.message);
    });
    server = null;
  }
}
