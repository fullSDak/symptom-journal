export type AttachmentKind = 'photo' | 'audio';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  capturedAt: string;
  blob: Blob;
}

export interface Entry {
  id: string;
  symptom: string;
  details: string;
  startedAt: string;
  endedAt: string | null;
  ongoing: boolean;
  severity: number | null;
  impact: string;
  createdAt: string;
  updatedAt: string;
  attachments: Attachment[];
  demo: boolean;
}

export interface PatientHistory {
  conditions: string;
  medications: string;
  tests: string;
  questions: string;
  bloodHistory: string;
  includeEsrNote: boolean;
}

export const emptyHistory: PatientHistory = {
  conditions: '', medications: '', tests: '', questions: '', bloodHistory: '', includeEsrNote: false,
};
