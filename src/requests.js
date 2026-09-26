// Builds California privacy-law deletion / opt-out request emails.
// Only the fields the user ticks are included, so each broker gets the minimum
// needed to find the record.

export const FIELD_LABELS = {
  fullName: 'Full name',
  otherNames: 'Other names I have used',
  dob: 'Date of birth',
  currentAddress: 'Current address',
  pastAddresses: 'Previous addresses',
  phones: 'Phone numbers',
  emails: 'Email addresses',
  listingUrl: 'URL of the listing about me',
};

export const DEFAULT_FIELDS = ['fullName', 'currentAddress', 'listingUrl'];

function lines(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

export function buildRequest({ brokerName, profile, listingUrl = '', fields = DEFAULT_FIELDS, dropSubmitted = false, today = new Date() }) {
  const name = lines(profile.fullName)[0] || '[Your name]';
  const values = { ...profile, listingUrl };
  const idLines = [];
  for (const f of fields) {
    const vals = lines(values[f]);
    if (!vals.length) continue;
    idLines.push(vals.length === 1 ? `- ${FIELD_LABELS[f]}: ${vals[0]}` : `- ${FIELD_LABELS[f]}:\n${vals.map((v) => `    ${v}`).join('\n')}`);
  }
  const date = today.toISOString().slice(0, 10);

  const subject = `CCPA Request to Delete and Opt-Out of Sale/Sharing — ${name}`;
  const body = [
    `To the privacy team at ${brokerName || '[company]'},`,
    '',
    'I am a California resident. Under the California Consumer Privacy Act, as amended by the CPRA, I request that you:',
    '',
    '1. Delete all personal information you hold about me (Cal. Civ. Code § 1798.105), and direct your service providers and contractors to do the same.',
    '2. Stop selling or sharing my personal information (Cal. Civ. Code § 1798.120).',
    '3. Limit any use of my sensitive personal information (Cal. Civ. Code § 1798.121).',
    '',
    'The following is provided solely to locate my records. Do not use it for any other purpose, and do not add it to your database:',
    '',
    ...(idLines.length ? idLines : ['- [add identifying details]']),
    '',
    'Please confirm receipt within 10 business days and complete this request within 45 calendar days, as required by Cal. Civ. Code § 1798.130 and its regulations. If you deny any part of this request, please explain the legal basis.',
    '',
    ...(dropSubmitted ? [
      'I have also submitted a deletion request through the California Delete Request and Opt-out Platform (DROP). If you are a registered data broker, you are separately required to process it under the Delete Act (Cal. Civ. Code § 1798.99.86).',
      '',
    ] : []),
    'Thank you,',
    name,
    date,
  ].join('\n');

  return { subject, body };
}

export function mailtoUrl(to, { subject, body }) {
  const q = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${encodeURIComponent(to || '').replace(/%40/g, '@').replace(/%2B/g, '+')}?${q}`;
}
