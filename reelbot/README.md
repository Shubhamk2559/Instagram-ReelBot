# reelbot (unofficial, instagrapi)

Standalone Python tool, separate from the Node app. Does not need a Meta developer app.
Runs on your PC / VPS / Termux, not on the Koyeb web service.

    cd reelbot
    pip install -r requirements.txt
    cp accounts.example.json accounts.json     # edit username, captions, windows
    export IG_PASS_ACC1='password'             # account name in UPPERCASE
    python reel_bot.py login
    python reel_bot.py once acc1 --dry-run
    python reel_bot.py run

Videos: `videos/<account>/` (moved to `done/` after posting) or `videos/shared/` (each account posts it once).
Termux: `pkg install python ffmpeg python-pillow python-numpy`, then `pip install instagrapi "moviepy<2"`.

Never commit `accounts.json`, `data/` (login sessions) or videos. They are in .gitignore.
