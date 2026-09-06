import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config);

app.listen(config.API_PORT, config.API_HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`networth-tracker api listening on http://${config.API_HOST}:${config.API_PORT}`);
});
