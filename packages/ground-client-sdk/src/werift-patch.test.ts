import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * patches/werift+0.24.4.patch fixes werift's partial-reliability (PR-SCTP) abandonment, which the
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

  it("computes a maxPacketLifeTime expiry in seconds, like the abandon check", () => {
    const esm = builds[0][1];
    expect(esm).toContain("Date.now() / 1e3 + channel.maxPacketLifeTime / 1e3");
  });
});
