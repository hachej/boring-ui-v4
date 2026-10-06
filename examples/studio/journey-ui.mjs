// Small helpers shared by the UI journeys (chatui, menus, durability, artifacts, mobile): the History list of conversations and
// the current conversation id. Kept out of journeys/ because every file there is a journey.
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
const qa = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})]`;

export function conversations(t) {
  const { browser, logText } = t;
  const open = async () => {
    if (await browser.evaluate(`!!${q('[data-testid=conversations]')}`)) return;
    await browser.click(q('[data-testid=history-open]'));
    await browser.until('the History list is open', `!!${q('[data-testid=conversations]')}`, 5000);
  };
  const close = async () => {
    if (await browser.evaluate(`!${q('[data-testid=conversations]')}`)) return;
    await browser.press('Escape');
    await browser.until('the History list is closed', `!${q('[data-testid=conversations]')}`, 5000);
  };
  const rows = () => browser.evaluate(`${qa('[data-testid=conversation-row]')}.map(row => ({ id: row.dataset.conversationId, title: row.querySelector('span').textContent, active: row.dataset.active === 'true', time: row.lastElementChild.textContent.trim() }))`);
  return {
    open, close, rows,
    /** The id of the conversation that is open. */
    current: () => browser.evaluate(`${q('[data-testid=studio-main]')}.dataset.conversation`),
    /** How many conversations the open demo has, from the History list. */
    count: async () => { await open(); const list = await rows(); await close(); return list.length; },
    /** Start a new conversation from the History list and wait for the empty one. */
    create: async () => {
      const before = await browser.evaluate(`${q('[data-testid=studio-main]')}.dataset.conversation`);
      await open();
      await browser.click(q('[data-testid=conversation-new]'));
      await browser.until('a new, empty conversation', `${q('[data-testid=studio-main]')}.dataset.conversation !== ${JSON.stringify(before)} && ${logText}.trim() === '' && ${q('[data-testid=connection]')}?.dataset.state === 'connected'`, 20000);
    },
    /** Switch to an existing conversation by id through the History list. */
    select: async id => {
      await open();
      await browser.click(`${qa('[data-testid=conversation-row]')}.find(row => row.dataset.conversationId === ${JSON.stringify(String(id))})`);
      await browser.until('the conversation is open', `${q('[data-testid=studio-main]')}.dataset.conversation === ${JSON.stringify(String(id))} && ${q('[data-testid=connection]')}?.dataset.state === 'connected'`, 20000);
    },
  };
}
