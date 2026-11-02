"use strict";

const crypto = require("node:crypto");

function readTrustedServices(raw = "") {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("TOKEN_API_SERVICES_JSON must be a JSON object.");
  for (const [serviceId, service] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(serviceId) || !service || typeof service.publicKey !== "string" || !service.role) {
      throw new Error(`Invalid trusted-service configuration for ${serviceId}.`);
    }
    if (!["game", "replica"].includes(service.role)) throw new Error(`Unsupported role for trusted service ${serviceId}.`);
  }
  return parsed;
}

function bodyHash(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function canonicalRequest(method, path, timestamp, nonce, body) {
  return [method.toUpperCase(), path, timestamp, nonce, bodyHash(body)].join("\n");
}

function unauthorized(message) {
  return Object.assign(new Error(message), { status: 401 });
}

class ServiceAuthenticator {
  constructor(services, maxSkewSeconds = 300) {
    this.services = services;
    this.maxSkewSeconds = maxSkewSeconds;
    this.seenNonces = new Map();
  }

  verify(headers, method, path, rawBody, expectedRole) {
    const serviceId = headers["x-service-id"];
    const timestamp = headers["x-service-timestamp"];
    const nonce = headers["x-service-nonce"];
    const signature = headers["x-service-signature"];
    const service = this.services[serviceId];
    if (!service || (expectedRole && service.role !== expectedRole)) throw unauthorized("Unauthorized service.");
    if (!/^\d{10,13}$/.test(String(timestamp || "")) || !/^[a-zA-Z0-9_-]{16,128}$/.test(String(nonce || ""))) {
      throw unauthorized("Invalid service request timestamp or nonce.");
    }
    const timestampSeconds = String(timestamp).length === 13 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > this.maxSkewSeconds) {
      throw unauthorized("Service request timestamp is outside the accepted time window.");
    }
    if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw unauthorized("Invalid service request signature.");
    const nonceKey = `${serviceId}:${nonce}`;
    this.pruneNonces();
    if (this.seenNonces.has(nonceKey)) throw unauthorized("Service request nonce has already been used.");
    const message = canonicalRequest(method, path, String(timestamp), nonce, rawBody);
    let valid = false;
    try {
      valid = crypto.verify(null, Buffer.from(message), service.publicKey, Buffer.from(signature, "base64"));
    } catch {
      valid = false;
    }
    if (!valid) throw unauthorized("Service request signature could not be verified.");
    this.seenNonces.set(nonceKey, Date.now());
    return { id: serviceId, role: service.role };
  }

  pruneNonces() {
    if (this.seenNonces.size < 10_000) return;
    const expiry = Date.now() - this.maxSkewSeconds * 2000;
    for (const [key, seenAt] of this.seenNonces) {
      if (seenAt < expiry) this.seenNonces.delete(key);
    }
    while (this.seenNonces.size >= 10_000) this.seenNonces.delete(this.seenNonces.keys().next().value);
  }
}

module.exports = { ServiceAuthenticator, canonicalRequest, readTrustedServices };
