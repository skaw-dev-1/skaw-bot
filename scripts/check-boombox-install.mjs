const packages = ['ffmpeg-static', 'form-data', 'yt-dlp-wrap-plus'];
let failed = false;
for (const name of packages) {
    try {
        await import(name);
        console.log(`OK  ${name}`);
    } catch (error) {
        failed = true;
        console.error(`MISS ${name}: ${error?.message || error}`);
    }
}
if (failed) {
    console.error('\nInstall with: npm install ffmpeg-static@5.3.0 yt-dlp-wrap-plus@2.5.0 form-data@4.0.4');
    process.exitCode = 1;
}
