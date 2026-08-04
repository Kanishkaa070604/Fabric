#!/usr/bin/env node
// OCI DNS Zone webhook receiver for Fabric control-plane DNS reconciler.
//
// The control-plane's WebhookDnsProvider POSTs:
//   { "op": "upsert" | "delete", "name": "<fqdn>", "target": "<ip-or-cname>" }
//
// This service translates those into OCI DNS Zone RecordOperation calls
// (PatchZoneRecords), creating/updating/removing A or CNAME records as
// appropriate.
//
// Deployment options:
//   1. K8s Deployment in the Platform cluster (same as the control-plane)
//   2. OCI Functions (wrap with the fn-node runtime)
//   3. Any container runtime — it's a plain HTTP server
//
// Auth: uses OCI Instance Principal (in-cluster on OKE) or
// ~/.oci/config (local dev). Set OCI_AUTH_MODE=instance_principal for
// production; omit or set to "config_file" for local testing.
//
// Required env:
//   OCI_DNS_ZONE_ID        — OCID of the OCI DNS Zone to manage
//   OCI_DNS_COMPARTMENT_ID — Compartment of the zone (for API calls)
//   WEBHOOK_PORT           — Listen port (default 8090)
//   WEBHOOK_TOKEN          — Shared secret; must match FABRIC_DNS_WEBHOOK_TOKEN on CP
//   OCI_AUTH_MODE          — "instance_principal" (prod) or "config_file" (dev)
//
// OCI IAM policy required (for Instance Principal / dynamic group):
//   Allow dynamic-group <mesh-platform-dg> to manage dns-records in compartment <compartment>
//
"use strict";

const http = require("http");
const https = require("https");

// --- Config ---
const PORT = parseInt(process.env.WEBHOOK_PORT || "8090", 10);
const ZONE_ID = process.env.OCI_DNS_ZONE_ID || "";
const COMPARTMENT_ID = process.env.OCI_DNS_COMPARTMENT_ID || "";
const TOKEN = process.env.WEBHOOK_TOKEN || "";
const AUTH_MODE = process.env.OCI_AUTH_MODE || "config_file";
const RECORD_TTL = parseInt(process.env.OCI_DNS_RECORD_TTL || "60", 10);

// --- OCI REST signer (minimal, for DNS PatchZoneRecords) ---
// In production, use the OCI SDK. This inline implementation covers the
// minimum needed so the receiver has zero npm dependencies and can run as
// a single file. For a real deployment, replace with:
//   const { DnsClient } = require("oci-dns");
//   const { InstancePrincipalsAuthenticationDetailsProvider } = require("oci-common");

let ociSigner = null;

async function initOciAuth() {
  // Lazy-load OCI SDK if available; fall back to a no-op signer for local
  // testing (set OCI_DNS_DRY_RUN=1 to just log without calling OCI).
  if (process.env.OCI_DNS_DRY_RUN === "1") {
    console.log("[dns-webhook] DRY_RUN mode — will log operations but not call OCI API");
    ociSigner = { mode: "dry_run" };
    return;
  }
  try {
    const common = require("oci-common");
    const dns = require("oci-dns");
    let provider;
    if (AUTH_MODE === "instance_principal") {
      provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
    } else {
      provider = new common.ConfigFileAuthenticationDetailsProvider();
    }
    ociSigner = { client: new dns.DnsClient({ authenticationDetailsProvider: provider }) };
    console.log(`[dns-webhook] OCI DNS client initialized (auth=${AUTH_MODE})`);
  } catch (err) {
    console.error(`[dns-webhook] Failed to init OCI SDK: ${err.message}`);
    console.error("[dns-webhook] Install: npm install oci-common oci-dns");
    process.exit(1);
  }
}

// --- DNS record operations ---

function isIPv4(s) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

async function upsertRecord(name, target) {
  const rtype = isIPv4(target) ? "A" : "CNAME";
  const rdata = rtype === "CNAME" && !target.endsWith(".") ? target + "." : target;

  if (ociSigner.mode === "dry_run") {
    console.log(`[dns-webhook] DRY_RUN upsert ${rtype} ${name} -> ${rdata}`);
    return;
  }

  const items = [
    {
      operation: "REQUIRE", // ensure domain exists (no-op if already there)
      domain: name,
      rtype,
      // REQUIRE with no rdata = "domain must exist" — if it doesn't, the
      // PROHIBIT below won't fail. We use a two-step PROHIBIT+ADD instead.
    },
  ];

  // OCI PatchZoneRecords: remove any existing record for this name+type,
  // then add the new one. This is the standard upsert pattern for OCI DNS.
  await ociSigner.client.patchZoneRecords({
    zoneNameOrId: ZONE_ID,
    patchZoneRecordsDetails: {
      items: [
        { domain: name, rtype, operation: "REMOVE" },
        { domain: name, rtype, rdata, ttl: RECORD_TTL, operation: "ADD" },
      ],
    },
    compartmentId: COMPARTMENT_ID,
  });
  console.log(`[dns-webhook] upsert ${rtype} ${name} -> ${rdata} (ttl=${RECORD_TTL})`);
}

async function deleteRecord(name) {
  if (ociSigner.mode === "dry_run") {
    console.log(`[dns-webhook] DRY_RUN delete ${name}`);
    return;
  }

  // Remove both A and CNAME — we don't know which type was created.
  await ociSigner.client.patchZoneRecords({
    zoneNameOrId: ZONE_ID,
    patchZoneRecordsDetails: {
      items: [
        { domain: name, rtype: "A", operation: "REMOVE" },
        { domain: name, rtype: "CNAME", operation: "REMOVE" },
      ],
    },
    compartmentId: COMPARTMENT_ID,
  });
  console.log(`[dns-webhook] delete ${name}`);
}

// --- HTTP server ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  // Health check
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Only accept POST to /
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  // Auth check
  if (TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const { op, name, target } = body;
  if (!op || !name) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "op_and_name_required" }));
    return;
  }

  try {
    if (op === "upsert") {
      if (!target) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "target_required_for_upsert" }));
        return;
      }
      await upsertRecord(name, target);
    } else if (op === "delete") {
      await deleteRecord(name);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown_op" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, op, name }));
  } catch (err) {
    console.error(`[dns-webhook] ${op} ${name} failed: ${err.message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "oci_api_error", detail: err.message }));
  }
}

// --- Start ---

async function main() {
  if (!ZONE_ID) {
    console.error("[dns-webhook] OCI_DNS_ZONE_ID is required");
    process.exit(1);
  }
  if (!COMPARTMENT_ID) {
    console.error("[dns-webhook] OCI_DNS_COMPARTMENT_ID is required");
    process.exit(1);
  }

  await initOciAuth();

  const server = http.createServer(handleRequest);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[dns-webhook] listening on :${PORT} (zone=${ZONE_ID})`);
  });
}

main().catch((err) => {
  console.error(`[dns-webhook] fatal: ${err.message}`);
  process.exit(1);
});
