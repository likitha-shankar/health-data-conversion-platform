import net from "node:net";

const host = process.env.MLLP_HOST ?? "127.0.0.1";
const port = Number(process.env.MLLP_PORT ?? 2575);

const startBlock = Buffer.from([0x0b]);
const endBlock = Buffer.from([0x1c, 0x0d]);

const message = [
  "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603151200||ORU^R01|MSG-MLLP-001|P|2.5",
  "PID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F",
  "OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
].join("\r");

function parseAck(frame) {
  const start = frame.indexOf(startBlock);
  const end = frame.indexOf(endBlock);
  if (start === -1 || end === -1 || end <= start) return null;
  return frame.slice(start + 1, end).toString("utf-8");
}

const socket = net.createConnection({ host, port }, () => {
  const framed = Buffer.concat([startBlock, Buffer.from(message, "utf-8"), endBlock]);
  socket.write(framed);
});

let buffer = Buffer.alloc(0);
const timeout = setTimeout(() => {
  console.error("test-mllp failed: timeout waiting for ACK");
  socket.destroy();
  process.exit(1);
}, 10000);

socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const ack = parseAck(buffer);
  if (!ack) return;

  clearTimeout(timeout);
  const msa = ack
    .split("\r")
    .find((segment) => segment.startsWith("MSA|"));
  const code = msa?.split("|")[1] ?? "";
  if (code !== "AA") {
    console.error("test-mllp failed: expected AA ACK");
    console.error("ACK payload:", ack);
    process.exit(1);
  }

  console.log("MLLP ACK received and validated", { code, host, port });
  socket.end();
  process.exit(0);
});

socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error("test-mllp failed:", error.message);
  process.exit(1);
});
