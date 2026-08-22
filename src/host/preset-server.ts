import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { platform } from "node:os";
import * as path from "node:path";
import { URL as NodeUrl } from "node:url";
import { exportUserPresetsToStorage, replaceUserPresets } from "./presets.js";
import { PRESET_EXPORT_FILENAME } from "../shared/presets.js";

const MAX_REQUEST_BYTES = 2_000_000;
// The secret moves in a custom header instead of the URL query string. Custom
// headers force browsers to run a CORS preflight, so a plain cross-site form-
// or-fetch POST cannot reach these endpoints even if the URL leaks (Referer,
// history, logs). Non-browser callers must know the per-dialog token anyway.
// Wire format is lowercase because Node lowercases incoming header names;
// the advertised name in `auth` derives from this constant so the two can
// never drift again.
const AUTH_HEADER_NAME = "x-x2klm-token";

function authHeaderDisplayName(): string {
  return AUTH_HEADER_NAME.split("-").map(function (part) { return part.toUpperCase(); }).join("-");
}

export interface PresetAuthHeader {
  name: string;
  value: string;
}

export interface PresetPersistenceServer {
  presetsUrl: string;
  exportUrl: string;
  revealUrl: string;
  auth: PresetAuthHeader;
  close(): Promise<void>;
}

// The modal SDK bridge can only return data by closing the dialog. This
// loopback-only endpoint lets the open editor persist preset mutations without
// restarting the modal. A per-instance token (sent via the auth header)
// prevents unrelated local callers.
export async function startPresetPersistenceServer(
  storageDirectory: string | undefined,
): Promise<PresetPersistenceServer | null> {
  if (!storageDirectory) return null;

  const token = randomUUID();
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, storageDirectory).catch((error) => {
      console.error("[x2k Loop Mutator] Preset persistence request crashed.", error);
      if (!response.headersSent) {
        setCorsHeaders(response);
        sendJson(response, 500, { ok: false, message: "Preset persistence failed." });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    presetsUrl: `${baseUrl}/presets`,
    exportUrl: `${baseUrl}/export`,
    revealUrl: `${baseUrl}/reveal`,
    auth: { name: authHeaderDisplayName(), value: token },    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

function isAuthorized(request: IncomingMessage, expectedToken: string): boolean {
  const given = request.headers[AUTH_HEADER_NAME];
  if (typeof given !== "string" || !given) return false;
  const givenBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(expectedToken);
  return givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  storageDirectory: string,
): Promise<void> {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new NodeUrl(request.url ?? "/", "http://127.0.0.1");
  const knownPath =
    url.pathname === "/presets" ||
    url.pathname === "/export" ||
    url.pathname === "/reveal";

  // One uniform rejection for wrong method, unknown path, or missing/invalid
  // credentials so the server does not reveal which check failed.
  if (request.method !== "POST" || !knownPath || !isAuthorized(request, token)) {
    sendJson(response, 404, { ok: false, message: "Not found." });
    return;
  }

  try {
    if (url.pathname === "/reveal") {
      await revealPresetExport(storageDirectory);
      sendJson(response, 200, { ok: true });
      return;
    }
    const json = await readRequestBody(request);
    if (url.pathname === "/export") {
      const exportPath = await exportUserPresetsToStorage(storageDirectory, json);
      sendJson(response, 200, { ok: true, path: exportPath });
      return;
    }
    const result = await replaceUserPresets(storageDirectory, json);
    sendJson(response, 200, { ok: true, message: result.notice });
  } catch (error) {
    console.error("[x2k Loop Mutator] Immediate preset persistence failed.", error);
    sendJson(response, 400, {
      ok: false,
      message: error instanceof Error ? error.message : "Preset persistence failed.",
    });
  }
}

async function revealPresetExport(storageDirectory: string): Promise<void> {
  const exportPath = path.join(storageDirectory, PRESET_EXPORT_FILENAME);
  const currentPlatform = platform();
  const command = currentPlatform === "darwin"
    ? { executable: "open", args: ["-R", exportPath] }
    : currentPlatform === "win32"
      ? { executable: "explorer.exe", args: [`/select,${exportPath}`] }
      : { executable: "xdg-open", args: [path.dirname(exportPath)] };

  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("Preset data exceeds the size limit.");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", `Content-Type, ${AUTH_HEADER_NAME}`);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Connection", "close");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
