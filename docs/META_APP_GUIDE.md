# Meta (developers.facebook.com) app: setup, publish, aur suspension se bachna

## 1. App suspend kyun hota hai (sabse common wajah)
Koi bhi tool 100% guarantee nahi de sakta; Meta khud decide karta hai. Lekin ye cheezein sabse zyada suspension/restriction karwati hain:

1. **Unofficial login** (session ID / password / instagrapi) ek hi account ke saath official app ke saath mix hona. -> Ab code se hata diya gaya hai.
2. **Placeholder / kaam na karne wale URLs**: privacy policy, data deletion, deauthorize callback. -> Ab real pages hain (neeche URLs).
3. **`SUPPORT_EMAIL` set na hona** (privacy page par `support@example.com` ya khali contact).
4. **Spam jaisa behaviour**: roz bahut zyada posts, ek hi caption/cover sab par, same video do jagah, saare posts ek hi minute par. -> Ab: default 5 posts/din/account, caption spintax `{A|B|C}`, random jitter, same video ek din mein ek hi baar, Meta ka `content_publishing_limit` check.
5. **Bahut saare alag accounts** connect karna jo aapke apne nahi / app ke Tester nahi. -> Ab max 5 accounts per user (env se badal sakte ho).
6. **Baar-baar naya app banana** ya ek hi Meta Business par kai apps suspend hona. Naya app mat banao; suspended app ki appeal karo (Section 5).
7. **App Review ke bina Live karna** / Development mode mein non-tester accounts se use.
8. Tokens leak hona ya app secret ka public hona (kabhi GitHub par `.env` push mat karo; secret leak ho to Reset karo).

## 2. Meta app settings (ek baar)
Dashboard -> Use case: **"Manage messaging & content on Instagram"** -> **API setup with Instagram login**.

| Setting | Value |
|---|---|
| Valid OAuth Redirect URIs | `https://<your-domain>/api/instagram/callback` |
| Deauthorize callback URL | `https://<your-domain>/api/meta/deauthorize` |
| Data deletion request URL | `https://<your-domain>/api/meta/data-deletion` |
| Privacy Policy URL | `https://<your-domain>/privacy` |
| Terms of Service URL | `https://<your-domain>/terms` |
| User data deletion instructions (agar URL ki jagah maange) | `https://<your-domain>/data-deletion` |
| App icon, Category, Contact email | App Settings -> Basic (icon 1024x1024 zaroor) |

`<your-domain>` = `APP_BASE_URL` (Koyeb URL ya apna custom domain). Custom domain better hai (reviewers ko zyada trustworthy lagta hai).

Env vars: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (Instagram app ID/secret, Facebook app ID nahi), `SUPPORT_EMAIL`, `APP_BASE_URL`.

## 3. Development mode mein test
App Roles -> Roles -> **Instagram Testers** -> apna professional (Business/Creator) account add karo -> Instagram app mein Settings -> Apps and websites -> Tester invites -> Accept. Phir app mein Connect Instagram.

## 4. Publish (Live) karna: App Review
1. **Business Verification** (Settings -> Business settings -> Security centre). Advanced Access ke liye zaroori.
2. App Review -> Permissions and features me request karo (sirf ye 2):
   - `instagram_business_basic`
   - `instagram_business_content_publish`
3. Har permission ke liye:
   - Use case ka saaf description: "User apni Business/Creator Instagram account connect karta hai aur apni videos ke Reels schedule karta hai."
   - **Screencast** (2-3 min): login -> Connect Instagram -> permission screen -> video add -> plan set -> Reel publish hota dikhao -> Instagram profile par Reel dikhao -> Disconnect.
   - Test credentials: reviewer ke liye ek test login (email + password) aur ek test Instagram account jise Tester banaya ho. Review notes mein likho.
4. Review pass hone ke baad Settings -> Basic -> **App mode: Live**.
5. Review ke dauran app ko Live/Dev dono mein mat chedo, URLs mat badlo.

## 5. Agar app abhi suspended hai
1. developers.facebook.com -> My Apps -> app -> **Alerts / App Dashboard banner** padho. Wahan violation ka naam aur "Request review / Appeal" button hota hai.
2. Pehle ye project deploy karo (session-ID hata hua, real pages, SUPPORT_EMAIL set), phir appeal mein likho kya fix kiya:
   - unofficial login removed, sirf official Instagram Login
   - privacy/terms/data-deletion/deauthorize live aur kaam karte hain
   - daily limit, spam controls
3. Appeal ek hi baar bhejo (baar baar bhejne se delay hota hai). Support: Meta Business Support (business.facebook.com/business-support-home).
4. Naye app ya naye Facebook account se bypass karne ki koshish mat karo; ye Platform Terms ke against hai aur sab kuch ban karwa sakta hai.

## 6. Roz ke safe rules
- Sirf apne (ya jin logon ne permission di) accounts connect karo.
- 3-5 reels/din/account, alag alag captions (`{A|B|C}`), unique videos.
- Naya account ek din mein 1-2 post se shuru karo, dheere badhao.
- App secret kabhi share mat karo. Leak ho to Meta dashboard mein Reset karo aur Koyeb env update karo.
