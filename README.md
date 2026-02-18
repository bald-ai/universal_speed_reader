# Traycer Speed Reader

A speed reading application.

## Android Back Button

- On reader routes, hardware back navigates to the previous in-app screen (or to home when there is no browser history entry).
- On home (`/`), hardware back exits the app.

## TTS Pronunciation Rules (Regex)

The reader settings now include a pronunciation rule manager for live TTS playback.

- Rules are local-only and do not modify stored book text.
- Scope order is `Global` then `This Book`.
- Rule order is top-to-bottom with first-match-wins behavior.
- Matching mode can be switched between `Token` and `Full chunk`.
- Saving a rule always shows preview stats and examples before confirmation.

## Android Install Script

Install the newest app build on a connected phone:

- Default flow (build + sync + APK install): `bun run android:upload-newest`
- Specific device: `bun run android:upload-newest -- --serial <device_id>`
- Install latest already-built APK only: `bun run android:upload-newest -- --skip-build`
