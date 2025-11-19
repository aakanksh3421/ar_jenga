import { defineConfig } from 'vite';
import fs from 'fs';

export default defineConfig({
  server: {
    https: {
      key: fs.readFileSync('./Keys/kronos88-privateKey.key'),
      cert: fs.readFileSync('./Keys/kronos88.crt'),
    },
  },
});
