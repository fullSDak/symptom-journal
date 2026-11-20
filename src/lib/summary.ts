import type { Entry, PatientHistory } from '../types';

const ESR_SOURCE = 'University of Washington Laboratory Medicine, Erythrocyte Sedimentation Rate: https://menu.labmed.washington.edu/view/ESR';
const ESR_NOTE = 'Red-cell size and shape, and anemia, may affect ESR; please interpret results in context of blood count and clinical history.';

/** Return the patient's text without inventing a value for a blank field. */
function reported(value: string | null | undefined): string {
  return value?.trim() || 'Not provided';
}

/** Date.parse can silently roll an invalid ISO calendar day into the following month. */
function hasValidIsoCalendarDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?=[Tt ]|$)/.exec(text);
  if (!match) return true;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

/** Keep date-only and unparseable reports as entered; timestamps use the device's local time. */
export function reportedDate(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return 'Not provided';
  // A date without a time is a calendar day, not midnight UTC (or any other instant).
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) || !/\d{1,2}:\d{2}/.test(text) || !hasValidIsoCalendarDay(text)) return text;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return text;

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
  const local = date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    ...(date.getMilliseconds() ? { fractionalSecondDigits: 3 as const } : {}),
  });
  return `${local} (UTC${sign}${hours}:${minutes})`;
}

/** Date-only attachment values represent local calendar days, not midnight UTC. */
function captureTime(value: string): number | null {
  const text = value.trim();
  if (!text || !hasValidIsoCalendarDay(text)) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const date = new Date(`${text}T00:00:00`);
    if (date.getFullYear() !== Number(dateOnly[1]) || date.getMonth() + 1 !== Number(dateOnly[2]) || date.getDate() !== Number(dateOnly[3])) return null;
    return date.getTime();
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}

/** Sort known onset times chronologically, with blank or unparseable dates last. */
function onsetTime(entry: Entry): number | null {
  const value = entry.startedAt.trim();
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function makeSummary(
  entries: Entry[],
  history: PatientHistory,
  selectedAttachmentIds: string[],
): string {
  const selected = new Set(selectedAttachmentIds);
  // Keep input order for equal or unknown onset dates; never mutate the entries.
  const ordered = entries
    .map((entry, index) => ({ entry, index, time: onsetTime(entry) }))
    .sort((a, b) => {
      if (a.time === null && b.time === null) return a.index - b.index;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return a.time - b.time || a.index - b.index;
    });

  const lines = [
    'Patient-reported appointment summary',
    'Please review and edit this report before sharing it with your clinician.',
    '',
    'Symptoms (ordered by reported onset):',
  ];

  if (ordered.length === 0) {
    lines.push('No symptom records selected.');
  }

  for (const { entry } of ordered) {
    lines.push(
      '',
      `Symptom: ${reported(entry.symptom)}`,
      `  Onset: ${reportedDate(entry.startedAt)}`,
      `  Status: ${entry.ongoing ? 'Ongoing' : 'Resolved'} (patient-reported)`,
      `  End/resolution: ${reportedDate(entry.endedAt)}`,
      `  Description: ${reported(entry.details)}`,
      `  Functional impact: ${reported(entry.impact)}`,
      `  Severity (patient-reported): ${entry.severity === null ? 'Not provided' : entry.severity}`,
    );

    // Preserve entry grouping and input order for equal or unknown capture dates.
    const attachments = entry.attachments
      .filter((attachment) => selected.has(attachment.id))
      .map((attachment, index) => ({ attachment, index, time: captureTime(attachment.capturedAt) }))
      .sort((a, b) => {
        if (a.time === null && b.time === null) return a.index - b.index;
        if (a.time === null) return 1;
        if (b.time === null) return -1;
        return a.time - b.time || a.index - b.index;
      });

    for (const { attachment } of attachments) {
      if (attachment.kind === 'photo') {
        lines.push(`  Selected photo: ${reported(attachment.name)}; reported capture date: ${reportedDate(attachment.capturedAt)}`);
      } else if (attachment.kind === 'audio') {
        lines.push(`  Selected audio: recorded, untranscribed, and not analyzed; reported capture date: ${reportedDate(attachment.capturedAt)}`);
      }
    }
  }

  lines.push('', 'Patient-reported context:');
  const context: Array<[string, string]> = [
    ['Conditions/history', history.conditions],
    ['Medications', history.medications],
    ['Tests/results', history.tests],
    ['Blood history', history.bloodHistory],
    ['Questions for the clinician', history.questions],
  ];
  const provided = context.filter(([, value]) => value.trim().length > 0);
  if (provided.length === 0) {
    lines.push('No patient context provided.');
  } else {
    for (const [label, value] of provided) lines.push(`${label}: ${value.trim()}`);
  }

  if (history.includeEsrNote && history.bloodHistory.trim()) {
    lines.push('', `Patient-selected ESR context (source: ${ESR_SOURCE}):`, ESR_NOTE);
  }

  lines.push(
    '',
    'This report is patient-reported and needs clinician review. It is not a diagnosis or an emergency channel.',
  );
  return lines.join('\n');
}
