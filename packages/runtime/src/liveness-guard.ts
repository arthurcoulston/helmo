function requireAbsent(identity: number, signalTarget: number, subject: string, invalid: string): void {
  if (!Number.isSafeInteger(identity) || identity <= 1) throw new Error(`${invalid}; repair refused.`);
  try { process.kill(signalTarget, 0); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error(`${subject} liveness is unknown; repair refused.`);
  }
  throw new Error(`${subject} is still live; repair refused.`);
}

/** Unknown/EPERM/reused/live process identities all refuse. */
export function requireProcessAbsent(pid: number): void {
  requireAbsent(pid, pid, 'Process', 'Invalid process identity');
}

/** Unknown/EPERM/reused/live process groups all refuse. */
export function requireSessionGroupAbsent(group: number): void {
  requireAbsent(group, -group, 'Session group', 'Missing session group');
}
