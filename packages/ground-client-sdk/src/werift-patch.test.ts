import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * patches/werift+0.24.4.patch fixes ICE consent freshness on slow links (below) and werift's
 * partial-reliability (PR-SCTP) abandonment, which the
 * "flight-control" channel ({ ordered: false, maxRetransmits: 0 }) depends on: unpatched, a
 * maxRetransmits of 0 never abandons (`!!0`), so every lost fc-command is retransmitted with
 * backoff and the ground->air direction stalls under loss (SITL drill #89, scenario 4). These
 * guard against the patch silently not applying after a werift upgrade.
 */
const builds = ["lib/index.mjs", "lib/sctp/src/sctp.js"].map((path) => [
  path,
  readFileSync(new URL(`../../../node_modules/werift/${path}`, import.meta.url), "utf8"),
]);

function maybeAbandonSource(source: string): string {
  const start = source.indexOf("maybeAbandon(chunk) {");
  return source.slice(start, start + 1_200);
}

describe("werift PR-SCTP patch", () => {
  it.each(builds)("abandons maxRetransmits: 0 messages after the first send (%s)", (_path, source) => {
    const body = maybeAbandonSource(source);
    expect(body).toContain("chunk.maxRetransmits !== undefined && chunk.maxRetransmits !== null && chunk.maxRetransmits < chunk.sentCount");
    expect(body).not.toContain("!!chunk.maxRetransmits");
  });

  it.each(builds)("abandons exactly the message's own fragments (%s)", (_path, source) => {
    const body = maybeAbandonSource(source);
    expect(body).toContain("this.sentQueue.indexOf(chunk)");
    expect(body).toContain("SCTP_DATA_FIRST_FRAG");
  });

  it.each([
    ["lib/index.mjs", "return CONSENT_INTERVAL * 0.8 * 1e3;"],
    ["lib/ice/src/iceBase.js", "return exports.CONSENT_INTERVAL * 0.8 * 1000;"],
  ])("waits for a consent response until the next request is due (%s)", (path, expected) => {
    // Unpatched, the wait was 2 x the last RTT (at least 500 ms): on a link whose RTT grew past
    // that, every response was discarded and consent expired after 30 s on a working link
    // (SITL drill #89, scenarios 4a + 4b), after which werift stopped sending to the air.
    const source = readFileSync(new URL(`../../../node_modules/werift/${path}`, import.meta.url), "utf8");
    const start = source.indexOf("function consentResponseTimeoutMs(");
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, start + 600)).toContain(expected);
  });

  it("computes a maxPacketLifeTime expiry in seconds, like the abandon check", () => {
    const esm = builds[0][1];
    expect(esm).toContain("Date.now() / 1e3 + channel.maxPacketLifeTime / 1e3");
  });
});
