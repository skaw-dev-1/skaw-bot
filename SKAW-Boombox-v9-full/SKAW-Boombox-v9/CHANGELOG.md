# Changelog — SKAW Boombox v9

## 9.0.0

- Rebuilt the converter runtime instead of layering fixes on v8.
- Linux libc auto-detection: glibc vs musl.
- Railway musl x64 uses `yt-dlp_musllinux`.
- glibc x64 uses `yt-dlp_linux`.
- Node 22+ enforced for current yt-dlp EJS runtime support.
- yt-dlp is SHA-256 verified against the official `SHA2-256SUMS` release file.
- The downloaded binary is self-tested with `yt-dlp --version` before use.
- Runtime cache moved to a writable temp/cache directory instead of repository `.runtime`.
- Better executable failure diagnostics.
- FFmpeg uses `ffmpeg-static`.
- Top4toP uploader dynamically discovers its upload form and validates direct HTTP MP3 output.
- Progress embed now exposes queue/metadata/download/convert/upload/done stages.
- Source-to-result history is stored for deterministic reroll/re-convert.
- `!bb` and `/bb` are limited to the configured Boombox channel.
- `/boombox-config test` now checks Node, libc, FFmpeg, yt-dlp and Top4toP form reachability.
- Installer stores backups under `/tmp` instead of creating duplicate source folders inside the repo.
