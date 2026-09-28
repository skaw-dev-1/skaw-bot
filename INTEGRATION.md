# SKAW GROUP — TitanBot Boombox Converter Integration Pack

This is an OVERLAY/INTEGRATION PACK for the existing TitanBot/SKAW Group repository.
It is not a replacement for the full TitanBot repository.

## Included

- Auto Message v15 files (the working baseline)
- SKAW Boombox Converter command and services
- Persistent configuration/cache through TitanBot `client.db`
- Supported source detection: YouTube, TikTok, Spotify, SoundCloud
- Converter channel restriction
- Queue + per-user cooldown
- MP3 conversion with yt-dlp + ffmpeg
- Top4toP upload + HTTP direct MP3 validation
- Boombox output URL is normalized to `http://...`

## Files to add/replace

Copy the `src/` folder into the ROOT of your existing TitanBot repository and allow files to merge.
The four Auto Message v15 files are intended to replace the same files already in the SKAW bot.

## One-time integration into src/app.js and package.json

Run this from the ROOT of the TitanBot repository:

```bash
node scripts/apply-skaw-boombox-integration.mjs
npm install
```

The script safely:

1. Adds `initializeBoomboxConverter` to `src/app.js`.
2. Starts the Boombox message listener after TitanBot initializes `client.db`.
3. Adds missing npm dependencies without removing your existing dependencies.

It does not touch Giveaway code or any other commands.

## Railway

Push the merged project to the same GitHub repository used by the existing SKAW TitanBot deployment.
Keep the existing Discord/PostgreSQL variables unchanged.

The converter uses TitanBot's existing database interface, so it does NOT create a second PostgreSQL database.

The `youtube-dl-exec` package currently requires Python 3.9+ available as `python3` on the host during installation/runtime. Verify the Railway build environment provides Python before testing conversion.

## Discord configuration

After deployment:

```text
/boombox-config channel channel:#skaw-boombox
/boombox-config enable
/boombox-config status
```

Only URLs posted in the configured channel are processed.

URLs in other channels are ignored.

## Supported URLs

```text
YouTube
TikTok
Spotify
SoundCloud
```

The bot only processes recognized domains. Normal URLs are ignored.

## Important testing order

1. Start the bot and verify existing Giveaway commands.
2. Verify `/automessage` and existing Auto Message schedules still work.
3. Configure the Boombox channel.
4. Test one YouTube URL.
5. Test TikTok and SoundCloud.
6. Test a Spotify track and verify its matched source.
7. Verify the returned URL starts with `http://` and ends in `.mp3`.
8. Test that URL in the GTA SA-MP Boombox.

The Top4toP uploader is deliberately isolated in `src/services/top4topService.js` so it can be updated independently if Top4toP changes its upload response.
