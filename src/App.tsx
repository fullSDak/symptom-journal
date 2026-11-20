import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from 'react';
import {
  Activity, ArrowDownRight, ArrowLeft, ArrowRight, AudioLines, BookHeart, CalendarDays,
  Camera, Check, CheckCircle2, ChevronDown, CircleHelp, ClipboardList, Copy, FileText,
  Heart, ImagePlus, Info, LockKeyhole, Menu, Mic, Pause, Plus, Printer, Share2,
  ShieldCheck, Sparkles, Square, Trash2, X,
} from 'lucide-react';
import { clearJournal, deleteEntry, listEntries, putEntry, readHistory, writeHistory } from './lib/storage';
import { makeSummary, reportedDate } from './lib/summary';
import { emptyHistory, type Attachment, type Entry, type PatientHistory } from './types';
import './App.css';

type Page = 'today' | 'timeline' | 'prepare' | 'history';
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: { length: number; [index: number]: RecognitionResult } };
type BrowserRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionConstructor = new () => BrowserRecognition;

const pageLabels: Record<Page, string> = { today: 'Today', timeline: 'Timeline', prepare: 'Prepare visit', history: 'Your history' };
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const localInput = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const isoFromInput = (value: string) => new Date(value).toISOString();
const inputFromIso = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : localInput(date);
};
const displayDate = (value: string, time = false) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || 'Date not recorded';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...(time ? { hour: 'numeric', minute: '2-digit' } : {}) });
};
const sorted = (entries: Entry[]) => [...entries].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
const photoTime = (photo: Attachment) => {
  const time = photo.capturedAt.trim() ? Date.parse(photo.capturedAt) : NaN;
  return Number.isFinite(time) ? time : null;
};
const sortedPhotos = (photos: Attachment[]) => photos.map((photo, index) => ({ photo, index, time: photoTime(photo) })).sort((a, b) => {
  if (a.time === null && b.time === null) return a.index - b.index;
  if (a.time === null) return 1;
  if (b.time === null) return -1;
  return a.time - b.time || a.index - b.index;
}).map(({ photo }) => photo);
const photoDate = (photo: Attachment, time = false) => photoTime(photo) === null ? 'Date unknown' : displayDate(photo.capturedAt, time);
const orderedAttachments = (attachments: Attachment[]) => [
  ...sortedPhotos(attachments.filter(item => item.kind === 'photo')),
  ...attachments.filter(item => item.kind !== 'photo'),
];

// One lease is shared across editor instances, including an unresolved permission prompt.
type MicrophoneLease = {
  kind: 'recording' | 'dictation'; cancelled: boolean; failed?: boolean;
  stream?: MediaStream; recorder?: MediaRecorder; recognition?: BrowserRecognition;
};
let microphoneLease: MicrophoneLease | null = null;
const microphoneListeners = new Set<() => void>();
const subscribeMicrophone = (listener: () => void) => { microphoneListeners.add(listener); return () => { microphoneListeners.delete(listener); }; };
const microphoneSnapshot = () => microphoneLease;
const notifyMicrophone = () => microphoneListeners.forEach(listener => listener());
function acquireMicrophone(kind: MicrophoneLease['kind']) {
  if (microphoneLease) return null;
  const lease: MicrophoneLease = { kind, cancelled: false };
  microphoneLease = lease;
  notifyMicrophone();
  return lease;
}
function releaseMicrophone(lease: MicrophoneLease) {
  if (microphoneLease !== lease) return;
  microphoneLease = null;
  notifyMicrophone();
}
function stopTracks(stream?: MediaStream) { stream?.getTracks().forEach(track => track.stop()); }
function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
const recognitionConstructor = () => {
  const browser = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
};

function Mark({ light = false }: { light?: boolean }) {
  return <span className={`brand-mark ${light ? 'brand-mark-light' : ''}`} aria-hidden="true"><Activity size={22} strokeWidth={1.8} /></span>;
}

function BlobImage({ attachment, className = '' }: { attachment: Attachment; className?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(attachment.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [attachment.blob]);
  return url ? <img src={url} alt={`Patient-selected photo: ${attachment.name}`} className={className} /> : <div className={`image-loading ${className}`} />;
}

function BlobAudio({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(attachment.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [attachment.blob]);
  return url ? <audio controls src={url} aria-label={`Listen to ${attachment.name}`} /> : null;
}

function Navigation({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const items: { page: Page; label: string; icon: typeof Heart }[] = [
    { page: 'today', label: 'Today', icon: Heart },
    { page: 'timeline', label: 'Timeline', icon: Activity },
    { page: 'prepare', label: 'Prepare visit', icon: ClipboardList },
    { page: 'history', label: 'Your history', icon: BookHeart },
  ];
  return <>
    <aside className="sidebar">
      <div className="brand"><Mark light /><div><strong>Symptom Trail</strong><span>Make the moments count</span></div></div>
      <div className="side-label">YOUR SPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {items.map(({ page: item, label, icon: Icon }) => <button key={item} className={page === item ? 'active' : ''} onClick={() => setPage(item)} aria-current={page === item ? 'page' : undefined}><Icon size={19} strokeWidth={1.7} />{label}{page === item && <span className="nav-dot" />}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="side-heart"><Heart size={18} /></div><p>A little more clarity for the conversations that matter.</p><span>MADE FOR YOUR MOMENTS</span></div>
    </aside>
    <nav className="mobile-nav" aria-label="Main navigation">
      {items.map(({ page: item, label, icon: Icon }) => <button key={item} className={page === item ? 'active' : ''} onClick={() => setPage(item)} aria-current={page === item ? 'page' : undefined}><Icon size={20} strokeWidth={1.8} /><span>{item === 'history' ? 'History' : label}</span></button>)}
    </nav>
  </>;
}

function EntryCard({ entry, onEdit, onDelete, compact = false }: { entry: Entry; onEdit: (entry: Entry) => void; onDelete: (entry: Entry) => void; compact?: boolean }) {
  const photos = sortedPhotos(entry.attachments.filter(item => item.kind === 'photo'));
  const audio = entry.attachments.filter(item => item.kind === 'audio');
  return <article className={`entry-card ${compact ? 'compact-entry' : ''}`}>
    <div className="entry-date"><span className="entry-date-dot" /><span>{displayDate(entry.startedAt, true)}</span>{entry.demo && <span className="demo-pill">FICTIONAL DEMO</span>}</div>
    <div className="entry-heading"><div><h3>{entry.symptom}</h3><p className="entry-status">{entry.ongoing ? <><span className="status-dot" /> Ongoing</> : `Resolved${entry.endedAt ? ` · ${displayDate(entry.endedAt, true)}` : ''}`}{entry.severity !== null && <> <span className="status-divider">/</span> Severity {entry.severity}/10</>}</p></div><div className="entry-actions"><button className="text-button" onClick={() => onEdit(entry)}>Edit</button><button className="icon-button delete-button" onClick={() => onDelete(entry)} aria-label={`Delete ${entry.symptom}`}><Trash2 size={17} /></button></div></div>
    {entry.details && <p className="entry-description">{entry.details}</p>}
    {entry.impact && <p className="entry-impact"><strong>Daily impact</strong> {entry.impact}</p>}
    {!compact && photos.length > 0 && <div className="entry-photos">{photos.map(photo => <figure key={photo.id}><BlobImage attachment={photo} /><figcaption>{photoDate(photo)} · {photo.name}</figcaption></figure>)}</div>}
    {!compact && audio.map(item => <div className="audio-item" key={item.id}><span><AudioLines size={16} /> Voice recording · {displayDate(item.capturedAt)}</span><BlobAudio attachment={item} /></div>)}
    {compact && (photos.length > 0 || audio.length > 0) && <p className="attachment-count">{photos.length > 0 && `${photos.length} photo${photos.length === 1 ? '' : 's'}`}{photos.length > 0 && audio.length > 0 && ' · '}{audio.length > 0 && `${audio.length} recording${audio.length === 1 ? '' : 's'}`}</p>}
  </article>;
}

function EntryEditor({ entry, consent, setConsent, onClose, onSave, saving, saveError }: {
  entry: Entry | null; consent: boolean; setConsent: (value: boolean) => void; onClose: () => void; onSave: (entry: Entry) => Promise<void>; saving: boolean; saveError: string;
}) {
  const [initial] = useState(() => ({
    symptom: entry?.symptom ?? '', details: entry?.details ?? '',
    startedAt: entry ? inputFromIso(entry.startedAt) : localInput(), ongoing: entry?.ongoing ?? true,
    endedAt: entry?.endedAt ? inputFromIso(entry.endedAt) : '', severity: entry?.severity?.toString() ?? '',
    impact: entry?.impact ?? '', attachments: entry?.attachments ?? [],
  }));
  const [symptom, setSymptom] = useState(initial.symptom);
  const [details, setDetails] = useState(initial.details);
  const detailsRef = useRef(initial.details);
  const [startedAt, setStartedAt] = useState(initial.startedAt);
  const [ongoing, setOngoing] = useState(initial.ongoing);
  const [endedAt, setEndedAt] = useState(initial.endedAt);
  const [severity, setSeverity] = useState(initial.severity);
  const [impact, setImpact] = useState(initial.impact);
  const [attachments, setAttachments] = useState<Attachment[]>(initial.attachments);
  const attachmentsRef = useRef(initial.attachments);
  const [message, setMessage] = useState('');
  const [recordingPhase, setRecordingPhaseState] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const recordingPhaseRef = useRef(recordingPhase);
  const [dictationPhase, setDictationPhaseState] = useState<'idle' | 'starting' | 'active' | 'stopping'>('idle');
  const dictationPhaseRef = useRef(dictationPhase);
  const leaseRef = useRef<MicrophoneLease | null>(null);
  const globalLease = useSyncExternalStore(subscribeMicrophone, microphoneSnapshot, () => null);
  const submittingRef = useRef(false);
  const mounted = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const supportsRecording = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const supportsDictation = typeof window !== 'undefined' && !!recognitionConstructor();
  const busyElsewhere = !!globalLease && globalLease !== leaseRef.current;
  const changed = symptom !== initial.symptom || details !== initial.details || startedAt !== initial.startedAt ||
    ongoing !== initial.ongoing || endedAt !== initial.endedAt || severity !== initial.severity || impact !== initial.impact ||
    attachments.length !== initial.attachments.length || attachments.some((item, index) => {
      const original = initial.attachments[index];
      return !original || item.id !== original.id || item.kind !== original.kind || item.name !== original.name ||
        item.mimeType !== original.mimeType || item.capturedAt !== original.capturedAt || item.blob !== original.blob;
    });
  const draftAtRisk = changed || recordingPhase === 'recording' || recordingPhase === 'stopping' || dictationPhase !== 'idle';
  useUnsavedWarning(draftAtRisk);

  function setRecordingPhase(phase: typeof recordingPhase) {
    recordingPhaseRef.current = phase;
    if (mounted.current) setRecordingPhaseState(phase);
  }
  function setDictationPhase(phase: typeof dictationPhase) {
    dictationPhaseRef.current = phase;
    if (mounted.current) setDictationPhaseState(phase);
  }
  function updateAttachments(update: (current: Attachment[]) => Attachment[]) {
    attachmentsRef.current = update(attachmentsRef.current);
    setAttachments(attachmentsRef.current);
  }
  function closeEditor() {
    if (saving || submittingRef.current) return;
    if (draftAtRisk && !window.confirm('Discard this unsaved entry draft?')) return;
    onClose();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const lease = leaseRef.current;
      if (!lease) return;
      lease.cancelled = true;
      leaseRef.current = null;
      if (lease.kind === 'recording') {
        stopTracks(lease.stream);
        if (lease.recorder) {
          try { if (lease.recorder.state !== 'inactive') lease.recorder.stop(); } catch { /* tracks are already stopped */ }
          if (lease.recorder.state === 'inactive') releaseMicrophone(lease);
        }
        // With no recorder yet, keep the lease until the pending permission settles.
      } else if (lease.recognition) {
        try { lease.recognition.abort(); } catch { /* retain the lease until onend */ }
        // Retain the lease until onend confirms the service stopped.
      } else releaseMicrophone(lease);
    };
  }, []);

  function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const accepted: Attachment[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (!allowed.includes(file.type)) { rejected.push(`${file.name}: use a JPEG, PNG, WebP or GIF`); continue; }
      if (file.size > 10 * 1024 * 1024 || file.size === 0) { rejected.push(`${file.name}: file must be between 1 byte and 10 MB`); continue; }
      accepted.push({ id: newId(), kind: 'photo', name: file.name, mimeType: file.type, capturedAt: '', blob: file });
    }
    updateAttachments(current => [...current, ...accepted]);
    setMessage(rejected.join(' · ') || (accepted.length ? 'Photo added. Its date is unknown until you enter one.' : ''));
    event.target.value = '';
  }

  async function startRecording() {
    if (saving || submittingRef.current || recordingPhaseRef.current !== 'idle' || dictationPhaseRef.current !== 'idle') return;
    setMessage('');
    if (!supportsRecording) { setMessage('Audio recording is not available in this browser. You can still type your note.'); return; }
    const lease = acquireMicrophone('recording');
    if (!lease) { setMessage('Another microphone request is still finishing. Please wait.'); return; }
    leaseRef.current = lease;
    setRecordingPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      lease.stream = stream;
      if (lease.cancelled || !mounted.current) { stopTracks(stream); releaseMicrophone(lease); return; }
      const recorder = new MediaRecorder(stream);
      lease.recorder = recorder;
      const chunks: BlobPart[] = [];
      const capturedAt = new Date().toISOString();
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        lease.failed = true;
        stopTracks(stream);
        if (mounted.current && leaseRef.current === lease) { setMessage('Recording stopped unexpectedly. Please try again.'); setRecordingPhase('stopping'); }
        try {
          if (recorder.state !== 'inactive') recorder.stop();
          else { if (leaseRef.current === lease) { leaseRef.current = null; setRecordingPhase('idle'); } releaseMicrophone(lease); }
        } catch {
          if (recorder.state === 'inactive') { if (leaseRef.current === lease) { leaseRef.current = null; setRecordingPhase('idle'); } releaseMicrophone(lease); }
        }
      };
      recorder.onstop = () => {
        stopTracks(stream);
        if (!lease.cancelled && !lease.failed && mounted.current && leaseRef.current === lease) {
          const mimeType = recorder.mimeType || 'audio/webm';
          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size) updateAttachments(current => [...current, { id: newId(), kind: 'audio', name: 'Voice recording', mimeType, capturedAt, blob }]);
          else setMessage('No audio was captured. Please try again.');
        }
        if (leaseRef.current === lease) { leaseRef.current = null; setRecordingPhase('idle'); }
        releaseMicrophone(lease);
      };
      recorder.start();
      if (!lease.failed && leaseRef.current === lease) setRecordingPhase('recording');
    } catch {
      lease.failed = true;
      stopTracks(lease.stream);
      try { if (lease.recorder && lease.recorder.state !== 'inactive') lease.recorder.stop(); } catch { /* wait for onstop if still active */ }
      if (!lease.recorder || lease.recorder.state === 'inactive') {
        if (leaseRef.current === lease) { leaseRef.current = null; setRecordingPhase('idle'); }
        releaseMicrophone(lease);
      } else if (leaseRef.current === lease) setRecordingPhase('stopping');
      if (mounted.current && !lease.cancelled) setMessage('Could not access the microphone. Check browser permissions or type your note instead.');
    }
  }
  function stopRecording() {
    const lease = leaseRef.current;
    if (recordingPhaseRef.current !== 'recording' || !lease?.recorder) return;
    setRecordingPhase('stopping');
    try { if (lease.recorder.state !== 'inactive') lease.recorder.stop(); }
    catch {
      lease.failed = true;
      stopTracks(lease.stream);
      if (lease.recorder.state === 'inactive') { leaseRef.current = null; releaseMicrophone(lease); setRecordingPhase('idle'); }
      setMessage('Could not finish the recording. Wait for the microphone to stop before trying again.');
    }
  }
  function startDictation() {
    if (saving || submittingRef.current || dictationPhaseRef.current !== 'idle' || recordingPhaseRef.current !== 'idle') return;
    setMessage('');
    if (!consent) { setMessage('Please opt in to browser dictation before starting.'); return; }
    const Constructor = recognitionConstructor();
    if (!Constructor) { setMessage('Dictation is not available in this browser. You can record audio or type instead.'); return; }
    const lease = acquireMicrophone('dictation');
    if (!lease) { setMessage('Another microphone request is still finishing. Please wait.'); return; }
    leaseRef.current = lease;
    setDictationPhase('starting');
    try {
      const recognition = new Constructor();
      lease.recognition = recognition;
      recognition.continuous = true; recognition.interimResults = false; recognition.lang = navigator.language || 'en-US';
      recognition.onstart = () => { if (!lease.cancelled && leaseRef.current === lease && dictationPhaseRef.current === 'starting') setDictationPhase('active'); };
      recognition.onresult = event => {
        if (lease.cancelled || !mounted.current || leaseRef.current !== lease) return;
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) if (event.results[i].isFinal) transcript += `${event.results[i][0].transcript} `;
        if (transcript.trim()) {
          const current = detailsRef.current;
          detailsRef.current = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${transcript.trim()}`;
          setDetails(detailsRef.current);
        }
      };
      recognition.onerror = event => { if (mounted.current) setMessage(`Dictation could not continue (${event.error}). You can edit or type your note.`); };
      recognition.onend = () => {
        if (leaseRef.current === lease) { leaseRef.current = null; setDictationPhase('idle'); }
        releaseMicrophone(lease);
      };
      recognition.start();
    } catch {
      if (leaseRef.current === lease) { leaseRef.current = null; setDictationPhase('idle'); }
      releaseMicrophone(lease);
      setMessage('Dictation could not start. Check browser permissions or type your note.');
    }
  }
  function stopDictation() {
    const lease = leaseRef.current;
    if ((dictationPhaseRef.current !== 'starting' && dictationPhaseRef.current !== 'active') || !lease?.recognition) return;
    setDictationPhase('stopping');
    try { lease.recognition.stop(); }
    catch {
      try { lease.recognition.abort(); } catch { /* remain blocked until onend */ }
      setMessage('Dictation is finishing. Wait for it to stop before saving.');
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || submittingRef.current) return;
    if (dictationPhaseRef.current !== 'idle' || microphoneLease?.kind === 'dictation') { setMessage('Stop dictation and wait for it to finish before saving; final words will be added.'); return; }
    if (recordingPhaseRef.current !== 'idle') { setMessage('Please stop the recording and wait for it to finish before saving.'); return; }
    if (!symptom.trim() || !startedAt) { setMessage('Please add what you noticed and when it began.'); return; }
    if (!ongoing && !endedAt) { setMessage('Please add when this resolved, or mark it as ongoing.'); return; }
    if (!ongoing && new Date(endedAt).getTime() < new Date(startedAt).getTime()) { setMessage('The resolved date must be after the start date.'); return; }
    const now = new Date().toISOString();
    submittingRef.current = true;
    try {
      await onSave({ id: entry?.id ?? newId(), symptom: symptom.trim(), details: detailsRef.current.trim(), startedAt: isoFromInput(startedAt), endedAt: ongoing ? null : isoFromInput(endedAt), ongoing, severity: severity === '' ? null : Number(severity), impact: impact.trim(), createdAt: entry?.createdAt ?? now, updatedAt: now, attachments: attachmentsRef.current, demo: entry?.demo ?? false });
    } finally { submittingRef.current = false; }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeEditor(); }}>
    <section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <div className="editor-header"><div><span className="eyebrow">YOUR JOURNAL</span><h2 id="editor-title">{entry ? 'Edit this moment' : 'Make a note of it'}</h2><p>There’s no detail too small. Capture what feels important to you.</p></div><button className="icon-button close-button" onClick={closeEditor} disabled={saving} aria-label="Close entry form"><X size={22} /></button></div>
      <form onSubmit={submit} className="editor-form">
        <fieldset disabled={saving} style={{ display: 'contents' }}>
        {entry?.demo && <div className="notice soft-notice">This is a fictional demo entry. Edits remain labeled as demo.</div>}
        <label className="field"><span>What did you notice? <b>*</b></span><input autoFocus value={symptom} onChange={event => setSymptom(event.target.value)} placeholder="e.g. A headache, a skin change…" maxLength={160} required /></label>
        <label className="field"><span>Tell your story <small>OPTIONAL</small></span><textarea rows={4} value={details} onChange={event => { detailsRef.current = event.target.value; setDetails(event.target.value); }} placeholder="Describe what you felt or saw, including when any visible changes appeared or changed." /><small className="field-hint">Visible symptoms may look different across skin tones. Describe them in your own words; photos are not analyzed.</small></label>
        <div className="voice-box"><div className="voice-heading"><div className="round-icon coral"><Mic size={19} /></div><div><strong>Prefer to use your voice?</strong><p>Record an audio note on this device or choose browser dictation.</p></div></div>
          <div className="voice-actions"><button type="button" className={`button button-outline small ${recordingPhase === 'recording' ? 'recording' : ''}`} onClick={recordingPhase === 'recording' ? stopRecording : startRecording} disabled={!supportsRecording || saving || recordingPhase === 'starting' || recordingPhase === 'stopping' || (recordingPhase === 'idle' && (busyElsewhere || dictationPhase !== 'idle'))}>{recordingPhase === 'recording' ? <Square size={15} /> : <Mic size={15} />}{recordingPhase === 'starting' ? 'Starting…' : recordingPhase === 'stopping' ? 'Finishing…' : recordingPhase === 'recording' ? 'Stop recording' : 'Record audio'}</button>
            <button type="button" className="button button-outline small" onClick={dictationPhase === 'active' ? stopDictation : startDictation} disabled={!supportsDictation || saving || dictationPhase === 'starting' || dictationPhase === 'stopping' || (dictationPhase === 'idle' && (!consent || busyElsewhere || recordingPhase !== 'idle'))}>{dictationPhase === 'active' ? <Square size={15} /> : <AudioLines size={16} />}{dictationPhase === 'starting' ? 'Starting dictation…' : dictationPhase === 'stopping' ? 'Finishing dictation…' : dictationPhase === 'active' ? 'Stop dictation' : 'Start dictation'}</button></div>
          <label className="check-row consent-check"><input type="checkbox" checked={consent} onChange={event => { setConsent(event.target.checked); if (!event.target.checked) stopDictation(); }} /><span>I opt in to dictation this session. My browser may send audio to its provider for processing.</span></label>
          {dictationPhase !== 'idle' && <p className="form-message" role="status">Stop dictation and wait until it finishes before saving. Final words will be added to your note. If it never finishes, copy your draft before reloading the page.</p>}
          {recordingPhase === 'stopping' && <p className="form-message" role="status">Waiting for the recording to finish. If it never finishes, copy your draft before reloading the page.</p>}
          {busyElsewhere && <p className="form-message" role="status">A previous microphone request is still finishing. Resolve any permission prompt and wait; if it never finishes, copy any drafts before reloading the page.</p>}
          <p className="voice-fine">{!supportsRecording ? 'Audio recording is unavailable in this browser. ' : ''}{!supportsDictation ? 'Browser dictation is unavailable here; use recording or type instead. ' : ''}Dictated text is editable. Audio-only recordings are not analyzed or described in the summary.</p>
        </div>
        <div className="form-grid"><label className="field"><span>When did it begin? <b>*</b></span><input type="datetime-local" required value={startedAt} onChange={event => setStartedAt(event.target.value)} /></label><div className="field"><span>Is it still happening?</span><div className="segmented"><button type="button" className={ongoing ? 'selected' : ''} onClick={() => setOngoing(true)}>Ongoing</button><button type="button" className={!ongoing ? 'selected' : ''} onClick={() => setOngoing(false)}>Resolved</button></div></div></div>
        {!ongoing && <label className="field"><span>When did it resolve? <b>*</b></span><input type="datetime-local" required value={endedAt} onChange={event => setEndedAt(event.target.value)} /></label>}
        <div className="form-grid"><label className="field"><span>Severity <small>OPTIONAL</small></span><select value={severity} onChange={event => setSeverity(event.target.value)}><option value="">Choose from 0–10</option>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}{i === 0 ? ' — no severity' : i === 10 ? ' — most severe' : ''}</option>)}</select></label><label className="field"><span>Impact on your day <small>OPTIONAL</small></span><input value={impact} onChange={event => setImpact(event.target.value)} placeholder="e.g. Made it hard to sleep" /></label></div>
        <div className="photo-section"><div className="section-title-row"><div><span className="field-label">Add a photo <small>OPTIONAL</small></span><p>Only if you’re comfortable. Do not add sensitive or intimate images to this prototype.</p></div><ImagePlus size={21} /></div><div className="voice-actions"><button type="button" className="button button-outline small" onClick={() => fileRef.current?.click()}><ImagePlus size={16} /> Choose photos</button><button type="button" className="button button-outline small" onClick={() => cameraRef.current?.click()}><Camera size={16} /> Use camera</button></div><input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="visually-hidden" onChange={addPhotos} /><input ref={cameraRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" capture="environment" className="visually-hidden" onChange={addPhotos} /><p className="voice-fine">JPEG, PNG, WebP or GIF, up to 10 MB each. Photos are stored in this browser and shared only if you choose. The capture date is optional: leave it blank if unknown. New photo dates do not use metadata or the date added. Older saved dates may have defaulted to the date added; please verify or clear them.</p></div>
        {attachments.length > 0 && <div className="editor-attachments">{orderedAttachments(attachments).map(item => <div className="editor-attachment" key={item.id}>{item.kind === 'photo' ? <BlobImage attachment={item} /> : <div className="audio-thumb"><AudioLines size={23} /></div>}<div className="attachment-detail"><strong>{item.name}</strong>{item.kind === 'photo' ? <label>Photo date (optional; leave blank if unknown) <input type="datetime-local" value={inputFromIso(item.capturedAt)} onChange={event => { const value = event.target.value; updateAttachments(current => current.map(a => a.id === item.id ? { ...a, capturedAt: value ? isoFromInput(value) : '' } : a)); }} /></label> : <><span>Recorded {displayDate(item.capturedAt, true)}</span><BlobAudio attachment={item} /></>}</div><button type="button" className="icon-button" onClick={() => updateAttachments(current => current.filter(a => a.id !== item.id))} aria-label={`Remove ${item.name}`}><X size={18} /></button></div>)}</div>}
        {message && <p className="form-message" role="status">{message}</p>}
        {saveError && <p className="form-message" role="alert">{saveError}</p>}
        <div className="editor-footer"><span><LockKeyhole size={15} /> Saved in this browser only</span><div><button type="button" className="button button-plain" onClick={closeEditor} disabled={saving}>Cancel</button><button type="submit" className="button button-dark" disabled={saving || recordingPhase !== 'idle' || dictationPhase !== 'idle' || globalLease?.kind === 'dictation'}>{saving ? 'Saving…' : entry ? 'Save changes' : 'Save entry'} <ArrowRight size={16} /></button></div></div>
        </fieldset>
      </form>
    </section>
  </div>;
}

function HistoryEditor({ history, onSave, saving }: { history: PatientHistory; onSave: (history: PatientHistory) => Promise<void>; saving: boolean }) {
  const [draft, setDraft] = useState(history);
  const [saved, setSaved] = useState(false);
  const changed = (Object.keys(emptyHistory) as (keyof PatientHistory)[]).some(key => draft[key] !== history[key]);
  useUnsavedWarning(changed);
  const field = (key: keyof PatientHistory, value: string | boolean) => { setSaved(false); setDraft(current => ({ ...current, [key]: value })); };
  async function submit(event: FormEvent) { event.preventDefault(); try { await onSave(draft); setSaved(true); } catch { setSaved(false); } }
  return <form className="history-form surface" onSubmit={submit}>
    <div className="form-intro"><div><span className="eyebrow">THE BIGGER PICTURE</span><h2>A little context goes a long way.</h2><p>Add what you’d like your provider to know. Everything here is optional and can be edited anytime.</p></div><div className="round-icon sage"><BookHeart size={21} /></div></div>
    <label className="field"><span>Relevant health history</span><textarea rows={3} value={draft.conditions} onChange={e => field('conditions', e.target.value)} placeholder="Conditions, past experiences, or anything else you'd like to mention" /></label>
    <label className="field"><span>Medications &amp; supplements</span><textarea rows={3} value={draft.medications} onChange={e => field('medications', e.target.value)} placeholder="Names, doses, or recent changes" /></label>
    <label className="field"><span>Test results</span><textarea rows={3} value={draft.tests} onChange={e => field('tests', e.target.value)} placeholder="Results or dates you want to discuss" /><small className="field-hint">A negative ANA does not rule out every condition. A provider can help interpret your results.</small></label>
    <label className="field"><span>Questions for your provider</span><textarea rows={3} value={draft.questions} onChange={e => field('questions', e.target.value)} placeholder="What would you like to ask at your next visit?" /></label>
    <div className="esr-box"><div className="section-title-row"><div><span className="eyebrow">OPTIONAL CONTEXT</span><h3>A note about ESR</h3></div><Info size={20} /></div><p>Some red blood cell characteristics and hemoglobin disorders may affect ESR interpretation. If relevant, you can add a patient-confirmed note for your provider—not a diagnosis.</p><label className="field"><span>Hemoglobin or blood history <small>OPTIONAL</small></span><textarea rows={2} value={draft.bloodHistory} onChange={e => field('bloodHistory', e.target.value)} required={draft.includeEsrNote} placeholder="Only what you wish to share" /><small className="field-hint">Add blood history above if you choose to include the ESR note.</small></label><label className="check-row"><input type="checkbox" checked={draft.includeEsrNote} onChange={e => field('includeEsrNote', e.target.checked)} /><span>I confirm a hemoglobin disorder is relevant to my history and want to include a cautious ESR context note.</span></label><a href="https://www.aafp.org/pubs/afp/issues/1999/1001/p1443.html" target="_blank" rel="noreferrer">Read the ESR reference <ArrowRight size={14} /></a></div>
    <div className="form-bottom"><span>{saved && !changed ? 'Changes saved on this browser.' : 'Your history stays on this browser.'}</span><button className="button button-dark" disabled={saving} type="submit">{saving ? 'Saving…' : 'Save history'} <ArrowRight size={16} /></button></div>
  </form>;
}

function Prepare({ entries, history }: { entries: Entry[]; history: PatientHistory }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [summary, setSummary] = useState('');
  const [generated, setGenerated] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState('');
  const selectedEntries = sorted(entries).filter(entry => selected.includes(entry.id));
  const availablePhotos = sortedPhotos(selectedEntries.flatMap(entry => entry.attachments.filter(item => item.kind === 'photo')));
  const selectedPhotos = availablePhotos.filter(item => photos.includes(item.id));
  const photoEntry = (photo: Attachment) => selectedEntries.find(entry => entry.attachments.some(item => item.id === photo.id));
  useUnsavedWarning(generated);
  useEffect(() => { if (generated) setStale(true); }, [entries, history]);
  function toggleEntry(id: string) {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    setStale(generated); setMessage('');
  }
  function togglePhoto(id: string) { setPhotos(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); setStale(generated); setMessage(''); }
  function generate() {
    if (!selectedEntries.length) { setMessage('Select at least one entry to prepare your summary.'); return; }
    if (generated && !window.confirm('Regenerating will replace the current summary, including any edits. Continue?')) return;
    const labeledEntries = selectedEntries.map(entry => ({ ...entry, symptom: entry.demo ? `[FICTIONAL DEMO] ${entry.symptom}` : entry.symptom, attachments: orderedAttachments(entry.attachments) }));
    // Report photos separately in global capture-date order rather than grouping them by symptom onset.
    const photoLines = selectedPhotos.map(photo => {
      const owner = photoEntry(photo);
      return `  Selected photo: ${photo.name.trim() || 'Not provided'}; reported capture date: ${reportedDate(photo.capturedAt)}; entry: ${owner?.demo ? '[FICTIONAL DEMO] ' : ''}${owner?.symptom ?? 'Not provided'}`;
    });
    setSummary(`${makeSummary(labeledEntries, history, [])}${photoLines.length ? `\n\nPatient-selected photos (ordered by reported capture date; unknown last):\n${photoLines.join('\n')}` : ''}`); setGenerated(true); setStale(false); setMessage('');
  }
  async function copy() {
    try { await navigator.clipboard.writeText(summary); setMessage('Summary text copied. Photos are not included in the clipboard.'); }
    catch { setMessage('Could not copy automatically. Select the text and copy it manually.'); }
  }
  async function share() {
    if (!navigator.share) { setMessage('Sharing is not available in this browser. Copy the text or print instead.'); return; }
    try {
      const files = selectedPhotos.map(photo => new File([photo.blob], photo.name, { type: photo.mimeType }));
      const canShareFiles = files.length > 0 && !!navigator.canShare?.({ files });
      if (files.length && !canShareFiles && !window.confirm('This browser cannot share the selected photos with the text. Continue sharing text only? You can attach photos separately or print instead.')) return;
      await navigator.share({ title: 'My Symptom Trail visit summary', text: summary, ...(canShareFiles ? { files } : {}) });
      setMessage(canShareFiles ? 'Share sheet opened with the selected photos.' : 'Share sheet opened with summary text only.');
    } catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) setMessage('Could not open sharing. Try copying or printing instead.'); }
  }
  return <div className="prepare-layout"><div className="prepare-main">
    <div className="surface selection-card"><div className="section-header"><div><span className="eyebrow">STEP 01</span><h2>Choose what to include.</h2><p>Select the moments you’d like to talk about. You’re always in control.</p></div><span className="count-badge">{selected.length} selected</span></div>
      {entries.length === 0 ? <div className="small-empty"><CalendarDays size={22} /><p>Your entries will appear here once you’ve added them.</p></div> : <div className="selection-list">{sorted(entries).map(entry => <div className="selection-entry" key={entry.id}><label className="selection-label"><input type="checkbox" checked={selected.includes(entry.id)} onChange={() => toggleEntry(entry.id)} /><span><strong>{entry.symptom} {entry.demo && <em>FICTIONAL DEMO</em>}</strong><small>{displayDate(entry.startedAt)} · {entry.ongoing ? 'Ongoing' : 'Resolved'}</small></span></label></div>)}</div>}
      {availablePhotos.length > 0 && <div><p className="selection-footnote">Choose photos from selected entries. Known capture dates come first; unknown dates are last. Older saved dates may be dates added; check or clear uncertain dates in the entry before sharing.</p>{availablePhotos.map(photo => <label className="photo-select" key={photo.id}><input type="checkbox" checked={photos.includes(photo.id)} onChange={() => togglePhoto(photo.id)} /><BlobImage attachment={photo} /><span>Include photo from {photoEntry(photo)?.demo ? '[FICTIONAL DEMO] ' : ''}{photoEntry(photo)?.symptom}<br /><small>{photoDate(photo)} · {photo.name}</small></span></label>)}</div>}
      <button className="button button-dark generate-button" onClick={generate} disabled={selected.length === 0}>{generated ? 'Regenerate summary' : 'Create visit summary'} <ArrowRight size={16} /></button>
      <p className="selection-footnote">Your saved history and provider questions are included when present. Audio recordings are not transcribed or analyzed.</p>
    </div>
    {generated && <div className="surface summary-card"><div className="section-header"><div><span className="eyebrow">STEP 02</span><h2>Make it yours.</h2><p>Review and edit the text before you decide what to share.</p></div><div className="round-icon sage"><FileText size={20} /></div></div>{stale && <div className="notice">Your selection or saved data changed. Regenerate to update the text before sharing; this will replace your edits.</div>}<label className="field"><span>Visit summary</span><textarea className="summary-text" value={summary} onChange={event => setSummary(event.target.value)} rows={14} /></label>{selectedPhotos.length > 0 && <div className="summary-photos"><span className="field-label">Selected photos</span><div>{selectedPhotos.map(photo => <figure key={photo.id}><BlobImage attachment={photo} /><figcaption>{photoDate(photo)}</figcaption></figure>)}</div></div>}<div className="summary-actions"><button className="button button-dark" onClick={copy} disabled={stale}><Copy size={16} /> Copy text</button><button className="button button-outline" onClick={share} disabled={stale}><Share2 size={16} /> Share</button><button className="button button-outline" onClick={() => window.print()} disabled={stale}><Printer size={16} /> Print</button></div><p className="selection-footnote">Copy includes text only. Print includes selected photos. Sharing photos depends on your browser; review recipients and content before sharing. Nothing is sent automatically.</p></div>}
    {message && <p className="form-message" role="status">{message}</p>}
  </div><aside className="prepare-aside"><div className="tip-card"><div className="round-icon coral"><Sparkles size={19} /></div><span className="eyebrow">A THOUGHTFUL VISIT</span><h3>Let the important things lead.</h3><p>A few notes can help you remember patterns, changes, and the questions you don’t want to forget.</p><div className="tip-rule" /><p className="tip-small">This summary is for conversation, not a diagnosis. Only share it with someone you trust.</p></div></aside>
  {generated && <div className="print-only"><h1>Symptom Trail · Visit summary</h1><p>Prepared by the patient. Please review together with a healthcare professional.</p><div className="print-summary">{summary}</div>{selectedPhotos.length > 0 && <><h2>Patient-selected photos</h2><div className="print-photos">{selectedPhotos.map(photo => <figure key={photo.id}><BlobImage attachment={photo} /><figcaption>{photo.name} · Photo date: {photoDate(photo, true)}</figcaption></figure>)}</div></>}</div>}
  </div>;
}

function App() {
  const [page, setPage] = useState<Page>('today');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<PatientHistory>({ ...emptyHistory });
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState<Entry | null | undefined>(undefined);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState('');
  const [draftVersion, setDraftVersion] = useState(0);

  async function load() {
    setLoading(true); setReadError('');
    try { const [loadedEntries, loadedHistory] = await Promise.all([listEntries(), readHistory()]); setEntries(loadedEntries); setHistory(loadedHistory ?? { ...emptyHistory }); }
    catch { setReadError('We couldn’t open your journal on this browser. Please check browser storage settings and try again.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function saveEntry(entry: Entry) {
    setSaving(true); setSaveError('');
    try { await putEntry(entry); setEntries(current => sorted([...current.filter(item => item.id !== entry.id), entry])); setEditor(undefined); setNotice(entry.demo ? 'Fictional demo entry saved.' : 'Your entry has been saved on this browser.'); }
    catch { setSaveError('Your entry could not be saved. Your form is still open; check browser storage and try again.'); }
    finally { setSaving(false); }
  }
  async function saveHistory(next: PatientHistory) {
    setSaving(true); setSaveError('');
    try { await writeHistory(next); setHistory(next); setNotice('Your history has been saved on this browser.'); }
    catch { setSaveError('Your history could not be saved. Please check browser storage and try again.'); throw new Error('History save failed'); }
    finally { setSaving(false); }
  }
  async function removeEntry(entry: Entry) {
    if (!window.confirm(`Delete “${entry.symptom}” and its attachments from this browser? This cannot be undone.`)) return;
    setSaveError('');
    try { await deleteEntry(entry.id); setEntries(current => current.filter(item => item.id !== entry.id)); setNotice('Entry deleted from this browser.'); }
    catch { setSaveError('This entry could not be deleted. Please try again.'); }
  }
  async function removeAll() {
    if (!window.confirm('Delete ALL entries, photos, recordings, and history from this browser, and discard any unsaved history and visit-summary drafts? This cannot be undone.')) return;
    setSaving(true); setSaveError('');
    try { await clearJournal(); setEntries([]); setHistory({ ...emptyHistory }); setDraftVersion(current => current + 1); setNotice('Your journal and history were cleared from this browser.'); setPage('today'); }
    catch { setSaveError('The journal could not be cleared. Please try again.'); }
    finally { setSaving(false); }
  }
  async function addDemo() {
    if (entries.some(entry => entry.demo)) { setNotice('Fictional demo entries are already in your journal.'); return; }
    const now = new Date();
    const earlier = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const later = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const examples: Entry[] = [
      { id: newId(), symptom: 'Afternoon headache', details: 'Fictional example: A dull headache started after lunch and eased after some rest.', startedAt: earlier.toISOString(), endedAt: new Date(earlier.getTime() + 3 * 60 * 60 * 1000).toISOString(), ongoing: false, severity: 4, impact: 'Took a break from reading.', createdAt: earlier.toISOString(), updatedAt: earlier.toISOString(), attachments: [], demo: true },
      { id: newId(), symptom: 'A change I noticed', details: 'Fictional example: Noticed a small area of irritation in the evening. It looked a little different the next morning.', startedAt: later.toISOString(), endedAt: null, ongoing: true, severity: 2, impact: '', createdAt: later.toISOString(), updatedAt: later.toISOString(), attachments: [], demo: true },
    ];
    setSaving(true); setSaveError('');
    try { for (const example of examples) await putEntry(example); setEntries(current => sorted([...current, ...examples])); setNotice('Two clearly labeled fictional examples were added. You can remove them anytime.'); }
    catch { setSaveError('Could not add all demo entries. Reload to see any that were saved.'); try { setEntries(await listEntries()); } catch { /* keep the visible data */ } }
    finally { setSaving(false); }
  }
  async function removeDemo() {
    const demos = entries.filter(entry => entry.demo);
    if (!demos.length || !window.confirm('Remove all fictional demo entries and their attachments? Your other entries will stay.')) return;
    setSaving(true); setSaveError('');
    try { for (const item of demos) await deleteEntry(item.id); setEntries(current => current.filter(item => !item.demo)); setNotice('Fictional demo entries removed.'); }
    catch { setSaveError('Could not remove all demo entries. Please try again.'); try { setEntries(await listEntries()); } catch { /* keep the visible data */ } }
    finally { setSaving(false); }
  }
  const sortedEntries = sorted(entries);
  const hasDemo = entries.some(entry => entry.demo);
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  function goPage(next: Page) { setPage(next); setNotice(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  return <div className="app-shell">
    <Navigation page={page} setPage={goPage} />
    <div className="mobile-brand"><div className="brand"><Mark /><div><strong>Symptom Trail</strong><span>Make the moments count</span></div></div><span className="mobile-brand-icon"><Heart size={18} /></span></div>
    <main className="main-shell">
      <div className="emergency-banner"><span className="emergency-icon">!</span><p><strong>Need urgent help?</strong> Severe difficulty breathing or swallowing, or sudden swelling of the lips, tongue, or throat: <strong>call emergency services.</strong> This app is not monitored.</p></div>
      <div className="prototype-banner"><LockKeyhole size={13} /> Prototype only · Use fictional data, not real personal or protected health information.</div>
      <div className="content-wrap">
        <div className="topline"><span>{page === 'today' ? 'YOUR PERSONAL JOURNAL' : 'YOUR PERSONAL JOURNAL'} <span className="topline-slash">/</span> <strong>{pageLabels[page].toUpperCase()}</strong></span><span className="top-date"><CalendarDays size={15} /> {today}</span></div>
        {loading ? <div className="loading-state"><div className="loading-spinner" /><h2>Opening your journal…</h2><p>Your moments are stored on this browser.</p></div> : readError ? <div className="surface error-state"><Info size={24} /><h2>We couldn’t open your journal.</h2><p>{readError}</p><button className="button button-dark" onClick={() => void load()}>Try again</button></div> : <>
          {notice && <div className="toast" role="status"><CheckCircle2 size={17} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={16} /></button></div>}
          {saveError && <div className="error-banner" role="alert"><Info size={18} />{saveError}<button onClick={() => setSaveError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
          {page === 'today' && <>
            <div className="page-heading today-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> A SPACE FOR YOU</span><h1>Every little detail<br /><em>deserves a place.</em></h1><p>Capture what you’re experiencing, notice your own patterns, and feel a little more prepared for what’s next.</p><button className="button button-dark primary-cta" onClick={() => setEditor(null)}><Plus size={18} /> Add an entry <ArrowRight size={17} /></button></div><div className="heading-art" aria-hidden="true"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="art-center"><Activity size={48} strokeWidth={1.05} /></div><span className="art-star art-star-one">✳</span><span className="art-star art-star-two">✳</span><span className="art-caption">A LITTLE AT A TIME</span></div></div>
            <div className="dashboard-grid"><div className="dashboard-main">
              <div className="section-header journal-header"><div><span className="eyebrow">YOUR MOMENTS, IN ORDER</span><h2>From your journal <span className="heading-period">.</span></h2></div><button className="arrow-link" onClick={() => goPage('timeline')}>View timeline <ArrowRight size={16} /></button></div>
              {sortedEntries.length ? <div className="recent-list">{sortedEntries.slice(0, 3).map(entry => <EntryCard key={entry.id} entry={entry} onEdit={setEditor} onDelete={removeEntry} compact />)}</div> : <div className="empty-journal"><div className="empty-illustration"><span className="empty-line line-one" /><span className="empty-line line-two" /><div className="empty-icon"><BookHeart size={28} strokeWidth={1.3} /></div><span className="empty-spark">✳</span></div><div><span className="eyebrow">A FRESH START</span><h3>Your story starts here.</h3><p>Some days are hard to put into words. Start with whatever you remember—we’ll keep it together for you.</p><button className="arrow-link" onClick={() => setEditor(null)}>Write your first entry <ArrowRight size={16} /></button></div></div>}
              {!hasDemo && <div className="demo-row"><div><Sparkles size={17} /><span><strong>Want to look around first?</strong> Try two clearly fictional examples.</span></div><button className="text-button" onClick={() => void addDemo()} disabled={saving}>Load demo entries <ArrowRight size={15} /></button></div>}
              {hasDemo && <div className="demo-row"><div><Sparkles size={17} /><span>These labeled examples are fictional, not patient data.</span></div><button className="text-button" onClick={() => void removeDemo()} disabled={saving}>Remove demo entries <ArrowRight size={15} /></button></div>}
              </div><aside className="dashboard-aside"><div className="aside-card next-visit-card"><div className="aside-top"><div className="round-icon coral"><ClipboardList size={20} /></div><ArrowDownRight size={19} /></div><span className="eyebrow">WHEN YOU’RE READY</span><h3>Make the most of your next visit.</h3><p>Bring your notes, photos, and questions together in one thoughtful summary.</p><button className="arrow-link" onClick={() => goPage('prepare')}>Prepare a visit <ArrowRight size={16} /></button></div><div className="aside-card privacy-card"><div className="aside-top"><div className="round-icon sage"><ShieldCheck size={20} /></div><span className="privacy-mini">JUST FOR YOU</span></div><h3>Your story, your space.</h3><p>Entries, photos and recordings are saved in this browser until you choose to share them. Nothing is automatically sent to a provider.</p><button className="arrow-link" onClick={() => goPage('history')}>More about your space <ArrowRight size={16} /></button></div></aside></div>
          </>}
          {page === 'timeline' && <><div className="page-heading standard-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> YOUR MOMENTS</span><h1>Your story, <em>over time.</em></h1><p>A little context can make the bigger picture clearer. Here’s everything you’ve chosen to keep.</p></div><button className="button button-dark" onClick={() => setEditor(null)}><Plus size={18} /> Add an entry</button></div><div className="timeline-layout"><div><div className="list-heading"><div><span className="eyebrow">THE TIMELINE</span><h2>All your entries <span className="heading-period">.</span></h2></div><span className="count-badge">{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span></div>{sortedEntries.length ? <div className="timeline-list">{sortedEntries.map(entry => <EntryCard key={entry.id} entry={entry} onEdit={setEditor} onDelete={removeEntry} />)}</div> : <div className="empty-journal timeline-empty"><div className="empty-illustration"><div className="empty-icon"><CalendarDays size={28} strokeWidth={1.3} /></div></div><div><h3>There’s room for your story.</h3><p>When you add an entry, it will appear here in chronological order.</p><button className="arrow-link" onClick={() => setEditor(null)}>Add your first entry <ArrowRight size={16} /></button></div></div>}{hasDemo && <div className="demo-row"><div><Sparkles size={17} /><span>Demo entries are clearly labeled as fictional.</span></div><button className="text-button" onClick={() => void removeDemo()} disabled={saving}>Remove demo entries</button></div>}</div><aside><div className="tip-card timeline-tip"><div className="round-icon sage"><Activity size={20} /></div><span className="eyebrow">A GENTLE REMINDER</span><h3>There’s no perfect way to keep a journal.</h3><p>Ongoing, intermittent, or resolved—each moment you record can help tell your story.</p></div></aside></div></>}
          <div hidden={page !== 'prepare'}><div className="page-heading standard-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> FOR THE CONVERSATION AHEAD</span><h1>Walk in feeling <em>prepared.</em></h1><p>Gather what matters to you, then make it your own before sharing.</p></div></div><Prepare key={draftVersion} entries={entries} history={history} /></div>
          <div hidden={page !== 'history'}><div className="page-heading standard-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> YOUR HEALTH, IN CONTEXT</span><h1>More of <em>your story.</em></h1><p>A place for the history and questions you’d like to bring into the conversation.</p></div></div><div className="history-layout"><HistoryEditor key={draftVersion} history={history} onSave={saveHistory} saving={saving} /><aside><div className="tip-card"><div className="round-icon sage"><LockKeyhole size={20} /></div><span className="eyebrow">YOUR PRIVACY</span><h3>Made to stay with you.</h3><p>Entries, history, photos and audio are stored in this browser’s local IndexedDB. They are not synced or encrypted by this prototype. Clearing browser or site data may permanently erase them. This prototype offers no security guarantee.</p><p className="tip-small">Prototype only: use synthetic data, never real personal or protected health information. Browser dictation is optional and may send audio to its provider.</p><div className="tip-rule" /><button className="danger-link" onClick={() => void removeAll()} disabled={saving}><Trash2 size={16} /> Clear all journal data</button></div></aside></div></div>
          <div className="page-footer"><div><Mark /><span><strong>Symptom Trail</strong><small>Make the moments count</small></span></div><p>For reflection, not diagnosis. This prototype is not for real health information.<br /><a className="source-link" href="https://github.com/fullSDak/symptom-journal" target="_blank" rel="noopener noreferrer">View source on GitHub <ArrowRight size={12} /></a></p></div>
        </>}
      </div>
    </main>
    {editor !== undefined && <EntryEditor entry={editor} consent={consent} setConsent={setConsent} onClose={() => { setEditor(undefined); setSaveError(''); }} onSave={saveEntry} saving={saving} saveError={saveError} />}
  </div>;
}

export default App;
