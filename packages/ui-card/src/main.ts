import { App } from '@modelcontextprotocol/ext-apps';
import { cardDataFrom, renderCard, SAMPLE } from './render';

const root = document.getElementById('card')!;

function show(structured: unknown) {
  const data = cardDataFrom(structured);
  if (data) root.innerHTML = renderCard(data);
}

if (window.parent === window) {
  // Opened directly (not inside an MCP host): show sample data so the card can be previewed.
  root.innerHTML = renderCard(SAMPLE);
} else {
  const app = new App({ name: 'care-circle-today', version: '0.1.0' }, {});
  app.ontoolresult = (params) => {
    if (!params.isError) show(params.structuredContent);
  };
  void app.connect();
}
