#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";

function log(message) {
  console.log(`[start] ${message}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

function parseDatabaseAddress(connectionString) {
  const parsed = new URL(connectionString);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432)
  };
}

async function waitForPostgres(connectionString, timeoutMs = 90000) {
  const { host, port } = parseDatabaseAddress(connectionString);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const cleanup = () => socket.destroy();

      socket.once("connect", () => {
        cleanup();
        resolve(true);
      });
      socket.once("error", () => {
        cleanup();
        resolve(false);
      });
      socket.setTimeout(1000, () => {
        cleanup();
        resolve(false);
      });
    });

    if (ok) {
      return;
    }

    await wait(1000);
  }

  throw new Error(`PostgreSQL not reachable within ${timeoutMs}ms`);
}

async function waitForReady(url, timeoutMs = 90000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/health/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep retrying
    }

    await wait(1000);
  }

  throw new Error(`Service not ready at ${url}/health/ready within ${timeoutMs}ms`);
}

function startWorkspaceService(workspace, env = process.env) {
  const child = spawn("npm", ["run", "start", "-w", workspace], {
    stdio: "inherit",
    env,
    shell: false
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[start] ${workspace} exited with code ${code}`);
      process.exit(code ?? 1);
    }
  });

  return child;
}

async function main() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/health_platform";

  const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:3000";
  const terminologyUrl = process.env.TERMINOLOGY_SERVICE_URL ?? "http://localhost:3002";
  const auditUrl = process.env.AUDIT_SERVICE_URL ?? "http://localhost:3003";
  const errorBusUrl = process.env.ERROR_BUS_URL ?? "http://localhost:3004";
  const hl7Url = process.env.HL7_AGENT_URL ?? "http://localhost:3001";
  const dashboardUrl = process.env.DASHBOARD_URL ?? "http://localhost:3005";

  log("Starting PostgreSQL container...");
  await runCommand("docker", ["compose", "up", "-d", "postgres"]);

  log("Waiting for PostgreSQL...");
  await waitForPostgres(databaseUrl);

  const children = [];

  log("Starting audit-service...");
  children.push(startWorkspaceService("@platform/audit-service", { ...process.env }));
  await waitForReady(auditUrl);

  log("Starting error-bus...");
  children.push(startWorkspaceService("@platform/error-bus", { ...process.env }));
  await waitForReady(errorBusUrl);

  log("Starting terminology-service...");
  children.push(startWorkspaceService("@platform/terminology-service", { ...process.env }));
  await waitForReady(terminologyUrl);

  log("Starting hl7v2-agent...");
  children.push(startWorkspaceService("@platform/hl7v2-agent", { ...process.env }));
  await waitForReady(hl7Url);

  log("Starting dashboard...");
  children.push(startWorkspaceService("@platform/dashboard", { ...process.env }));
  await waitForReady(dashboardUrl);

  log("Starting orchestrator...");
  children.push(startWorkspaceService("@platform/orchestrator", { ...process.env }));
  await waitForReady(orchestratorUrl);

  log("All services are ready.");

  const shutdown = () => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[start] failed: ${error.message}`);
  process.exit(1);
});
