// WebGen-Bench 000024 — customer support chatbot. One check per ui_instruct case.
// The chat interface is the conversation page: the visitor types a message, the
// reply is linked by the Message.created event and shown in the same row.
import { colorCheck } from '../../verify/lib.mjs';

const CHAT = '/Chat/1';
// The row whose first cell is exactly the typed text (replies quote other questions).
const turn = (rows, text) => rows.find((r) => r.startsWith(`<td>${text}</td>`));
const ask = async ({ follow, rows, must, flashOf }, text) => {
  const page = await follow(`${CHAT}/add/Message`, { text });
  must(/Message sent/.test(flashOf(page.html)), `no confirmation after sending: ${flashOf(page.html)}`);
  const row = turn(rows(page.html), text);
  must(row, `the typed message "${text}" is not in the conversation`);
  const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  return { page, row, reply: cells[1] };
};

export const checks = [
  { task: 'Typing "What are your frequently asked questions?" gets the list of FAQs back at once',
    run: async (ctx) => {
      const { get, must } = ctx;
      const home = await get('/');
      must(home.status === 200 && /<h2>Support chat<\/h2>/.test(home.html) && /name="text"/.test(home.html) && /<button type="submit">Send<\/button>/.test(home.html), 'the chat interface is not on the home page');
      const { reply, page } = await ask(ctx, 'What are your frequently asked questions?');
      must(/^Here are our frequently asked questions:/.test(reply), `the reply is not the FAQ list: ${reply}`);
      for (const q of ['How can I return a product?', 'I need help with placing an order', 'What products do you sell?', 'How long does delivery take?', 'What payment methods do you accept?'])
        must(reply.includes(q), `the FAQ list lacks "${q}"`);
      must(/<th>Messages<\/th><td>1<\/td>/.test(page.html), 'the conversation does not count the message');
      return 'FAQ list of 5 questions returned in the same request';
    } },
  { task: 'Typing "I need help with placing an order" gets step-by-step guidance, and the steps lead to a placed order',
    run: async (ctx) => {
      const { get, post, follow, rowWith, must, flashOf } = ctx;
      const { reply } = await ask(ctx, 'I need help with placing an order');
      must(/^Happy to help you place an order: 1\) open Products/.test(reply) && /2\) open Orders/.test(reply) && /4\) press Place order/.test(reply), `the reply does not guide through ordering: ${reply}`);
      const products = await get('/Product');
      must(rowWith(products.html, 'Smart kettle') && /89\.00/.test(products.html), 'the Products page the bot points at is empty');
      const bad = await post('/Order', { product: 2, qty: 0, customer: 'Ann' });
      must(bad.status === 400 && /Quantity must be at least 1/.test(bad.html), 'an order with quantity 0 was accepted');
      const placed = await follow('/Order', { product: 2, qty: 2, customer: 'Ann' });
      must(/Order placed successfully/.test(flashOf(placed.html)), `no confirmation after ordering: ${flashOf(placed.html)}`);
      const row = rowWith(placed.html, 'Ann');
      must(row && /Smart kettle/.test(row) && /<td>2<\/td>/.test(row) && /178\.00/.test(row), `the order row is wrong: ${row}`);
      return 'four-step guidance; following it places an order with a derived total of 178.00';
    } },
  { task: 'Typing "How can I return a product?" gets the return procedure',
    run: async (ctx) => {
      const { must } = ctx;
      const { reply } = await ask(ctx, 'How can I return a product?');
      must(/^To return a product: 1\)/.test(reply) && /30 days/.test(reply) && /prepaid label/.test(reply) && /refund/.test(reply), `the reply is not the return procedure: ${reply}`);
      return 'return procedure with the 30-day window, label and refund';
    } },
  { task: 'A nonsensical "asdfghjkl" gets a polite "not understood" and an invitation to rephrase',
    run: async (ctx) => {
      const { get, must } = ctx;
      const { reply, page } = await ask(ctx, 'asdfghjkl');
      must(reply === 'Sorry, I did not understand that. Could you rephrase or ask another question?', `unexpected reply: ${reply}`);
      must(/<th>Messages<\/th><td>4<\/td>/.test(page.html), 'the conversation does not hold all four turns');
      const faq = await get('/Answer?q=asdfghjkl');
      must(/0 item\(s\)/.test(faq.html), 'the knowledge base matches the nonsense');
      return 'fallback reply; conversation holds 4 turns';
    } },
  colorCheck('snow', 'dimgray'),
];
