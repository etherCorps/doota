// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isBlockedHost } from "$lib/server/ssrf";

describe("image-proxy SSRF guard", () => {
  it("blocks loopback / private / link-local / ULA / CGNAT", () => {
    for (const h of [
      "127.0.0.1", "127.9.9.9", "10.0.0.5", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "localhost", "foo.localhost", "::1", "fc00::1", "fd12::1", "fe80::1",
    ]) {
      expect(isBlockedHost(h), h).toBe(true);
    }
  });

  it("allows public hosts and IPs", () => {
    for (const h of ["example.com", "images.googleusercontent.com", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1"]) {
      expect(isBlockedHost(h), h).toBe(false);
    }
  });
});
