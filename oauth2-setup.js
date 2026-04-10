/**
 * Run this ONCE on your computer to get YouTube OAuth2 tokens.
 * Tokens are permanent (auto-refresh) — no more expired cookies!
 *
 * Usage:
 *   node oauth2-setup.js
 */

const { Innertube } = require('youtubei.js');

(async () => {
  console.log('=== Sonara YouTube OAuth2 Setup ===\n');
  const yt = await Innertube.create({ generate_session_locally: true });

  yt.session.on('auth-pending', (data) => {
    console.log('Step 1 — Open this URL in your browser:');
    console.log(`  ${data.verification_url}\n`);
    console.log('Step 2 — Enter this code when asked:');
    console.log(`  ${data.user_code}\n`);
    console.log('Waiting for you to authorize...');
  });

  yt.session.on('auth', ({ credentials }) => {
    const encoded = Buffer.from(JSON.stringify(credentials)).toString('base64');
    console.log('\n✅ Success! Copy the value below and set it as YOUTUBE_OAUTH_TOKENS on Render:\n');
    console.log('━'.repeat(60));
    console.log(encoded);
    console.log('━'.repeat(60));
    console.log('\nOn Render: Dashboard → Your Service → Environment → Add variable');
    console.log('  Name:  YOUTUBE_OAUTH_TOKENS');
    console.log('  Value: (paste the long string above)');
    console.log('\nThen click Save — Render will redeploy automatically.');
    process.exit(0);
  });

  yt.session.on('auth-error', (err) => {
    console.error('\n❌ Auth error:', err.message || err);
    process.exit(1);
  });

  await yt.session.signIn();
})();
