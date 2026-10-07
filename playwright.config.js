import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'off'
  },
  webServer: {
    command: 'node -e "const http = require(\'http\'), fs = require(\'fs\'), path = require(\'path\'); const m = {\'.html\':\'text/html\',\'.js\':\'application/javascript\',\'.css\':\'text/css\',\'.json\':\'application/json\',\'.svg\':\'image/svg+xml\'}; http.createServer((q,s)=>{ let p=q.url.split(\'?\')[0]; if(p===\'/\') p=\'/index.html\'; let f=path.join(__dirname, p); fs.readFile(f,(e,d)=>{ if(e){ s.writeHead(404); s.end(); } else { s.writeHead(200, {\'Content-Type\': m[path.extname(f)]||\'text/plain\'}); s.end(d); } }); }).listen(8080);"',
    port: 8080,
    reuseExistingServer: true
  }
});
