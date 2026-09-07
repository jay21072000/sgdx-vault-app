const https = require('https');

function check(urlStr) {
  https.get(urlStr, (res) => {
    console.log('=== Checking:', urlStr, '===');
    console.log('Status:', res.statusCode);
    console.log('Cache-Control:', res.headers['cache-control']);
    console.log('Pragma:', res.headers['pragma']);
    console.log('Expires:', res.headers['expires']);
    console.log('x-vercel-cache:', res.headers['x-vercel-cache']);
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      const match = body.match(/\/assets\/app-[^"']+/);
      if (match) {
        console.log('Bundled Script Tag:', match[0]);
      }
    });
  });
}

check('https://sgdx-vault-app.vercel.app');
check('https://sgdx-vault-jig9t00js-jayhadiya002-5131s-projects.vercel.app');
