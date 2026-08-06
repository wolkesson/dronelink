export function isTailscaleCandidate(candidate: string): boolean {
  return /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(candidate);
}
