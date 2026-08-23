# Classroom Blackjack

A teacher-hosted blackjack game designed for a class of up to 40 students. Students do not create accounts or see a login screen: Firebase Anonymous Authentication signs each browser in behind the scenes.

## How it works

- The teacher creates a game and keeps the teacher tab open.
- Students open the teacher's join link, enter a name, and select a group. The link fills the six-character game code automatically.
- The visible groups are **Experienced**, **Understand the Game**, and **No Clue What I'm Doing**. Only the last group receives the in-game strategy hint button.
- The teacher's group summary displays a horizontal bar chart comparing each group's average bankroll, with exact averages and student counts.
- Students can write only a valid bet or an action request for their own player record.
- The teacher browser is the authoritative dealer. It owns the private shoe and hole card, processes student actions in batches, and settles the round.
- Firestore Security Rules prevent students from changing hands, bankroll outcomes, game state, or private dealer data.

## One-time Firebase setup

The app currently targets the Firebase project `classroom-blackjack`.

1. In Firebase Console, open **Authentication → Sign-in method** and enable **Anonymous**.
2. Install the Firebase CLI and authenticate:

   ```sh
   npm install --global firebase-tools
   firebase login
   ```

3. From this repository, deploy the checked-in rules before opening the game to students:

   ```sh
   firebase use classroom-blackjack
   firebase deploy --only firestore:rules
   ```

4. After Netlify gives you the production domain, add that hostname under **Firebase Authentication → Settings → Authorized domains**. Do not include `https://` or a path.
5. If the Firebase browser key has HTTP referrer restrictions in Google Cloud Console, add the Netlify domain there too.

The checked-in Firebase API key is an application identifier, not an authorization secret. Firestore Rules are the required security boundary.

## Automated checks

Node.js 20 or newer is recommended.

```sh
npm run check
npm test
```

The tests cover scoring, blackjack payout, the double-down bust regression, strategy hints, and a six-deck shoe large enough to deal to 40 students.

## Local browser test

Serve the repository over HTTP; ES modules do not work reliably by double-clicking `index.html`.

```sh
python3 -m http.server 8888 --directory public
```

Then visit `http://localhost:8888`.

Use one normal browser window as the teacher. Use separate browser profiles, different browsers, or different devices for students so each student receives a different anonymous Firebase identity. Multiple tabs in the same browser profile intentionally share one identity and are not a valid multi-student test.

Test this sequence before class:

1. Teacher creates a game and copies the join link.
2. At least three student profiles join different groups.
3. Teacher starts betting; students place bets.
4. Confirm the round deals automatically when everyone is ready.
5. Test hit, stand, double down, bust, blackjack, and the teacher's **Deal to ready players** fallback.
6. Refresh a student during a round, re-enter the same name/code, and confirm the hand resumes without resetting the bankroll.
7. Refresh the teacher tab, re-enter the teacher name/code, and confirm host controls return.
8. Try entering `<img src=x onerror=alert(1)>` as a student name and confirm it appears only as text.

## Netlify deployment

1. Merge the reviewed pull request to `main`.
2. In Netlify, choose **Add new project → Import an existing project → GitHub** and select this repository.
3. Use `main` as the production branch.
4. Leave the build command empty. `netlify.toml` publishes only the `public` directory.
5. Deploy, then add the resulting hostname to Firebase Authorized domains as described above.
6. Trigger one more Netlify deploy after the Firebase domain is authorized.

Verify the live response headers in browser developer tools. The deployment should include a Content Security Policy, clickjacking protection, MIME-sniffing protection, and a restrictive permissions policy from `netlify.toml`.

## Classroom dry run

Before the first 40-student class, run a 10-device dry run on the same school Wi-Fi. Keep the teacher computer awake, plugged in, and on a stable network; the teacher tab is the dealer for the session. During the real class, wait until the host panel shows all expected students before selecting **Start betting**.

For additional abuse protection without adding a visible login, enable Firebase App Check for the Netlify domain after the basic deployment is working. Test App Check in monitoring mode first, then enforce it for Firestore.
