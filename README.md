# Symptom Trail

A mobile-friendly, patient-authored symptom journal prototype. Log fictional symptoms and dates, add optional photos or audio recordings, keep a timeline and prepare an editable summary for a conversation with a clinician. It is a rules-based journal, not an AI diagnostic tool or a monitored messaging channel.

**Prototype only: use fictional information, not real personal information or protected health information.** It is not designed or verified for medical care, HIPAA compliance, emergencies or secure health records. Do not add intimate images. No clinician is automatically contacted.

## Problem statement

People living with chronic or hard-to-diagnose conditions often experience symptoms that come and go over days or weeks. By the time they see a healthcare provider, they may struggle to remember when symptoms began, how they changed, or how they affected daily life. Visible changes may also look different across skin tones or have disappeared by the appointment.

Patients need a simple way to capture symptoms, photos, and voice notes as they occur, then prepare a clear, patient-reviewed summary for their provider. The goal is to support a more complete conversation—not to diagnose a condition or assume that one test result tells the whole story.

## Run locally

Use Node.js and the pinned pnpm version in `package.json`:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm build
corepack pnpm dev
```

The fictional demo entries are optional and visibly labeled. Patients can record onset, resolution, severity and impact, as well as conditions, medications, test results and questions. Photo dates are optional and remain unknown unless entered; the app does not infer them from image metadata. Selected entries and photos appear in the editable appointment summary. Copy copies text only; printing includes the selected photos; a device's share sheet may attach photos if supported, and otherwise asks before sharing text alone. Review the recipient and all contents before sharing.

## Voice and privacy

Journal data, photographs and recordings are kept in this browser's IndexedDB, without app-level encryption or sync. Clearing site data or losing access to the device can erase them. This is not a security guarantee. Files and text intentionally shared or printed leave the browser under the user's control.

Recording audio is separate from browser speech recognition: recordings are not transcribed or analyzed. Browser dictation is optional, may send audio to the browser's service provider, and is available only after the patient opts in for the current session. Microphone, photo, dictation, print and file-sharing support depend on the device and browser. In the Manus Preview, platform site analytics are disabled; this is not a claim that all platform or badge analytics are disabled.

## Clinical boundaries

The tool records patient observations and does not diagnose or infer the meaning of photos, symptoms or tests. A negative ANA does not rule out every condition; visible changes may appear differently across skin tones. A patient may opt into a cautious ESR context note after supplying relevant blood history; it does not assert that a hemoglobin disorder or target cells always make ESR unreliable. See [clinical safety and references](CLINICAL_SAFETY.md).

For severe difficulty breathing or swallowing, or sudden swelling of the lips, tongue or throat, call local emergency services. This application is not monitored.

## Build provenance

This prototype was scoped by a human and developed with assistance from Manus AI agents. The included examples are fictional. Testing does not establish clinical or production readiness.
