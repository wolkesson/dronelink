import { createServer, Socket } from "node:net";

const MSP_V1_REQUEST_HEADER = Buffer.from([0x24, 0x4d, 0x3c]);
const MSP_V2_REQUEST_HEADER = Buffer.from([0x24, 0x58, 0x3c]);
const MSP_API_VERSION_REQUEST = Buffer.from([0x24, 0x4d, 0x3c, 0x00, 0x01, 0x01]);
const MSP_API_VERSION_RESPONSE = Buffer.from([0x24, 0x4d, 0x3e, 0x03, 0x01, 0x00, 0x02, 0x05, 0x05]);
const MSP_PREAMBLE_BYTE = 0x24;
const MSP_REQUEST_DIRECTION_BYTE = 0x3c;
const MSP_V1_VERSION_BYTE = 0x4d;
const MSP_V2_VERSION_BYTE = 0x58;
const MSP_V1_FRAME_OVERHEAD = 6;
const MSP_V2_FRAME_OVERHEAD = 9;
const MSP_V1_API_VERSION_FUNCTION = 0x01;
const MSP_V2_API_VERSION_FUNCTION = 0x0001;
const MSP_V1_ERROR_HEADER_BYTE = 0x21;
const MSP_V2_SUCCESS_HEADER_BYTE = 0x3e;
const MSP_V2_ERROR_HEADER_BYTE = 0x21;
const MSP_V2_DEFAULT_FLAG = 0x00;
const MSP_V2_API_VERSION_PAYLOAD = Buffer.from([0x00, 0x02, 0x05]);

const DEFAULT_PORT = 5761;
const configuredPort = Number(process.argv[2] ?? process.env.PORT ?? DEFAULT_PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : DEFAULT_PORT;

const toHex = (value: number): string => `0x${value.toString(16).padStart(2, "0")}`;
const toHex16 = (value: number): string => `0x${value.toString(16).padStart(4, "0")}`;

const logV1Request = (commandId: number, path: "API_VERSION" | "generic_error"): void => {
  console.log(`version=v1 cmd=${toHex(commandId)} path=${path}`);
};

const logV2Request = (functionId: number, path: "API_VERSION" | "generic_error"): void => {
  console.log(`version=v2 function=${toHex16(functionId)} path=${path}`);
};

const logIgnored = (reason: string): void => {
  console.log(`ignored: ${reason}`);
};

const crc8DvbS2 = (crc: number, byte: number): number => {
  let next = crc ^ byte;
  for (let i = 0; i < 8; i += 1) {
    next = (next & 0x80) === 0x80 ? ((next << 1) ^ 0xd5) & 0xff : (next << 1) & 0xff;
  }
  return next;
};

const crc8DvbS2Buffer = (bytes: Buffer): number => {
  let crc = 0;
  for (const byte of bytes) {
    crc = crc8DvbS2(crc, byte);
  }
  return crc;
};

const buildMspV2Response = (headerByte: number, flag: number, functionId: number, payload: Buffer): Buffer => {
  const body = Buffer.alloc(5 + payload.length);
  body[0] = flag;
  body.writeUInt16LE(functionId, 1);
  body.writeUInt16LE(payload.length, 3);
  payload.copy(body, 5);
  const crc = crc8DvbS2Buffer(body);
  return Buffer.concat([Buffer.from([MSP_PREAMBLE_BYTE, MSP_V2_VERSION_BYTE, headerByte]), body, Buffer.from([crc])]);
};

const findNextRequestHeader = (source: Buffer): number => {
  for (let index = 0; index <= source.length - 3; index += 1) {
    if (
      source[index] === MSP_PREAMBLE_BYTE
      && source[index + 2] === MSP_REQUEST_DIRECTION_BYTE
      && (source[index + 1] === MSP_V1_VERSION_BYTE || source[index + 1] === MSP_V2_VERSION_BYTE)
    ) {
      return index;
    }
  }
  return -1;
};

const handleSocket = (socket: Socket): void => {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const headerIndex = findNextRequestHeader(buffer);

      if (headerIndex === -1) {
        logIgnored(`dropped ${buffer.length} byte(s) without MSP request header`);
        buffer = Buffer.alloc(0);
        break;
      }

      if (headerIndex > 0) {
        logIgnored(`dropped ${headerIndex} leading non-MSP byte(s)`);
        buffer = buffer.subarray(headerIndex);
      }

      if (buffer.subarray(0, 3).equals(MSP_V1_REQUEST_HEADER)) {
        if (buffer.length < MSP_V1_FRAME_OVERHEAD) {
          break;
        }

        const payloadSize = buffer[3];
        const frameLength = MSP_V1_FRAME_OVERHEAD + payloadSize;
        if (buffer.length < frameLength) {
          break;
        }

        const frame = buffer.subarray(0, frameLength);
        const commandId = frame[4];

        if (frame.length === MSP_API_VERSION_REQUEST.length && frame.equals(MSP_API_VERSION_REQUEST)) {
          socket.write(MSP_API_VERSION_RESPONSE);
          logV1Request(commandId, "API_VERSION");
        } else {
          const genericError = Buffer.from([MSP_PREAMBLE_BYTE, MSP_V1_VERSION_BYTE, MSP_V1_ERROR_HEADER_BYTE, 0x00, commandId, commandId]);
          socket.write(genericError);
          logV1Request(commandId, "generic_error");
        }

        buffer = buffer.subarray(frameLength);
        continue;
      }

      if (buffer.subarray(0, 3).equals(MSP_V2_REQUEST_HEADER)) {
        if (buffer.length < MSP_V2_FRAME_OVERHEAD) {
          break;
        }

        const functionId = buffer.readUInt16LE(4);
        const payloadSize = buffer.readUInt16LE(6);
        const frameLength = MSP_V2_FRAME_OVERHEAD + payloadSize;
        if (buffer.length < frameLength) {
          break;
        }

        if (functionId === MSP_V2_API_VERSION_FUNCTION) {
          const response = buildMspV2Response(MSP_V2_SUCCESS_HEADER_BYTE, MSP_V2_DEFAULT_FLAG, functionId, MSP_V2_API_VERSION_PAYLOAD);
          socket.write(response);
          logV2Request(functionId, "API_VERSION");
        } else {
          const response = buildMspV2Response(MSP_V2_ERROR_HEADER_BYTE, MSP_V2_DEFAULT_FLAG, functionId, Buffer.alloc(0));
          socket.write(response);
          logV2Request(functionId, "generic_error");
        }

        buffer = buffer.subarray(frameLength);
        continue;
      }

      logIgnored("dropped byte while seeking MSP request header");
      buffer = buffer.subarray(1);
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
