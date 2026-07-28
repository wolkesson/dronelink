import { createServer, Socket } from "node:net";

const MSP_REQUEST_HEADER = Buffer.from([0x24, 0x4d, 0x3c]);
const MSP_API_VERSION_REQUEST = Buffer.from([0x24, 0x4d, 0x3c, 0x00, 0x01, 0x01]);
const MSP_API_VERSION_RESPONSE = Buffer.from([0x24, 0x4d, 0x3e, 0x03, 0x01, 0x00, 0x02, 0x05, 0x05]);

const DEFAULT_PORT = 5761;
const configuredPort = Number(process.argv[2] ?? process.env.PORT ?? DEFAULT_PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : DEFAULT_PORT;

const toHex = (value: number): string => `0x${value.toString(16).padStart(2, "0")}`;

const logRequest = (cmd: number, path: "API_VERSION" | "generic_error"): void => {
  console.log(`cmd=${toHex(cmd)} path=${path}`);
};

const logIgnored = (reason: string): void => {
  console.log(`ignored: ${reason}`);
};

const handleSocket = (socket: Socket): void => {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const headerIndex = buffer.indexOf(MSP_REQUEST_HEADER);

      if (headerIndex === -1) {
        logIgnored(`dropped ${buffer.length} byte(s) without MSP request header`);
        buffer = Buffer.alloc(0);
        break;
      }

      if (headerIndex > 0) {
        logIgnored(`dropped ${headerIndex} leading non-MSP byte(s)`);
        buffer = buffer.subarray(headerIndex);
      }

      if (buffer.length < 3) {
        break;
      }

      if (buffer[0] !== 0x24 || buffer[1] !== 0x4d || buffer[2] !== 0x3c) {
        logIgnored("dropped byte while seeking MSP request header");
        buffer = buffer.subarray(1);
        continue;
      }

      if (buffer.length < 6) {
        break;
      }

      const payloadSize = buffer[3];
      const frameLength = 6 + payloadSize;

      if (buffer.length < frameLength) {
        break;
      }

      const frame = buffer.subarray(0, frameLength);
      const commandId = frame[4];

      if (frame.equals(MSP_API_VERSION_REQUEST)) {
        socket.write(MSP_API_VERSION_RESPONSE);
        logRequest(commandId, "API_VERSION");
      } else {
        const genericError = Buffer.from([0x24, 0x4d, 0x21, 0x00, commandId, commandId]);
        socket.write(genericError);
        logRequest(commandId, "generic_error");
      }

      buffer = buffer.subarray(frameLength);
    }
  });

  socket.on("error", (error: Error) => {
    console.error(`socket error: ${error.message}`);
  });
};

const server = createServer(handleSocket);

server.on("error", (error: Error) => {
  console.error(`server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake FC MSP responder listening on 127.0.0.1:${port}`);
});
