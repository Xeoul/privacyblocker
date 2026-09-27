// Formats the vault profile as the PROFILE secret the GitHub autopilot reads
// (see autopilot/SETUP.md). Plain `key: value` lines; keys may repeat.

const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);

export function autopilotProfile(state) {
  const p = state.profile || {};
  const out = [];
  const add = (key, values) => values.forEach((v) => out.push(`${key}: ${v}`));
  add('name', lines(p.fullName).slice(0, 1));
  add('other_name', lines(p.otherNames));
  // Addresses are often typed over two lines; the autopilot wants one per line.
  if (lines(p.currentAddress).length) out.push(`address: ${lines(p.currentAddress).join(', ')}`);
  add('past_address', lines(p.pastAddresses));
  add('phone', lines(p.phones));
  add('email', lines(p.emails));
  if (p.dob) out.push(`dob: ${p.dob}`);
  out.push(`drop: ${state.drop?.submitted ? 'yes' : 'no'}`);
  out.push('share: name, address, phone');
  return out.join('\n');
}
