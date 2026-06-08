# Voice Dialogue

Hermes Web UI now supports turn-based voice input inside the existing chat UI. The current design is intentionally simple: record one voice turn, transcribe it, place the transcript into the chat input for review/editing, and let the user send it with the normal Send button.

## What works today

- Voice output / TTS: assistant replies can be spoken with the existing message playback stack. Server-backed providers are supported through the Web UI backend, and browser Web Speech remains available as a local playback option.
- Voice input / STT: choose browser speech recognition when the browser supports it, or use a server-backed provider from Settings → Voice.
- Dialogue flow: use the mic button in chat for push-to-talk / click-to-record style turns. Start capture, stop capture, transcribe the audio, and stage the transcript in the current input box so the user can edit before sending.
- Turn-based behavior: this is a half-duplex flow. One capture turn becomes one editable draft; sending remains an explicit user action.

## Settings at a glance

- TTS settings are provider-based. Depending on the provider, you may configure items such as model, voice, speed, pitch, base URL, and authentication.
- STT settings are also provider-based. Depending on the provider, you may configure model, optional language hint, optional prompt, optional base URL, and authentication.
- Browser STT uses the browser's own speech recognition when available. Server-backed STT sends a one-shot audio upload to the backend for transcription.

## Barge-in and cancellation

- If assistant audio is already playing, starting a new voice capture stops that audio first.
- This barge-in boundary is about playback only. It does not silently cancel an in-flight agent run.
- Cancelling an active run remains explicit. Use the normal stop/abort controls, or another explicit cancel action exposed by the chat session.

## Security and privacy

- Provider keys are stored server-side.
- The browser only receives masked key status for configured providers.
- Raw provider secrets are not stored in localStorage.
- Captured microphone audio is one-shot: it is used for a single transcription request rather than a persistent call or background recording stream.

## Current non-goals / future work

The current Web UI voice dialogue does not yet include:

- telephony or call flows
- always-on wake-word listening
- native desktop overlays
- realtime full-duplex voice sessions with simultaneous listen/speak behavior

Those are future areas, but they are outside the current Web UI voice dialogue scope.