import crypto from "node:crypto";
import net from "node:net";

const START_BLOCK = 0x0b;
const END_BLOCK = 0x1c;
const CARRIAGE_RETURN = 0x0d;

export function parseFrame(
  buffer: Buffer
): { messages: string[]; remainder: Buffer } {
  const messages: string[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf(START_BLOCK, cursor);
    if (start === -1) break;
    const end = buffer.indexOf(Buffer.from([END_BLOCK, CARRIAGE_RETURN]), start + 1);
    if (end === -1) break;

    const message = buffer.slice(start + 1, end).toString("utf-8");
    messages.push(message);
    cursor = end + 2;
  }

  const remainder = cursor > 0 ? buffer.slice(cursor) : buffer;
  return { messages, remainder };
}

export function encodeAck(ackMessage: string): Buffer {
  return Buffer.concat([
    Buffer.from([START_BLOCK]),
    Buffer.from(ackMessage, "utf-8"),
    Buffer.from([END_BLOCK, CARRIAGE_RETURN])
  ]);
}

function hl7TimestampUtc(): string {
  const date = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join("");
}

export function generateAck(mshSegment: string, code: "AA" | "AE", errorText?: string): string {
  const fields = mshSegment.split("|");
  const sendingApp = fields[2] ?? "UNKNOWN";
  const sendingFacility = fields[3] ?? "UNKNOWN";
  const receivingApp = fields[4] ?? "MLLP_LISTENER";
  const receivingFacility = fields[5] ?? "LOCAL";
  const controlId = fields[9] ?? "UNKNOWN";
  const version = fields[11] ?? "2.5";
  const ackControlId = crypto.randomUUID();

  const msh = [
    "MSH",
    "^~\\&",
    receivingApp,
    receivingFacility,
    sendingApp,
    sendingFacility,
    hl7TimestampUtc(),
    "",
    "ACK",
    ackControlId,
    "P",
    version
  ].join("|");

  const msa = ["MSA", code, controlId, errorText ?? ""].join("|");
  return `${msh}\r${msa}`;
}

interface MllpServerOptions {
  port: number;
  onMessage: (hl7Message: string, remoteAddress: string) => Promise<string>;
  onConnection?: (remoteAddress: string) => void;
}

export class MllpServer {
  private readonly server: net.Server;

  constructor(private readonly options: MllpServerOptions) {
    this.server = net.createServer((socket) => {
      const remoteAddress = socket.remoteAddress ?? "unknown";
      this.options.onConnection?.(remoteAddress);

      let buffer: Buffer = Buffer.alloc(0);
      socket.on("data", async (chunk: Buffer | string) => {
        const dataChunk = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
        buffer = Buffer.concat([buffer, dataChunk]);
        const parsed = parseFrame(buffer);
        buffer = parsed.remainder;

        for (const message of parsed.messages) {
          try {
            const ack = await this.options.onMessage(message, remoteAddress);
            socket.write(encodeAck(ack));
          } catch {
            const msh = message.split("\r")[0] ?? "MSH|^~\\&|||||||||||2.5";
            socket.write(encodeAck(generateAck(msh, "AE", "MLLP_HANDLER_ERROR")));
          }
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, resolve);
    });
  }
}
