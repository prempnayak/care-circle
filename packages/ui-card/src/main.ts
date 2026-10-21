import { App } from '@modelcontextprotocol/ext-apps';
import { cardDataFrom, renderCard, SAMPLE, withLogged, type CardData } from './render';

const root = document.getElementById('card')!;
let current: CardData | null = null;

function show(data: CardData, said?: string) {
  current = data;
  root.innerHTML = renderCard(data);
  if (said) root.querySelector('.said')!.textContent = said;
}

if (window.parent === window) {
  // Opened directly (not inside an MCP host): show sample data so the card can be previewed.
  show(SAMPLE);
} else {
  const app = new App({ name: 'care-circle-today', version: '0.1.0' }, {});
  app.ontoolresult = (params) => {
    const data = params.isError ? null : cardDataFrom(params.structuredContent);
    if (data) show(data);
  };

  // Tap-to-log: the same log_dose tool the voice command uses, through the host.
  root.addEventListener('click', async (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button.log');
    const doseId = button?.dataset.doseId;
    if (!button || !doseId || !current) return;
    button.disabled = true;
    button.textContent = 'Logging…';
    try {
      const result = await app.callServerTool({ name: 'log_dose', arguments: { dose_id: doseId, status: 'taken' } });
      const speech = (result.content?.[0] as { text?: string } | undefined)?.text ?? '';
      if (result.isError) {
        show(current, speech || "That didn't work. Try saying it instead.");
      } else {
        show(withLogged(current, doseId), speech);
      }
    } catch {
      show(current, "That didn't work. Try saying it instead.");
    }
  });

  void app.connect();
}
