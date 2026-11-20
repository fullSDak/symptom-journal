import { describe, expect, it } from 'vitest';
import { emptyHistory, type Attachment, type Entry, type PatientHistory } from '../types';
import { makeSummary } from './summary';

const history = (overrides: Partial<PatientHistory> = {}): PatientHistory => ({
  ...emptyHistory,
  ...overrides,
});

const entry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'private-entry-id',
  symptom: 'Headache',
  details: 'Maybe worse in the morning',
  startedAt: '2025-03-04',
  endedAt: null,
  ongoing: true,
  severity: 6,
  impact: 'Hard to concentrate',
  createdAt: '2025-03-05T10:00:00Z',
  updatedAt: '2025-03-05T11:00:00Z',
  attachments: [],
  demo: false,
  ...overrides,
});

const attachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: 'private-attachment-id',
  kind: 'photo',
  name: 'selected-image.jpg',
  mimeType: 'image/jpeg',
  capturedAt: '2025-03-04',
  blob: new Blob(['private-media-bytes']),
  ...overrides,
});

// Derive the offset independently from Intl, including UTC and fractional-hour zones.
function expectedLocalTimestamp(value: string): string {
  const date = new Date(value);
  const local = date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    ...(date.getMilliseconds() ? { fractionalSecondDigits: 3 as const } : {}),
  });
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' })
    .formatToParts(date).find((part) => part.type === 'timeZoneName')!.value;
  return `${local} (${zone === 'GMT' ? 'UTC+00:00' : zone.replace('GMT', 'UTC')})`;
}

describe('makeSummary', () => {
  it('orders by reported onset, keeping equal and unavailable dates in input order without mutation', () => {
    const entries = [
      entry({ symptom: 'Later', startedAt: '2025-05-02' }),
      entry({ symptom: 'No date', startedAt: '' }),
      entry({ symptom: 'Earlier', startedAt: '2025-01-02' }),
      entry({ symptom: 'Same date', startedAt: '2025-01-02' }),
      entry({ symptom: 'Uncertain date', startedAt: 'sometime last winter' }),
    ];
    const result = makeSummary(entries, history(), []);
    const positions = ['Earlier', 'Same date', 'Later', 'No date', 'Uncertain date'].map(
      (name) => result.indexOf(`Symptom: ${name}`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(result).toContain('Onset: sometime last winter');
    expect(entries.map((item) => item.symptom)).toEqual(['Later', 'No date', 'Earlier', 'Same date', 'Uncertain date']);
  });

  it('preserves reported ongoing and resolved states, dates, uncertainty, impact and subjective severity', () => {
    const result = makeSummary([
      entry({ symptom: 'Ongoing pain', details: 'Possibly comes and goes', startedAt: '2025-01-01', endedAt: null, ongoing: true, impact: 'Might miss work', severity: 0 }),
      entry({ symptom: 'Resolved pain', details: 'Not sure what triggered it', startedAt: '2025-02-03', endedAt: '2025-02-07', ongoing: false, severity: null }),
    ], history(), []);
    expect(result).toContain('Status: Ongoing (patient-reported)');
    expect(result).toContain('Status: Resolved (patient-reported)');
    expect(result).toContain('Onset: 2025-01-01');
    expect(result).toContain('End/resolution: 2025-02-07');
    expect(result).toContain('End/resolution: Not provided');
    expect(result).toContain('Possibly comes and goes');
    expect(result).toContain('Not sure what triggered it');
    expect(result).toContain('Functional impact: Might miss work');
    expect(result).toContain('Severity (patient-reported): 0');
    expect(result).toContain('Severity (patient-reported): Not provided');
  });

  it('does not infer a status or date from a conflicting recorded end date', () => {
    const result = makeSummary([entry({ ongoing: true, endedAt: '2025-03-06' })], history(), []);
    expect(result).toContain('Status: Ongoing (patient-reported)');
    expect(result).toContain('End/resolution: 2025-03-06');
  });

  it('renders timestamp instants in local time with their actual UTC offsets', () => {
    // This late-night report crosses a UTC day boundary; local date must not come from UTC.
    const onset = '2025-03-04T23:30:00-05:00';
    const resolution = '2025-03-05T04:45:35.123Z';
    const photoDate = '2025-07-04T23:15:00-04:00';
    const audioDate = '2025-07-05T03:20:00Z';
    const result = makeSummary([entry({
      startedAt: onset,
      endedAt: resolution,
      ongoing: false,
      attachments: [
        attachment({ id: 'photo', capturedAt: photoDate }),
        attachment({ id: 'audio', kind: 'audio', capturedAt: audioDate }),
      ],
    })], history(), ['photo', 'audio']);
    expect(result).toContain(`Onset: ${expectedLocalTimestamp(onset)}`);
    expect(result).toContain(`End/resolution: ${expectedLocalTimestamp(resolution)}`);
    expect(result).toContain(`Selected photo: selected-image.jpg; reported capture date: ${expectedLocalTimestamp(photoDate)}`);
    expect(result).toContain(`Selected audio: recorded, untranscribed, and not analyzed; reported capture date: ${expectedLocalTimestamp(audioDate)}`);
  });

  it('formats a timezone-less local timestamp without changing its local day', () => {
    const localOnset = '2025-03-04T23:30';
    const result = makeSummary([entry({ startedAt: localOnset })], history(), []);
    expect(result).toContain(`Onset: ${expectedLocalTimestamp(localOnset)}\n`);
    expect(new Date(localOnset).getDate()).toBe(4);
    expect(new Date(localOnset).getHours()).toBe(23);
  });

  it('keeps date-only and unparseable dates without inventing a time or offset', () => {
    const result = makeSummary([entry({
      startedAt: '2025-03-04',
      endedAt: 'not sure: sometime later',
      attachments: [
        attachment({ id: 'date-only', name: 'day.jpg', capturedAt: '2025-03-03' }),
        attachment({ id: 'uncertain', name: 'uncertain.jpg', capturedAt: 'not sure: after lunch' }),
      ],
    })], history(), ['date-only', 'uncertain']);
    expect(result).toContain('Onset: 2025-03-04\n');
    expect(result).toContain('End/resolution: not sure: sometime later\n');
    expect(result).toContain('Selected photo: day.jpg; reported capture date: 2025-03-03\n');
    expect(result).toContain('Selected photo: uncertain.jpg; reported capture date: not sure: after lunch\n');
  });

  it('does not normalize an invalid calendar date to a different day', () => {
    const invalid = '2025-02-30T09:30:00Z';
    const result = makeSummary([entry({
      startedAt: invalid,
      endedAt: invalid,
      attachments: [
        attachment({ id: 'invalid', name: 'invalid.jpg', capturedAt: invalid }),
        attachment({ id: 'valid', name: 'valid.jpg', capturedAt: '2025-03-05T09:30:00Z' }),
      ],
    })], history(), ['invalid', 'valid']);
    expect(result).toContain(`Onset: ${invalid}\n`);
    expect(result).toContain(`End/resolution: ${invalid}\n`);
    expect(result).toContain(`Selected photo: invalid.jpg; reported capture date: ${invalid}\n`);
    expect(result.indexOf('Selected photo: valid.jpg')).toBeLessThan(result.indexOf('Selected photo: invalid.jpg'));
  });

  it('includes only selected media metadata and never interprets the media', () => {
    const photosAndAudio = [
      attachment({ id: 'chosen-photo', name: 'rash-closeup.jpg', capturedAt: '2025-03-01' }),
      attachment({ id: 'hidden-photo', name: 'secret-unselected.jpg', capturedAt: '2025-03-02' }),
      attachment({ id: 'chosen-audio', kind: 'audio', name: 'private-recording.webm', mimeType: 'audio/webm', capturedAt: '2025-03-03' }),
      attachment({ id: 'hidden-audio', kind: 'audio', name: 'hidden-recording.webm' }),
    ];
    const result = makeSummary([entry({ attachments: photosAndAudio })], history(), ['chosen-photo', 'chosen-audio']);
    expect(result).toContain('Selected photo: rash-closeup.jpg; reported capture date: 2025-03-01');
    expect(result).toContain('Selected audio: recorded, untranscribed, and not analyzed; reported capture date: 2025-03-03');
    expect(result).not.toContain('secret-unselected.jpg');
    expect(result).not.toContain('hidden-recording.webm');
    expect(result).not.toContain('private-recording.webm');
    expect(result).not.toContain('private-entry-id');
    expect(result).not.toContain('chosen-photo');
    expect(result).not.toContain('private-media-bytes');
    expect(result).not.toContain('image/jpeg');
    expect(result).not.toContain('2025-03-05T10:00:00Z');
  });

  it('sorts selected attachments by capture instant, stably placing unknown dates last without mutation', () => {
    const attachments = [
      attachment({ id: 'unknown-one', name: 'unknown-one.jpg', capturedAt: '' }),
      attachment({ id: 'late', name: 'late.jpg', capturedAt: '2025-03-05T05:00:00Z' }),
      attachment({ id: 'tie-one', name: 'tie-one.jpg', capturedAt: '2025-03-04T23:30:00-05:00' }),
      attachment({ id: 'unknown-text', name: 'unknown-text.jpg', capturedAt: 'not known' }),
      attachment({ id: 'early', name: 'early.jpg', capturedAt: '2025-03-04T04:30:00Z' }),
      attachment({ id: 'tie-audio', kind: 'audio', capturedAt: '2025-03-05T04:30:00Z' }),
      attachment({ id: 'unknown-two', name: 'unknown-two.jpg', capturedAt: '   ' }),
      attachment({ id: 'hidden', name: 'hidden.jpg', capturedAt: '2024-01-01' }),
    ];
    const ids = attachments.map(({ id }) => id).filter((id) => id !== 'hidden');
    const result = makeSummary([entry({ attachments })], history(), ids.reverse());
    const labels = [
      'Selected photo: early.jpg',
      'Selected photo: tie-one.jpg',
      'Selected audio:',
      'Selected photo: late.jpg',
      'Selected photo: unknown-one.jpg',
      'Selected photo: unknown-text.jpg',
      'Selected photo: unknown-two.jpg',
    ];
    const positions = labels.map((label) => result.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(result).toContain('Selected photo: unknown-one.jpg; reported capture date: Not provided');
    expect(result).toContain('Selected photo: unknown-two.jpg; reported capture date: Not provided');
    expect(result).toContain('Selected photo: unknown-text.jpg; reported capture date: not known');
    expect(result).not.toContain('hidden.jpg');
    expect(attachments.map(({ id }) => id)).toEqual([
      'unknown-one', 'late', 'tie-one', 'unknown-text', 'early', 'tie-audio', 'unknown-two', 'hidden',
    ]);
  });

  it('sorts date-only capture days against timestamps as local calendar days', () => {
    const localHalfPastMidnight = new Date(2025, 2, 4, 0, 30).toISOString();
    const result = makeSummary([entry({ attachments: [
      attachment({ id: 'timestamp', name: 'timestamp.jpg', capturedAt: localHalfPastMidnight }),
      attachment({ id: 'day', name: 'day.jpg', capturedAt: '2025-03-04' }),
    ] })], history(), ['timestamp', 'day']);
    expect(result.indexOf('Selected photo: day.jpg')).toBeLessThan(result.indexOf('Selected photo: timestamp.jpg'));
  });

  it('does not include attachments belonging to unselected entries, even if an ID is supplied', () => {
    const result = makeSummary([], history(), ['chosen-photo']);
    expect(result).not.toContain('rash-closeup.jpg');
    expect(result).not.toContain('Selected photo:');
  });

  it('does not turn symptom text or a selected photo into a diagnosis or advice', () => {
    const result = makeSummary([
      entry({ symptom: 'Chest pain', details: 'Not sure why', attachments: [attachment({ id: 'photo' })] }),
    ], history(), ['photo']);
    expect(result).toContain('Symptom: Chest pain');
    expect(result).toContain('Not sure why');
    expect(result).not.toMatch(/heart attack|image shows|photo shows|recommend(?:ation|ed)?/i);
  });

  it('presents reported context and test results without converting them into diagnoses', () => {
    const result = makeSummary([entry()], history({
      conditions: 'Possible migraine; never confirmed',
      medications: 'Medicine A, 5 mg',
      tests: 'ESR 45; the meaning is unclear',
      bloodHistory: 'I was told I might have anemia',
      questions: 'Could we discuss what this means?',
    }), []);
    expect(result).toContain('Conditions/history: Possible migraine; never confirmed');
    expect(result).toContain('Medications: Medicine A, 5 mg');
    expect(result).toContain('Tests/results: ESR 45; the meaning is unclear');
    expect(result).toContain('Blood history: I was told I might have anemia');
    expect(result).toContain('Questions for the clinician: Could we discuss what this means?');
    expect(result).not.toMatch(/diagnos(?:ed|is):/i);
    expect(result).not.toMatch(/ESR 45 (?:means|indicates|confirms)/i);
  });

  it('includes the sourced cautious ESR note only when selected and blood history is nonblank', () => {
    const note = 'Red-cell size and shape, and anemia, may affect ESR; please interpret results in context of blood count and clinical history.';
    const selected = makeSummary([], history({ bloodHistory: 'Possible anemia', includeEsrNote: true }), []);
    expect(selected).toContain(note);
    expect(selected).toContain('Patient-selected ESR context');
    expect(selected).toContain('https://menu.labmed.washington.edu/view/ESR');
    expect(makeSummary([], history({ bloodHistory: 'Possible anemia', includeEsrNote: false }), [])).not.toContain(note);
    expect(makeSummary([], history({ bloodHistory: '   ', includeEsrNote: true }), [])).not.toContain(note);
    expect(makeSummary([], history({ includeEsrNote: true }), [])).not.toContain('Patient-selected ESR context');
  });

  it('explicitly states the empty selection and ends with review and safety limits', () => {
    const result = makeSummary([], history(), []);
    expect(result).toContain('No symptom records selected.');
    expect(result).toContain('No patient context provided.');
    expect(result).toContain('Please review and edit this report before sharing');
    expect(result.endsWith('This report is patient-reported and needs clinician review. It is not a diagnosis or an emergency channel.')).toBe(true);
  });
});
